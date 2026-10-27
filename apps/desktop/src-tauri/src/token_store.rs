use keyring::{Entry, Error};

fn entry(server_url: &str) -> Result<Entry, String> {
    if server_url.len() > 1024
        || !(server_url.starts_with("https://") || server_url.starts_with("http://"))
    {
        return Err("Некорректный адрес сервера".into());
    }
    Entry::new("com.cirvo.desktop", server_url)
        .map_err(|_| "Хранилище учётных данных Windows недоступно".into())
}

#[tauri::command]
pub fn load_auth_tokens(server_url: String) -> Result<Option<String>, String> {
    match entry(&server_url)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(Error::NoEntry) => Ok(None),
        Err(_) => Err("Не удалось прочитать сессию из хранилища Windows".into()),
    }
}

#[tauri::command]
pub fn save_auth_tokens(server_url: String, tokens: Option<String>) -> Result<(), String> {
    let entry = entry(&server_url)?;
    match tokens {
        Some(value) => entry
            .set_password(&value)
            .map_err(|_| "Не удалось сохранить сессию в хранилище Windows".into()),
        None => match entry.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(_) => Err("Не удалось удалить сессию из хранилища Windows".into()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_credential_round_trip() {
        let server_url = format!("https://qa-{}.invalid", std::process::id());
        let store = entry(&server_url).unwrap();
        let _ = store.delete_credential();
        assert_eq!(load_auth_tokens(server_url.clone()).unwrap(), None);
        save_auth_tokens(server_url.clone(), Some("temporary QA value".into())).unwrap();
        let loaded = load_auth_tokens(server_url.clone());
        // Clean the entry even if a read assertion fails.
        save_auth_tokens(server_url.clone(), None).unwrap();
        assert_eq!(loaded.unwrap(), Some("temporary QA value".into()));
        assert_eq!(load_auth_tokens(server_url).unwrap(), None);
    }
}
