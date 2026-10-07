// K.5(c): захват системного звука через WASAPI loopback (cpal).
// На Windows cpal'овский WASAPI backend умеет открывать output-device
// в loopback-режиме через `build_input_stream` — получается тот же звук,
// который слышит пользователь, как input. Это даёт screen-share с
// системным аудио (Discord-like). Микрофон при этом не трогаем — он
// остаётся отдельным WebRTC-track'ом, peer-connection микширует.
//
// Pipeline: tauri command `screen_audio_start` запускает выделенный поток,
// который строит cpal::Stream + парк'ит до stop-флага. Callback внутри
// cpal-потока эмитит base64-encoded f32 LE PCM кадры через tauri-event
// `screen-audio:pcm`. JS-сторона создаёт MediaStreamTrackGenerator({kind:
// "audio"}) и пишет AudioData с этими сэмплами.
//
// cpal::Stream не Send/Sync на Windows (COM-affinity), поэтому держим его
// в потоке-владельце вместо глобального Mutex.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Serialize, Deserialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct AudioStartInfo {
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Serialize, Deserialize, Clone)]
struct PcmPayload {
    // base64-encoded interleaved f32 LE samples
    pcm: String,
    // в µs, для timestamp'а AudioData
    timestamp: u64,
}

struct AudioState {
    stop: Option<Arc<AtomicBool>>,
}

fn audio_state() -> &'static Mutex<AudioState> {
    static S: OnceLock<Mutex<AudioState>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(AudioState { stop: None }))
}

#[tauri::command]
pub fn screen_audio_start(app: AppHandle) -> Result<AudioStartInfo, String> {
    // Если уже запущено — сначала останавливаем, потом стартуем новое.
    let _ = screen_audio_stop();

    let (info_tx, info_rx) = std::sync::mpsc::sync_channel::<Result<AudioStartInfo, String>>(1);
    let stop = Arc::new(AtomicBool::new(false));
    let stop_t = stop.clone();
    let app_t = app.clone();

    std::thread::Builder::new()
        .name("screen-audio".to_string())
        .spawn(move || {
            run_audio_thread(app_t, info_tx, stop_t);
        })
        .map_err(|e| e.to_string())?;

    let info = info_rx
        .recv()
        .map_err(|e| format!("audio thread died before init: {}", e))??;

    let mut state = audio_state().lock().map_err(|_| "lock poisoned".to_string())?;
    state.stop = Some(stop);
    Ok(info)
}

#[tauri::command]
pub fn screen_audio_stop() -> Result<(), String> {
    let mut state = audio_state().lock().map_err(|_| "lock poisoned".to_string())?;
    if let Some(stop) = state.stop.take() {
        stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn run_audio_thread(
    app: AppHandle,
    info_tx: std::sync::mpsc::SyncSender<Result<AudioStartInfo, String>>,
    stop: Arc<AtomicBool>,
) {
    let host = cpal::default_host();
    let device = match host.default_output_device() {
        Some(d) => d,
        None => {
            let _ = info_tx.send(Err("default output device not available".to_string()));
            return;
        }
    };
    let cfg = match device.default_output_config() {
        Ok(c) => c,
        Err(e) => {
            let _ = info_tx.send(Err(format!("default_output_config: {}", e)));
            return;
        }
    };
    let sample_rate = cfg.sample_rate();
    let channels = cfg.channels();
    let sample_format = cfg.sample_format();
    let stream_config: cpal::StreamConfig = cfg.into();

    let start_instant = std::time::Instant::now();
    // Arc<dyn Fn> чтобы share'ить closure между ветками match'а без auto-Clone магии.
    let app_cb = app.clone();
    let emit: Arc<dyn Fn(&[f32]) + Send + Sync> = Arc::new(move |data: &[f32]| {
        let timestamp_us = start_instant.elapsed().as_micros() as u64;
        let mut bytes = Vec::with_capacity(data.len() * 4);
        for s in data {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        let pcm = B64.encode(&bytes);
        let _ = app_cb.emit("screen-audio:pcm", PcmPayload { pcm, timestamp: timestamp_us });
    });

    // cpal-callback fires в отдельном audio-thread'е, который cpal сам
    // создаёт через WASAPI. Мы не можем держать Stream в Send-Mutex'е
    // (стрим COM-affine), поэтому строим его прямо тут и парк'имся до stop.
    let build_result = match sample_format {
        cpal::SampleFormat::F32 => {
            let cb = emit.clone();
            device.build_input_stream(
                stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| { cb(data); },
                |err| eprintln!("[screen-audio] stream error: {}", err),
                None,
            ).map_err(|e| e.to_string())
        }
        cpal::SampleFormat::I16 => {
            let cb = emit.clone();
            device.build_input_stream(
                stream_config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    let mut converted: Vec<f32> = Vec::with_capacity(data.len());
                    for s in data {
                        converted.push((*s as f32) / (i16::MAX as f32));
                    }
                    cb(&converted);
                },
                |err| eprintln!("[screen-audio] stream error: {}", err),
                None,
            ).map_err(|e| e.to_string())
        }
        cpal::SampleFormat::U16 => {
            let cb = emit.clone();
            device.build_input_stream(
                stream_config,
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    let mut converted: Vec<f32> = Vec::with_capacity(data.len());
                    for s in data {
                        converted.push((*s as f32 - u16::MAX as f32 / 2.0) / (u16::MAX as f32 / 2.0));
                    }
                    cb(&converted);
                },
                |err| eprintln!("[screen-audio] stream error: {}", err),
                None,
            ).map_err(|e| e.to_string())
        }
        other => Err(format!("unsupported sample format: {:?}", other)),
    };

    let stream = match build_result {
        Ok(s) => s,
        Err(e) => {
            let _ = info_tx.send(Err(format!("build_input_stream: {}", e)));
            return;
        }
    };
    if let Err(e) = stream.play() {
        let _ = info_tx.send(Err(format!("stream.play: {}", e)));
        return;
    }

    let _ = info_tx.send(Ok(AudioStartInfo { sample_rate, channels }));

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(50));
    }
    drop(stream); // stops cpal stream
}
