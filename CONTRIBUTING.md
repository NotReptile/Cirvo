# Участие в разработке

Короткая версия. Подробные правила для кода и работы с git: [AGENTS.md](AGENTS.md).

## Быстрый старт

1. Поднять локальное окружение: [docs/runbooks/local-development.md](docs/runbooks/local-development.md).
2. Создать ветку от `main`: `feat/...`, `fix/...`, `docs/...`.
3. Внести изменения небольшими коммитами.
4. Проверить локально:

   ```bash
   npm run check:desktop
   npm --workspace apps/desktop test
   go build ./libs/shared-go/... ./services/core-api/... ./services/realtime/... ./services/sfu/... ./services/worker/...
   go test -race ./libs/shared-go/... ./services/core-api/... ./services/realtime/... ./services/sfu/...
   ```

5. Открыть PR в `main`. CI (`smoke`) должен быть зелёным.

## Что приветствуется

- исправления ошибок с описанием, как воспроизвести;
- правки документации: устаревшие команды, опечатки, недостающие шаги;
- доработки из открытых issue.

Крупные изменения (новый сервис, смена протокола, схема БД) сначала обсуди в issue.

## Правила

- сообщения коммитов на русском: `feat(scope): …`, `fix(scope): …`, `docs: …`;
- миграции БД только новыми файлами с парой `up` и `down`;
- новые права доступа через `permission.Action`;
- меняешь переменные окружения, порты или процесс релиза: обнови runbook и
  `deploy/.env.example`;
- не добавляй в репозиторий секреты и реальные адреса серверов.

## Безопасность

Об уязвимостях сообщай не в публичных issue, а по инструкции из [SECURITY.md](SECURITY.md).
