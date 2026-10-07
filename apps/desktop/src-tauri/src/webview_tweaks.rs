// Полировка нативного WebView2 (только Windows):
//  1. PermissionRequested → авто-ALLOW для микрофона и камеры. Клиент
//     общается с одним доверенным self-host сервером, а нативная плашка
//     «Разрешить доступ к микрофону?» при входе в голосовой канал выглядит
//     браузерным артефактом. Остальные permission kinds не трогаем —
//     для них остаётся дефолтное поведение.
//  2. Менеджер паролей Edge и general-автофилл выключены — иначе на форме
//     логина всплывает нативная плашка «Сохранить пароль?».
//  3. Остальные браузерные возможности выключены, чтобы приложение не вело
//     себя как вкладка Edge: зум (Ctrl+колесо/Ctrl+±/щипок ломает вёрстку),
//     строка состояния со ссылкой внизу окна, свайп-навигация «назад», а в
//     релизной сборке ещё и горячие клавиши браузера (F5/Ctrl+R перезагружали
//     страницу и сбрасывали состояние звонка, Ctrl+P печать, Ctrl+F поиск).
//     В debug-сборке горячие клавиши оставлены: нужны F12 и перезагрузка.
//
// Версии webview2-com/windows-core в Cargo.toml обязаны совпадать с теми,
// что уже тянет wry (см. Cargo.lock) — иначе в графе появится второе,
// несовместимое по типам дерево `windows`.

use std::sync::Once;

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Settings3, ICoreWebView2Settings4, ICoreWebView2Settings5,
    ICoreWebView2Settings6, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
    COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION,
    COREWEBVIEW2_PERMISSION_STATE_ALLOW,
};
use webview2_com::PermissionRequestedEventHandler;
use windows_core::Interface;

static INSTALL: Once = Once::new();

// Вызывается из on_page_load (lib.rs): хук срабатывает на каждую навигацию,
// а обработчик должен повеситься один раз — отсюда Once.
pub fn install<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    INSTALL.call_once(|| {
        let _ = webview.with_webview(|platform| unsafe {
            let Ok(core) = platform.controller().CoreWebView2() else {
                return;
            };

            if let Ok(settings) = core.Settings() {
                let _ = settings.SetIsZoomControlEnabled(false);
                let _ = settings.SetIsStatusBarEnabled(false);
                if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                    if !cfg!(debug_assertions) {
                        let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
                    }
                }
                if let Ok(s4) = settings.cast::<ICoreWebView2Settings4>() {
                    let _ = s4.SetIsPasswordAutosaveEnabled(false);
                    let _ = s4.SetIsGeneralAutofillEnabled(false);
                }
                if let Ok(s5) = settings.cast::<ICoreWebView2Settings5>() {
                    let _ = s5.SetIsPinchZoomEnabled(false);
                }
                if let Ok(s6) = settings.cast::<ICoreWebView2Settings6>() {
                    let _ = s6.SetIsSwipeNavigationEnabled(false);
                }
            }

            let handler = PermissionRequestedEventHandler::create(Box::new(|_sender, args| {
                if let Some(args) = args {
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
                    args.PermissionKind(&mut kind)?;
                    if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                        || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                    {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                    }
                }
                Ok(())
            }));
            // Токен регистрации не храним: обработчик живёт до конца процесса,
            // remove_PermissionRequested не планируется.
            let mut token = 0i64;
            let _ = core.add_PermissionRequested(&handler, &mut token);
        });
    });
}
