use serde::Serialize;
use std::{sync::Mutex, time::Duration};
use tauri::{ipc::Channel, State};
use tauri_plugin_updater::{Update, UpdaterExt};

pub type PendingUpdate = Mutex<Option<Update>>;

#[derive(Serialize)]
pub struct UpdateView {
    version: String,
    notes: Option<String>,
}

#[tauri::command]
pub async fn check_server_update(
    app: tauri::AppHandle,
    server_url: String,
    access_token: String,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateView>, String> {
    let mut endpoint = tauri::Url::parse(&server_url).map_err(|_| "Некорректный адрес сервера")?;
    if endpoint.scheme() != "https"
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
    {
        return Err("Обновления требуют защищённого HTTPS-сервера".into());
    }
    endpoint.set_path("/updates/latest.json");
    endpoint.set_query(None);
    endpoint.set_fragment(None);
    let update = app
        .updater_builder()
        .endpoints(vec![endpoint.clone()])
        .map_err(|_| "Некорректный адрес обновлений")?
        .header("Authorization", format!("Bearer {access_token}"))
        .map_err(|_| "Некорректная сессия")?
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| "Не удалось настроить обновления")?
        .check()
        .await
        .map_err(|_| "Сервер обновлений недоступен")?;
    if let Some(ref value) = update {
        if value.download_url.origin() != endpoint.origin() {
            return Err("Установщик должен находиться на том же сервере".into());
        }
    }
    let view = update.as_ref().map(|value| UpdateView {
        version: value.version.clone(),
        notes: value.body.clone(),
    });
    *pending
        .lock()
        .map_err(|_| "Хранилище обновлений недоступно")? = update;
    Ok(view)
}

#[tauri::command]
pub async fn install_server_update(
    pending: State<'_, PendingUpdate>,
    progress: Channel<Option<u32>>,
) -> Result<(), String> {
    let update = pending
        .lock()
        .map_err(|_| "Хранилище обновлений недоступно")?
        .take()
        .ok_or("Сначала проверьте наличие обновлений")?;
    let mut downloaded = 0u64;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let pct = total
                    .filter(|value| *value > 0)
                    .map(|value| ((downloaded * 100 / value).min(100)) as u32);
                let _ = progress.send(pct);
            },
            || {
                let _ = progress.send(Some(100));
            },
        )
        .await
        .map_err(|_| "Не удалось скачать, проверить подпись или установить обновление".into())
}
