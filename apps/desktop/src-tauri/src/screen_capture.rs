// K.5/K.9: enumerate screen-источников (мониторы + окна) и захват кадров
// через `xcap`. JS-сторона вызывает `screen_capture_frame` и собирает
// MediaStream из возвращённых JPEG-байтов через MediaStreamTrackGenerator.
// Это даёт собственный picker (K.5) и убирает браузерную плашку «сайт делает
// демонстрацию вашего экрана» (K.9).
//
// Устройство (после оптимизации плавности):
//  * Старт сессии запускает выделенный поток: он один раз находит источник
//    (раньше `Monitor::all()` / `Window::all()` сканировались на КАЖДЫЙ кадр),
//    захватывает, кодирует JPEG и кладёт последний кадр в слот с номером.
//  * Поток выдерживает целевой FPS по дедлайну: время захвата и кодирования
//    вычитается из паузы, а не прибавляется к ней (раньше фактический FPS был
//    заметно ниже 15 и не зависел от выбранного пресета).
//  * `screen_capture_frame` ждёт на Condvar следующий кадр (не отдаёт один и
//    тот же кадр дважды) и возвращает сырые JPEG-байты бинарным ответом IPC:
//    без base64 (+33% объёма) и без разбора JSON на стороне WebView.
//  * Сессия живёт, пока есть чтение; после 5 с простоя поток выходит.
//
// Потолок производительности этого пути — CPU-кодирование JPEG и копирование
// через IPC; для настоящих 60 FPS клиент использует getDisplayMedia (см.
// screenSharePicker.ts), а этот путь остаётся совместимым вариантом.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use image::codecs::jpeg::JpegEncoder;
use image::{ImageBuffer, Rgba};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Serialize)]
pub struct SourceInfo {
    pub id: String,
    pub name: String,
    pub kind: String, // "screen" | "window"
    pub width: u32,
    pub height: u32,
    pub thumbnail: String, // base64 JPEG, ~320px
}

// Последний готовый кадр: монотонный номер + JPEG-байты.
struct FrameSlot {
    seq: u64,
    jpeg: Arc<Vec<u8>>,
}

struct Shared {
    frame: Mutex<Option<FrameSlot>>,
    ready: Condvar,
}

struct Session {
    stop: Arc<AtomicBool>,
    // Поток завершился (окно закрыли, монитор пропал) — читателю вернётся
    // ошибка, а не бесконечные пустые ответы.
    dead: Arc<AtomicBool>,
    shared: Arc<Shared>,
    last_read: Arc<Mutex<Instant>>,
    quality: Arc<AtomicU8>,
    fps: Arc<AtomicU32>,
    served_seq: AtomicU64,
}

// Глобальный реестр живых capture-сессий. Ключ — `monitor:<id>` / `window:<id>`.
fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(5);
// Сколько вызов `screen_capture_frame` ждёт новый кадр, прежде чем вернуть
// пустой ответ (JS просто повторит запрос; нужно, чтобы остановка не висела).
const FRAME_WAIT: Duration = Duration::from_millis(250);

enum Source {
    Monitor(xcap::Monitor),
    Window(xcap::Window),
}

impl Source {
    fn resolve(id: &str) -> Result<Source, String> {
        let (kind, raw_id) = id.split_once(':').ok_or_else(|| "invalid id".to_string())?;
        match kind {
            "monitor" => xcap::Monitor::all()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|m| m.id().to_string() == raw_id)
                .map(Source::Monitor)
                .ok_or_else(|| "monitor not found".to_string()),
            "window" => xcap::Window::all()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|w| w.id().to_string() == raw_id)
                .map(Source::Window)
                .ok_or_else(|| "window not found".to_string()),
            _ => Err("unknown kind".to_string()),
        }
    }

    fn capture(&self) -> Result<ImageBuffer<Rgba<u8>, Vec<u8>>, String> {
        let img = match self {
            Source::Monitor(m) => m.capture_image(),
            Source::Window(w) => w.capture_image(),
        }
        .map_err(|e| e.to_string())?;
        if img.width() == 0 || img.height() == 0 {
            return Err("capture returned empty buffer".to_string());
        }
        Ok(img)
    }
}

