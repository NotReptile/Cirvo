// K.5/K.9: enumerate screen-источников (мониторы + окна) и захват кадров
// через `xcap`. JS-сторона периодически вызывает `screen_capture_frame`
// и собирает MediaStream из возвращённых JPEG-байтов через
// MediaStreamTrackGenerator. Это даёт собственный picker (K.5) и убирает
// браузерную плашку «сайт делает демонстрацию вашего экрана» (K.9) —
// для WebView2 это просто обычный video-track, не screen-share.
//
// K.5(b) — background-thread caching pipeline. Раньше каждый JS-invoke
// делал свежий xcap::Monitor::all() + capture_image() + JPEG-encode
// синхронно в потоке invoke-handler'а: ~50-80мс per frame на 1080p,
// блокировал invoke-thread, и Monitor::all() сканирует все мониторы
// заново при каждом запросе. Теперь старт capture-сессии (`ensure_session`)
// запускает выделенный поток, который захватывает + JPEG-encode'ит
// кадры в `Mutex<Option<CachedFrame>>`. JS-invoke просто читает кэш —
// мгновенно. Сессия живёт пока есть активность (last_read обновляется
// при каждом screen_capture_frame); после 5s простоя поток сам выходит,
// освобождая монитор.
//
// xcap на Windows внутри использует DXGI Desktop Duplication — это уже
// GPU-accelerated capture. То что мы хотели от K.5(b) hw-accel:
// (1) не дёргать capture per JS-frame, (2) не блокировать invoke-thread.
// Обе цели закрыты этой архитектурой. Полная замена на windows-capture
// crate (raw WGC API) могла бы дать ещё выигрыш на GPU-side encoding,
// но требует отдельной интеграции — оставлено как возможный шаг.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use image::codecs::jpeg::JpegEncoder;
use image::{ImageBuffer, Rgba};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
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

#[derive(Serialize)]
pub struct CapturedFrame {
    pub width: u32,
    pub height: u32,
    pub jpeg: String, // base64
}

#[derive(Clone)]
struct CachedFrame {
    width: u32,
    height: u32,
    jpeg: String,
}

struct Session {
    stop: Arc<AtomicBool>,
    latest: Arc<Mutex<Option<CachedFrame>>>,
    last_read: Arc<Mutex<Instant>>,
    quality: Arc<Mutex<u8>>,
}

// Глобальный реестр живых capture-сессий. Ключ — `monitor:<id>` / `window:<id>`.
// OnceLock ленивая инициализация, потокобезопасная.
fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(5);
const CAPTURE_INTERVAL: Duration = Duration::from_millis(66); // ~15 fps

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

#[tauri::command]
pub fn screen_capture_frame(id: String, quality: Option<u8>) -> Result<CapturedFrame, String> {
    let q = quality.unwrap_or(70).clamp(20, 95);

    // Если сессии нет — стартуем фоном и параллельно делаем синхронный кадр,
    // чтобы caller сразу получил что-то отрисовать (иначе придётся ждать
    // первый tick capture-thread'а ~66мс).
    ensure_session(&id, q)?;

    // Обновим last_read под session-lock; quality тоже передадим — поток
    // подберёт новое значение на следующем tick'е.
    {
        let map = sessions().lock().map_err(|_| "session lock poisoned".to_string())?;
        if let Some(s) = map.get(&id) {
            if let Ok(mut t) = s.last_read.lock() {
                *t = Instant::now();
            }
            if let Ok(mut qg) = s.quality.lock() {
                *qg = q;
            }
            if let Ok(latest) = s.latest.lock() {
                if let Some(f) = latest.as_ref() {
                    return Ok(CapturedFrame {
                        width: f.width,
                        height: f.height,
                        jpeg: f.jpeg.clone(),
                    });
                }
            }
        }
    }

    // Кэш ещё пуст (поток не успел отдать первый кадр) — делаем синхронный
    // capture как fallback. На холодном старте gives caller что-то показать
    // моментально.
    capture_once(&id, q)
}

