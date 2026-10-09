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

// Нативные плашки WebView2 (разрешение микрофона/камеры, «сохранить пароль»)
// гасим на стороне шелла — Win-only, см. комментарий в модуле.
#[cfg(target_os = "windows")]
mod webview_tweaks;

#[cfg(target_os = "windows")]
mod token_store;

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
mod server_updater;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let builder = builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            screen_capture::screen_list_sources,
            screen_capture::screen_capture_frame,
            screen_capture::screen_capture_stop_all,
            server_updater::check_server_update,
            server_updater::install_server_update
        ]);

    #[cfg(target_os = "windows")]
    let builder = builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            screen_capture::screen_list_sources,
            screen_capture::screen_capture_frame,
            screen_capture::screen_capture_stop_all,
            screen_audio::screen_audio_start,
            screen_audio::screen_audio_stop,
            token_store::load_auth_tokens,
            token_store::save_auth_tokens,
            server_updater::check_server_update,
            server_updater::install_server_update
        ]);

    // F.8: auto-update + relaunch. Только desktop — updater на mobile
    // не существует (там обновления через сторы).
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    let builder = builder
        .manage(server_updater::PendingUpdate::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init());

    // on_page_load, а не setup: PlatformWebview готов гарантированно, и хук
    // не конфликтует с чужим содержимым setup-замыкания.
    #[cfg(target_os = "windows")]
    let builder = builder.on_page_load(|webview, _payload| {
        webview_tweaks::install(webview);
    });

    builder
        .run(tauri::generate_context!())
        .expect("failed to run RuCord application");
}
