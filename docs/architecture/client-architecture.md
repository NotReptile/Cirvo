# Client Architecture

## Layers

- `ui` (`apps/desktop/src/app/`) - shell rendering and view composition. `app/ui.ts` — публичная точка входа; `ui/session.ts` связывает менеджеры и события, `ui/renderer.ts` собирает shell и обновляет отдельные области. Экраны, вкладки настроек и обработчики областей находятся в `ui/`; типы и состояние — в `types.ts`, `state.ts`, чистые форматтеры — в `util/`.
- `application` (`apps/desktop/src/app/bootstrap.ts`) - orchestration and use-case entrypoints: создаёт `HttpClient`, `RealtimeClient` (с выдачей WS-тикета через `POST /api/v1/realtime/ticket`), `CallManager`, `VoiceChannelManager` и связывает смену токенов с realtime и звонками. В production-сборке без сохранённого адреса сервера показывает onboarding (`onboarding.ts`, `serverConfig.ts`).
- `network` (`apps/desktop/src/network/`) - HTTP transport adapter.
- `realtime` (`apps/desktop/src/realtime/`) - WebSocket transport adapter (`send`/`subscribe`), реконнект с курсором и обработка `sync.required` / `sync.ready`.
- `call` (`apps/desktop/src/call/`) - WebRTC: `CallManager` (1-к-1), `VoiceChannelManager` (voice-каналы, mesh или SFU), `SfuSession` (клиентская сторона SFU), настройки и обработка звука/видео (`voiceSettings`, `denoiser`, `videoEffects`), захват экрана (`screenSharePicker`, `tauriScreenCapture`, `screenAudio`), диагностика TURN (`iceCheck`). Consumes `realtime` for signaling and `network` for `GET /api/v1/media/config`. Подробности: [realtime-and-calls.md](realtime-and-calls.md).
- `local-cache` - настройки адреса сервера, курсора realtime, голоса, хоткеев, оформления и черновики в `localStorage`; blob-кэш медиа в `mediaCache.ts`. `HttpClient` принимает `TokenStore`: на Windows токены хранятся через Credential Manager, в браузере — в хранилище с отдельным ключом для каждого сервера. Старые токены мигрируют только для совпадающего адреса сервера, без отката на открытое хранилище при ошибке native API.
- `src-tauri` (`apps/desktop/src-tauri/`) - Rust-оболочка. Команды захвата экрана, системного звука, хранения токенов и проверки/установки обновлений; плагины global-shortcut, opener, updater, process. Обновления загружаются с выбранного HTTPS-сервера с авторизацией, проверкой origin установщика и подписи.

## Rules

- UI does not make raw transport calls directly. UI talks to managers (`HttpClient`, `RealtimeClient`, `CallManager`, `VoiceChannelManager`).
- Client cache improves responsiveness but does not replace server authority.
- Media logic stays in `call/` and exposes a state-machine snapshot to UI. UI не создаёт и не держит `RTCPeerConnection`. `MediaStream` менеджеры отдают UI только для отображения (`srcObject`, индикатор речи); исключение — проверка микрофона и камеры в `ui/voiceSettings.ts`.

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
| `app/tauriTokenStore.ts` | `api/core` | Токены по адресу сервера в Windows Credential Manager. | `BrowserTokenStore`. |
| `app/tauriLinks.ts` | `plugin-opener` | Внешние HTTP/HTTPS-ссылки в системном браузере. | Обычная ссылка браузера. |
| `call/tauriScreenCapture.ts` | `api/core` (`invoke`) | Захват экрана и окон через Rust-команды. | `getDisplayMedia`. |
| `call/screenAudio.ts` | `api/core`, `api/event` | Системный звук демонстрации экрана (Windows). | Аудиотрек не добавляется. |

Where a feature has a web equivalent, use it instead of a native API: обычные настройки (`localStorage` / `IndexedDB`), notifications (`Notification` API with permission prompt), file picking (`<input type=file>`). Native-адаптер добавляется, когда веб-аналог не покрывает задачу: защищённое хранение токенов, глобальные хоткеи, автообновление, захват экрана без браузерной плашки.

## Частичные обновления и история

`runtime.ts` связывает `requestRender` и renderer без импорта renderer из экранов. Presence обновляет участников и списки каналов/DM, typing — свою строку, статус — свою область. Изменения голоса и звонка сравниваются до обновления. Keyed DOM patch сохраняет фокус, черновики и идентичность видео; обработчики сообщений делегируются контейнеру и не дублируются после render.

`layoutMessages.ts` вычисляет группировку, даты и разделитель непрочитанного. `ui/messageList.ts` кэширует HTML строк и обновляет затронутые сообщения; `ui/indexes.ts` индексирует участников и каналы. В DOM находится окно до 200 сообщений, полный загруженный массив остаётся в памяти. `ui/history.ts` учитывает разрывы между страницами; переход вне кэша использует `around`, прокрутка через разрыв — `before`/`after`. Стенд замеров и SQL для отдельной QA-базы: `tools/perf/`.
