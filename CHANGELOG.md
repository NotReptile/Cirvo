# История изменений

Формат: [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/). Версии:
[SemVer](https://semver.org/lang/ru/). Версия приложения живёт в трёх файлах
(`apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`,
`apps/desktop/src-tauri/Cargo.toml`) и должна совпадать с тегом релиза.

## [Не выпущено]

### Добавлено

- Ключ подписи обновлений клиента: публичная часть в `tauri.conf.json`.
- Runbook'и: `windows-client.md` (установка и подключение), переписаны
  `diagnostics.md` и `desktop-release.md`.
- `AGENTS.md` и `CLAUDE.md` для ИИ-агентов.
- Шаблоны issue и PR, `CONTRIBUTING.md`, `SECURITY.md`, Dependabot, `CODEOWNERS`.

### Изменено

- Обновлены зависимости клиента, Rust-оболочки, Go-сервисов и GitHub Actions.
  TypeScript 7 использует относительные пути без `baseUrl`; Go workspace и
  Docker-сборка требуют Go 1.26+.
- CI проверяет Windows-сборку Tauri без публикации релиза и подписи установщика.
- `desktop-release.yml`: по умолчанию собирается только Windows, добавлены ручной
  запуск с выбором платформ, проверка совпадения версии с тегом, текст релиза с
  инструкцией по установке.
- Исправлена документация: Go-сервисы работают в контейнерах, добавлены
  переменные SFU и TURN, CORS для Windows-клиента, порядок обновления и бэкапа.
- Из `deploy/.env.example` удалены неиспользуемые `RUCORD_UPSTREAM_HOST`,
  `RUCORD_API_BASE_URL`, `RUCORD_REALTIME_URL`.
- В документации публичный IP и домен заменены плейсхолдерами.
- Удалён неподдерживаемый профиль `internet-facing` (каталог `deploy/internet-facing`,
  константа и тип окружения, runbook); публичный деплой описан в `single-node.md`.
- `deploy/single-node`: убран проброс `443/udp` (HTTP/3 отключён в Caddyfile).
- Единая версия Go (1.26) во всех модулях; `.gitattributes` с LF.
- `desktop-check` дополнительно запускает `tsc` и тесты клиента; `smoke` использует Node 22.
- `desktop-release`: теги с суффиксом (`v0.1.1-test`) не собираются автоматически,
  пустой или несуществующий тег отклоняется на первом шаге.
- Dependabot не предлагает мажорные обновления npm, cargo и Go-модулей.
- Голос и звонки больше не обращаются к публичному STUN Google. Пока `ICE_STUN_URLS`
  пуст, `core-api` строит STUN-адрес из `ICE_TURN_URLS` (отвечает тот же coturn).
  Если сервер не отдал `/api/v1/media/config`, клиент показывает «Голос недоступен»
  вместо тихого отката на внешний сервер.
- MinIO и mc собираются из исходников (`deploy/minio/Dockerfile`, коммиты в
  `MINIO_REF` и `MC_REF`) в `deploy/local` и `deploy/single-node`: публичные
  образы больше не скачиваются. CI берёт тот же коммит и кэширует бинарник;
  отдельный workflow `minio-image` проверяет сборку образов.

## [0.1.0]

Первая рабочая версия: аутентификация и сессии, рабочие пространства, роли и
права, текстовые каналы с вложениями и реакциями, треды и форум, личные
сообщения, друзья, приглашения, журнал аудита, админ-панель, голосовые каналы
(mesh и SFU), видео, демонстрация экрана, шумоподавление, десктоп-клиент на
Tauri для Windows. Single-node развёртывание в Docker с Caddy и coturn.