fn ensure_session(id: &str, quality: u8) -> Result<(), String> {
    let mut map = sessions().lock().map_err(|_| "session lock poisoned".to_string())?;
    if map.contains_key(id) {
        return Ok(());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let latest = Arc::new(Mutex::new(None::<CachedFrame>));
    let last_read = Arc::new(Mutex::new(Instant::now()));
    let q_holder = Arc::new(Mutex::new(quality));

    let id_owned = id.to_string();
    let stop_t = stop.clone();
    let latest_t = latest.clone();
    let last_read_t = last_read.clone();
    let q_holder_t = q_holder.clone();

    std::thread::spawn(move || {
        capture_loop(id_owned, stop_t, latest_t, last_read_t, q_holder_t);
    });

    map.insert(
        id.to_string(),
        Session {
            stop,
            latest,
            last_read,
            quality: q_holder,
        },
    );
    Ok(())
}

fn capture_loop(
    id: String,
    stop: Arc<AtomicBool>,
    latest: Arc<Mutex<Option<CachedFrame>>>,
    last_read: Arc<Mutex<Instant>>,
    quality: Arc<Mutex<u8>>,
) {
    while !stop.load(Ordering::Relaxed) {
        // Idle-timeout: если давно никто не читал — выходим.
        if let Ok(t) = last_read.lock() {
            if t.elapsed() > SESSION_IDLE_TIMEOUT {
                drop(t);
                break;
            }
        }
        let q = quality.lock().map(|g| *g).unwrap_or(70);
        match capture_once(&id, q) {
            Ok(frame) => {
                if let Ok(mut slot) = latest.lock() {
                    *slot = Some(CachedFrame {
                        width: frame.width,
                        height: frame.height,
                        jpeg: frame.jpeg,
                    });
                }
            }
            Err(_) => {
                // Окно/монитор пропали — выходим, освобождаем слот.
                break;
            }
        }
        std::thread::sleep(CAPTURE_INTERVAL);
    }
    // Удаляем себя из реестра. Snipe-condition с ensure_session защищена
    // через map-lock: если кто-то параллельно зашёл и нашёл нашу запись —
    // он обновит last_read и решит, что мы живы; но мы выйдем. Тогда при
    // следующем screen_capture_frame ensure_session создаст новую сессию.
    if let Ok(mut map) = sessions().lock() {
        map.remove(&id);
    }
}

fn capture_once(id: &str, quality: u8) -> Result<CapturedFrame, String> {
    let (kind, raw_id) = id.split_once(':').ok_or_else(|| "invalid id".to_string())?;
    if kind == "monitor" {
        let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
        for m in monitors.iter() {
            if m.id().to_string() == raw_id {
                let img = m.capture_image().map_err(|e| e.to_string())?;
                let (w, h) = (img.width(), img.height());
                return Ok(CapturedFrame {
                    width: w,
                    height: h,
                    jpeg: encode_jpeg(&img, quality),
                });
            }
        }
        Err("monitor not found".to_string())
    } else if kind == "window" {
        let windows = xcap::Window::all().map_err(|e| e.to_string())?;
        for w in windows.iter() {
            if w.id().to_string() == raw_id {
                let img = w.capture_image().map_err(|e| e.to_string())?;
                let (ww, hh) = (img.width(), img.height());
                if ww == 0 || hh == 0 {
                    return Err("window capture returned empty buffer".to_string());
                }
                return Ok(CapturedFrame {
                    width: ww,
                    height: hh,
                    jpeg: encode_jpeg(&img, quality),
                });
            }
        }
        Err("window not found".to_string())
    } else {
        Err("unknown kind".to_string())
    }
}

// Явная остановка всех сессий. Зовётся при выходе пользователя из звонка
// или при unload'е — чтобы capture-потоки не висели лишние 5 секунд.
#[tauri::command]
pub fn screen_capture_stop_all() -> Result<(), String> {
    if let Ok(map) = sessions().lock() {
        for s in map.values() {
            s.stop.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

fn encode_jpeg(img: &ImageBuffer<Rgba<u8>, Vec<u8>>, quality: u8) -> String {
    let (w, h) = (img.width(), img.height());
    let mut rgb = Vec::with_capacity((w as usize) * (h as usize) * 3);
    for px in img.pixels() {
        rgb.push(px[0]);
        rgb.push(px[1]);
        rgb.push(px[2]);
    }
    let mut out = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut out, quality);
    if encoder
        .encode(&rgb, w, h, image::ExtendedColorType::Rgb8)
        .is_err()
    {
        return String::new();
    }
    B64.encode(&out)
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
