# Desktop release: CI-сборка и auto-update

Релизный пайплайн desktop-клиента: тег `v*` → GitHub Actions собирает
`.msi`/`.exe` (Windows), `.dmg` (macOS universal), `.AppImage`/`.deb` (Linux)
и публикует **draft**-релиз. После ручной публикации релиза установленные
клиенты подхватывают обновление сами (`tauri-plugin-updater` проверяет
`latest.json` на старте и раз в 6 часов).

## Однократная настройка (перед первым релизом)

### 1. Сгенерировать keypair подписи updater-манифеста

```powershell
cd apps/desktop
npm run tauri signer generate -- -w $HOME/.tauri/rucord.key
```

Команда напечатает **публичный ключ** (base64) и сохранит **приватный**
в `~/.tauri/rucord.key`. Пароль можно оставить пустым (Enter), но лучше задать.

> Приватный ключ потерять нельзя: без него нельзя выпустить обновление,
> которое примут уже установленные клиенты. Храни копию вне репозитория.

### 2. Вписать публичный ключ в конфиг

`apps/desktop/src-tauri/tauri.conf.json` → `plugins.updater.pubkey` —
вставить напечатанный публичный ключ (сейчас там пустая строка; с пустым
pubkey клиент тихо пропускает проверку обновлений).

### 3. Добавить Secrets в GitHub

Repo → Settings → Secrets and variables → Actions:

| Secret | Значение |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | содержимое файла `~/.tauri/rucord.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | пароль ключа (пустая строка, если без пароля) |

## Выпуск релиза

```powershell
# поднять версию в трёх местах (должны совпадать):
#   apps/desktop/package.json            "version"
#   apps/desktop/src-tauri/tauri.conf.json "version"
#   apps/desktop/src-tauri/Cargo.toml     version
git tag v0.2.0
git push origin v0.2.0
```

Дальше:

1. Actions → `desktop-release` собирает все три платформы (~15-25 мин).
2. В Releases появляется **draft** «RuCord v0.2.0» с артефактами +
   `latest.json` + `.sig`-файлы.
3. Проверить артефакты руками (поставить .exe, убедиться что запускается).
4. Нажать **Publish release** — с этого момента клиенты начнут видеть
   обновление (зелёный баннер «Доступно обновление» → «Установить» →
   скачивание с прогрессом → авто-перезапуск → диалог «Что нового» с
   release notes).

Release notes для «Что нового» берутся из поля notes в `latest.json`
(tauri-action заполняет его из releaseBody; можно отредактировать текст
релиза до Publish — но latest.json формируется при сборке).

## Локальная сборка после включения updater'а

`createUpdaterArtifacts: true` требует приватный ключ и при локальном
`npm run tauri build`:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $HOME/.tauri/rucord.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npm run tauri build
```

`npm run tauri dev` ключа **не** требует.

## Что НЕ настроено (отдельные подпункты F.7)

- **Windows Authenticode** — exe не подписан, SmartScreen будет ругаться
  «неизвестный издатель». Нужен сертификат code-signing (платный) +
  signtool-шаг в workflow.
- **macOS notarization** — Gatekeeper потребует правый клик → «Открыть».
  Нужен Apple Developer ID ($99/год) + notarytool-шаг.

Updater-подпись (`latest.json` + `.sig`) от этого не зависит — обновления
работают и без платных сертификатов.
