# AGENTS.md: инструкция для ИИ-агентов

Файл для любого ИИ-агента (Claude Code, Codex, Cursor и др.), который работает в
этом репозитории. Люди тоже могут читать его как краткую шпаргалку.
`CLAUDE.md` просто подключает этот файл.

## Что это за проект

RuCord: self-host чат и голос (аналог Discord) для небольших сообществ. Один
инстанс = один сервер, внутри допустимо несколько workspace'ов. Сервер на Linux
(Docker), основной клиент: Tauri-приложение для Windows. Язык проекта: русский
(документация, сообщения коммитов, тексты интерфейса).

## Структура

| Путь | Что |
| --- | --- |
| `apps/desktop` | Клиент: TypeScript + Vite + Tauri 2 (`src-tauri` — Rust-оболочка) |
| `services/core-api` | Go HTTP API, порт 8080; модули в `internal/modules/*` |
| `services/realtime` | Go WebSocket: presence, signaling, journal событий, порт 8090 |
| `services/sfu` | Go SFU (pion) для группового голоса, порт 8095, медиа по UDP 50000 |
| `services/worker` | Go фоновые задачи: превью, ретеншн, уведомления |
| `libs/shared-go` | Общие Go-пакеты (config, jwtauth, ratelimit, retention, wsticket…) |
| `libs/shared-ts`, `libs/contracts` | Общие TS-типы и контракты |
| `db/migrations` | Нумерованные миграции golang-migrate (`up` и `down`) |
| `deploy/` | `local/` (разработка) и `single-node/` (продакшн) |
| `docs/` | Документация, индекс: `docs/README.md` |

Go-проект использует `go.work` (модули в `services/*` и `libs/shared-go`).
Корневой `package.json` задаёт npm workspaces для клиента.

## Команды

Go (запускать из корня; `./services/...` в workspace не работает, модули перечисляются):

```bash
go build ./libs/shared-go/... ./services/core-api/... ./services/realtime/... ./services/sfu/... ./services/worker/...
go test -race ./libs/shared-go/... ./services/core-api/... ./services/realtime/... ./services/sfu/...
go test -tags=smoke -count=1 ./services/core-api/smoketests/   # нужны Postgres, Redis, MinIO
```

Клиент:

```bash
npm ci
npm run check:desktop              # tsc
npm --workspace apps/desktop test  # vitest
npm run build:desktop              # vite build
npm --workspace apps/desktop run tauri build   # exe; нужен Rust и ключ подписи, см. docs/runbooks/desktop-release.md
```

CI (`.github/workflows/smoke.yml`) проверяет клиент и Go-сервисы на каждый push и
PR в `main`; `desktop-check.yml` отдельно собирает Tauri для Windows без бандла
и публикации релиза. Перед PR прогони хотя бы `check:desktop`, тесты клиента и
`go build`.

## Правила кода

- **RBAC.** Новое право = новая константа `permission.Action` и запись в матрице.
  Никаких `if role == "..."` в обработчиках.
- **Клиент и Tauri.** Бизнес-логика не импортирует `@tauri-apps/api/*`. Платформенные
  возможности подключаются через тонкий адаптер с web-fallback (примеры:
  `app/tauriUpdater.ts`, `app/tauriHotkeys.ts`, `call/tauriScreenCapture.ts`).
- **Слои клиента.** UI не делает сетевых вызовов напрямую: `HttpClient`,
  `RealtimeClient`, `CallManager` / `VoiceChannelManager`.
- **Server-wide настройка** = миграция в `server_settings` + endpoint + пункт в
  админке. Не размазывать по env.
- **Миграции.** Только новый файл с следующим номером и парой `up`/`down`. Старые
  не редактировать.
- **Модули `core-api`** не читают чужие таблицы напрямую без формального контракта.
- **Конфигурация**: адреса, секреты, домены и лимиты только из env/конфига.
- Форматирование: `.editorconfig` (LF, UTF-8, 2 пробела; Go — табы).
- Не добавляй `*` в CORS, не логируй токены и пароли.

## Работа с git

- Сообщения коммитов на русском, в стиле `feat(scope): …`, `fix(scope): …`,
  `docs: …`. Номера этапов из `TASKS.md` в сообщениях не упоминать: файла нет в git.
- В `main` напрямую не пушить: ветка → PR. Автор PR сам выбирает момент merge.
- Исторически владелец проекта коммитит сам. Если пользователь явно не попросил
  закоммитить или открыть PR, оставляй изменения в рабочем дереве или staged.

## Что нельзя делать

- Не читать, не печатать и не коммитить `deploy/.env`, `.claude/settings*.json`,
  `~/.tauri/*`, любые токены и пароли. Примеры значений живут в `deploy/.env.example`.
- Не добавлять секреты и боевые адреса в документацию: используй `chat.example.com`,
  `<PUBLIC_IP>`, `<TOKEN>`.
- Не публиковать релизы и не менять настройки GitHub-репозитория без прямой просьбы.
- Не удалять данные и бэкапы на боевом сервере.
- Документы с кириллицей правь точечно (Edit), а не перезаписывай скриптами:
  неверная кодировка уже один раз обнулила файл.

## Документация

Источник правды: `docs/`. Индекс: [docs/README.md](docs/README.md). Меняешь поведение,
порты, переменные окружения или процесс релиза: обнови соответствующий runbook и
`deploy/.env.example` в том же PR. История версий: [CHANGELOG.md](CHANGELOG.md).

Планы, идеи, аудиты и списки доработок ведутся локально и в git **не попадают**:
`TASKS.md` в корне и каталог `dev-notes/` (оба в `.gitignore`). Не добавляй такие
файлы в коммиты и не создавай их в `docs/`. `TASKS.md` может отставать от кода:
сверяйся с кодом, а не с отметками `[x]`/`[ ]`.

## Окружение разработчика

Основная машина: Windows 11 (PowerShell или Git Bash), Docker Desktop, Rust, Node,
Go. Боевой сервер: Linux-мини-ПК, доступ по SSH. Запуск в разработке: таски VSCode
(`Run All`) или команды из [docs/runbooks/local-development.md](docs/runbooks/local-development.md).
