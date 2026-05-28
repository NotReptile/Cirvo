// K.2: глобальные хоткеи (`tauri-plugin-global-shortcut`) подключены только
// под десктопными таргетами — плагин не существует на iOS/Android. Когда
// его нет, frontend `tauriHotkeys.ts` детектит отсутствие invoke-канала
// и фоллбэчится на window-listener (как было до K.2).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

    builder
        .run(tauri::generate_context!())
        .expect("failed to run RuCord application");
}