#[tauri::command]
pub fn screen_list_sources() -> Result<Vec<SourceInfo>, String> {
    let mut out = Vec::new();

    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    for m in monitors.iter() {
        let img = match m.capture_image() {
            Ok(i) => i,
            Err(_) => continue,
        };
        let (w, h) = (img.width(), img.height());
        let thumb = encode_jpeg_scaled(&img, 320, 60);
        out.push(SourceInfo {
            id: format!("monitor:{}", m.id()),
            name: format!("Экран {}", m.name()),
            kind: "screen".to_string(),
            width: w,
            height: h,
            thumbnail: thumb,
        });
    }

    let windows = xcap::Window::all().map_err(|e| e.to_string())?;
    for w in windows.iter() {
        if w.is_minimized() {
            continue;
        }
        let title = w.title();
        if title.is_empty() {
            continue;
        }
        let img = match w.capture_image() {
            Ok(i) => i,
            Err(_) => continue,
        };
        let (ww, hh) = (img.width(), img.height());
        if ww == 0 || hh == 0 {
            continue;
        }
        let thumb = encode_jpeg_scaled(&img, 320, 60);
        out.push(SourceInfo {
            id: format!("window:{}", w.id()),
            name: title.to_string(),
            kind: "window".to_string(),
            width: ww,
            height: hh,
            thumbnail: thumb,
        });
    }
    Ok(out)
}

