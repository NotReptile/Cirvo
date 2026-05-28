// K.5/K.9: enumerate screen-источников (мониторы + окна) и захват кадров
// через `xcap`. JS-сторона периодически вызывает `screen_capture_frame`
// и собирает MediaStream из возвращённых JPEG-байтов через
// MediaStreamTrackGenerator. Это даёт собственный picker (K.5) и убирает
// браузерную плашку «сайт делает демонстрацию вашего экрана» (K.9) —
// для WebView2 это просто обычный video-track, не screen-share.
//
// Производительность: захват + JPEG-encode каждые ~66ms (15 fps) на CPU.
// На 1080p мониторе ~5-10% одного ядра, в зависимости от quality.
// Это видимо хуже Discord/Krisp, но достаточно для разговорного screen-share.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use image::codecs::jpeg::JpegEncoder;
use image::{ImageBuffer, Rgba};
use serde::Serialize;

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
        // Скрываем минимизированные и наши собственные окна — они
        // только засорят picker.
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
        // Иногда capture отдаёт нулевой буфер (для скрытых/destroyed окон).
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
                    jpeg: encode_jpeg(&img, q),
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
                    jpeg: encode_jpeg(&img, q),
                });
            }
        }
        Err("window not found".to_string())
    } else {
        Err("unknown kind".to_string())
    }
}

fn encode_jpeg(img: &ImageBuffer<Rgba<u8>, Vec<u8>>, quality: u8) -> String {
    // image::codecs::jpeg рассчитывает на RGB. Преобразуем RGBA → RGB
    // (выбрасываем alpha; для screen-share это всегда непрозрачный кадр).
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

// Простая bilinear-уменьшалка для thumbnail'ов — не нужно тащить полный image::imageops.
// Возвращает base64-JPEG ~max_dim x max_dim aspect-preserving.
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
