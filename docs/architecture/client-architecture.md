# Client Architecture

## Layers

- `ui` (`apps/desktop/src/app/`) - shell rendering and view composition. Основной экран собран в `app/ui.ts`; рядом лежат вспомогательные модули (`dialogs`, `hotkeys`, `i18n`, `appearance`, `emojiPicker`, `lightbox` и т.д.).
- `application` (`apps/desktop/src/app/bootstrap.ts`) - orchestration and use-case entrypoints: создаёт `HttpClient`, `RealtimeClient` (с выдачей WS-тикета через `POST /api/v1/realtime/ticket`), `CallManager`, `VoiceChannelManager` и связывает смену токенов с realtime и звонками. В production-сборке без сохранённого адреса сервера показывает onboarding (`onboarding.ts`, `serverConfig.ts`).
- `network` (`apps/desktop/src/network/`) - HTTP transport adapter.
- `realtime` (`apps/desktop/src/realtime/`) - WebSocket transport adapter (`send`/`subscribe`), реконнект с курсором и обработка `sync.required` / `sync.ready`.
- `call` (`apps/desktop/src/call/`) - WebRTC: `CallManager` (1-к-1), `VoiceChannelManager` (voice-каналы, mesh или SFU), `SfuSession` (клиентская сторона SFU), настройки и обработка звука/видео (`voiceSettings`, `denoiser`, `videoEffects`), захват экрана (`screenSharePicker`, `tauriScreenCapture`, `screenAudio`), диагностика TURN (`iceCheck`). Consumes `realtime` for signaling and `network` for `GET /api/v1/media/config`. Подробности: [realtime-and-calls.md](realtime-and-calls.md).
- `local-cache` - settings and client-only cached state: `localStorage` for tokens, server URL, realtime cursor, voice/hotkey/appearance settings and message drafts; in-memory blob cache for media previews (`mediaBlobCache` в `ui.ts`).
- `src-tauri` (`apps/desktop/src-tauri/`) - Rust-оболочка. Команды `screen_list_sources`, `screen_capture_frame`, `screen_capture_stop_all` (Windows/macOS/Linux), `screen_audio_start` / `screen_audio_stop` (только Windows), плагины global-shortcut, updater, process.

## Rules

- UI does not make raw transport calls directly. UI talks to managers (`HttpClient`, `RealtimeClient`, `CallManager`, `VoiceChannelManager`).
- Client cache improves responsiveness but does not replace server authority.
- Media logic stays in `call/` and exposes a state-machine snapshot to UI. UI не создаёт и не держит `RTCPeerConnection`. `MediaStream` менеджеры отдают UI только для отображения (`srcObject`, индикатор речи); исключение - проверка микрофона и камеры в настройках, она вызывает `getUserMedia` напрямую из `ui.ts`.

## Cross-Platform Rule

Target platforms are **desktop + web + Android** via Tauri 2 (Android stable since 2.x); web и Android пока planned (см. README). Один и тот же бандл должен работать как PWA (web), Tauri desktop (Windows/Mac/Linux) и Tauri mobile (Android) без форков исходников. Поэтому платформенный код изолирован:

- Пакеты `@tauri-apps/*` импортируются только в тонких адаптерах с web-fallback. Бизнес-логика, менеджеры и `ui.ts` Tauri не видят: они работают с интерфейсом адаптера и получают `null` / `false` / no-op там, где платформа не поддерживает функцию.
- Адаптеры подгружают пакеты лениво через динамический `import()` и только после проверки `window.__TAURI_INTERNALS__`; статических импортов `@tauri-apps/*` нет. На web-сборке импорт не выполняется.
- Адаптеры подключаются обычным `import` из потребителей, а не инжектируются через `bootstrap.ts`. Новый адаптер следует тому же шаблону: файл `tauri*.ts` (или модуль в `call/`), проверка окружения, fallback.

Существующие адаптеры:

| Файл | Пакет Tauri | Что делает | Fallback без Tauri |
| --- | --- | --- | --- |
| `app/tauriHotkeys.ts` | `plugin-global-shortcut` | Глобальные хоткеи (PTT вне фокуса окна). | Обработчик `keydown` в окне (`hotkeys.ts`). |
| `app/tauriUpdater.ts` | `plugin-updater`, `plugin-process` | Проверка и установка обновлений, перезапуск. | `checkForUpdate()` возвращает `null`. |
| `call/tauriScreenCapture.ts` | `api/core` (`invoke`) | Захват экрана и окон через Rust-команды. | `getDisplayMedia`. |
| `call/screenAudio.ts` | `api/core`, `api/event` | Системный звук демонстрации экрана (Windows). | Аудиотрек не добавляется. |

Where a feature has a web equivalent, use it instead of a native API: storage (`localStorage` / `IndexedDB`, not native FS), notifications (`Notification` API with permission prompt), file picking (`<input type=file>`). Native-адаптер добавляется только если веб-аналога нет или он не покрывает задачу (глобальные хоткеи, автообновление, захват экрана без браузерной плашки).