// Возвращает сырые JPEG-байты (ArrayBuffer на стороне JS). Пустой ответ
// означает «нового кадра пока нет» — вызывающий просто повторяет запрос.
// Команда асинхронная и ждёт в blocking-пуле, чтобы не занимать главный
// поток окна.
#[tauri::command]
pub async fn screen_capture_frame(
    id: String,
    quality: Option<u8>,
    fps: Option<u32>,
) -> Result<tauri::ipc::Response, String> {
    let q = quality.unwrap_or(70).clamp(20, 95);
    let fps = fps.unwrap_or(15).clamp(1, 60);
    let bytes = tauri::async_runtime::spawn_blocking(move || next_frame(&id, q, fps))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

fn next_frame(id: &str, quality: u8, fps: u32) -> Result<Vec<u8>, String> {
    let session = ensure_session(id, quality, fps)?;
    if let Ok(mut t) = session.last_read.lock() {
        *t = Instant::now();
    }
    // Качество и FPS подхватываются потоком на следующем кадре.
    session.quality.store(quality, Ordering::Relaxed);
    session.fps.store(fps, Ordering::Relaxed);

    let served = session.served_seq.load(Ordering::Relaxed);
    let mut guard = session
        .shared
        .frame
        .lock()
        .map_err(|_| "frame lock poisoned".to_string())?;
    let deadline = Instant::now() + FRAME_WAIT;
    loop {
        if let Some(slot) = guard.as_ref() {
            if slot.seq > served {
                session.served_seq.store(slot.seq, Ordering::Relaxed);
                return Ok(slot.jpeg.as_ref().clone());
            }
        }
        if session.dead.load(Ordering::Relaxed) {
            return Err("capture source is gone".to_string());
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok(Vec::new());
        }
        let (g, _) = session
            .shared
            .ready
            .wait_timeout(guard, deadline - now)
            .map_err(|_| "frame lock poisoned".to_string())?;
        guard = g;
    }
}

fn ensure_session(id: &str, quality: u8, fps: u32) -> Result<Arc<Session>, String> {
    let mut map = sessions()
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;
    if let Some(s) = map.get(id) {
        // Мёртвую сессию (источник пропал) не переиспользуем: пусть следующий
        // вызов честно попробует найти источник заново.
        if !s.dead.load(Ordering::Relaxed) && !s.stop.load(Ordering::Relaxed) {
            return Ok(s.clone());
        }
        map.remove(id);
    }
    let session = Arc::new(Session {
        stop: Arc::new(AtomicBool::new(false)),
        dead: Arc::new(AtomicBool::new(false)),
        shared: Arc::new(Shared {
            frame: Mutex::new(None),
            ready: Condvar::new(),
        }),
        last_read: Arc::new(Mutex::new(Instant::now())),
        quality: Arc::new(AtomicU8::new(quality)),
        fps: Arc::new(AtomicU32::new(fps)),
        served_seq: AtomicU64::new(0),
    });
    let worker = session.clone();
    let id_owned = id.to_string();
    std::thread::spawn(move || {
        capture_loop(&id_owned, &worker);
        worker.dead.store(true, Ordering::Relaxed);
        // Разбудить читателя, чтобы он увидел `dead`.
        worker.shared.ready.notify_all();
        if let Ok(mut map) = sessions().lock() {
            if map.get(&id_owned).map(|s| Arc::ptr_eq(s, &worker)).unwrap_or(false) {
                map.remove(&id_owned);
            }
        }
    });
    map.insert(id.to_string(), session.clone());
    Ok(session)
}

fn capture_loop(id: &str, session: &Session) {
    let mut source = match Source::resolve(id) {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut seq: u64 = 0;
    let mut failures = 0u32;
    while !session.stop.load(Ordering::Relaxed) {
        if let Ok(t) = session.last_read.lock() {
            if t.elapsed() > SESSION_IDLE_TIMEOUT {
                break;
            }
        }
        let started = Instant::now();
        let fps = session.fps.load(Ordering::Relaxed).clamp(1, 60);
        let quality = session.quality.load(Ordering::Relaxed);
        match source.capture() {
            Ok(img) => {
                failures = 0;
                let jpeg = encode_jpeg_bytes(&img, quality);
                if !jpeg.is_empty() {
                    seq += 1;
                    if let Ok(mut slot) = session.shared.frame.lock() {
                        *slot = Some(FrameSlot {
                            seq,
                            jpeg: Arc::new(jpeg),
                        });
                    }
                    session.shared.ready.notify_all();
                }
            }
            Err(_) => {
                // Дескриптор мог устареть (смена режима экрана, окно пересоздано):
                // пробуем найти источник заново, и только после нескольких
                // неудач считаем, что он пропал.
                failures += 1;
                if failures > 5 {
                    break;
                }
                match Source::resolve(id) {
                    Ok(s) => source = s,
                    Err(_) => break,
                }
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
        }
        // Дедлайн-пейсинг: из паузы вычитаем время, потраченное на кадр.
        let interval = Duration::from_micros(1_000_000 / fps as u64);
        let spent = started.elapsed();
        if spent < interval {
            std::thread::sleep(interval - spent);
        }
    }
}

// Явная остановка всех сессий. Зовётся при выходе пользователя из звонка
// или при unload'е — чтобы capture-потоки не висели лишние 5 секунд.
#[tauri::command]
pub fn screen_capture_stop_all() -> Result<(), String> {
    if let Ok(map) = sessions().lock() {
        for s in map.values() {
            s.stop.store(true, Ordering::Relaxed);
            s.shared.ready.notify_all();
        }
    }
    Ok(())
}

// JPEG-энкодер image не принимает Rgba8, поэтому альфа отбрасывается
// явно. Буфер заранее выделяется под нужный размер и заполняется
// одним проходом по пикселям (без push по байту).
fn encode_jpeg_bytes(img: &ImageBuffer<Rgba<u8>, Vec<u8>>, quality: u8) -> Vec<u8> {
    let (w, h) = (img.width(), img.height());
    let mut rgb = Vec::with_capacity((w as usize) * (h as usize) * 3);
    for px in img.as_raw().chunks_exact(4) {
        rgb.extend_from_slice(&px[..3]);
    }
    let mut out = Vec::with_capacity((w as usize) * (h as usize) / 8);
    let mut encoder = JpegEncoder::new_with_quality(&mut out, quality);
    if encoder
        .encode(&rgb, w, h, image::ExtendedColorType::Rgb8)
        .is_err()
    {
        return Vec::new();
    }
    out
}

fn encode_jpeg(img: &ImageBuffer<Rgba<u8>, Vec<u8>>, quality: u8) -> String {
    B64.encode(encode_jpeg_bytes(img, quality))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_rgba_to_valid_jpeg() {
        let img = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_pixel(64, 48, Rgba([10, 200, 30, 255]));
        let jpeg = encode_jpeg_bytes(&img, 70);
        assert!(jpeg.len() > 100);
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "JPEG должен начинаться с SOI");
        let decoded = image::load_from_memory_with_format(&jpeg, image::ImageFormat::Jpeg);
        assert!(decoded.is_ok());
    }
}

// Простая bilinear-уменьшалка для thumbnail'ов. Возвращает base64-JPEG ~max_dim x max_dim aspect-preserving.
fn encode_jpeg_scaled(img: &ImageBuffer<Rgba<u8>, Vec<u8>>, max_dim: u32, quality: u8) -> String {
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return String::new();
    }
    if w <= max_dim && h <= max_dim {
        return encode_jpeg(img, quality);
    }
    let scale = (max_dim as f32 / w.max(h) as f32).min(1.0);
    let new_w = (w as f32 * scale) as u32;
    let new_h = (h as f32 * scale) as u32;
    let mut scaled = ImageBuffer::<Rgba<u8>, Vec<u8>>::new(new_w.max(1), new_h.max(1));
    for y in 0..new_h {
        for x in 0..new_w {
            let src_x = (x as f32 / scale) as u32;
            let src_y = (y as f32 / scale) as u32;
            let px = img.get_pixel(src_x.min(w - 1), src_y.min(h - 1));
            scaled.put_pixel(x, y, *px);
        }
    }
    encode_jpeg(&scaled, quality)
}
