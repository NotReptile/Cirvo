// K.2: глобальные хоткеи (`tauri-plugin-global-shortcut`) подключены только
// под десктопными таргетами — плагин не существует на iOS/Android. Когда
// его нет, frontend `tauriHotkeys.ts` детектит отсутствие invoke-канала
// и фоллбэчится на window-listener (как было до K.2).
//
// K.5/K.9: собственная screen-share pipeline через `xcap`. Регистрируем
// command'ы только под десктопом (xcap не поддерживает mobile).
//
// K.5(c): системный звук через cpal+WASAPI loopback. Доступен только на
// Windows — WASAPI Win-only. На mac/linux команды отсутствуют, фронт
// детектит ошибку invoke и не добавляет audio-track к screen-share.

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
mod screen_capture;

#[cfg(target_os = "windows")]
mod screen_audio;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let builder = builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            screen_capture::screen_list_sources,
            screen_capture::screen_capture_frame,
            screen_capture::screen_capture_stop_all
        ]);

    #[cfg(target_os = "windows")]
    let builder = builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            screen_capture::screen_list_sources,
            screen_capture::screen_capture_frame,
            screen_capture::screen_capture_stop_all,
            screen_audio::screen_audio_start,
            screen_audio::screen_audio_stop
        ]);

    // F.8: auto-update + relaunch. Только desktop — updater на mobile
    // не существует (там обновления через сторы).
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .run(tauri::generate_context!())
        .expect("failed to run RuCord application");
}
