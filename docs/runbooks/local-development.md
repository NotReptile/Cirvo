# Local Development — пробный запуск

Цель: поднять весь стек локально и увидеть, как через десктоп-клиент в браузере проходит регистрация → создание воркспейса → отправка сообщения → realtime-доставка.

## Требования

- Docker Desktop (с docker compose)
- Go 1.26+
- Node.js 20.19+ или 22.12+

## 1. Подготовка окружения

Скопируйте `deploy/.env.example` в `deploy/.env` и при желании поменяйте секреты:

```powershell
Copy-Item deploy/.env.example deploy/.env
```

Минимум, что нужно проверить:
- `CIRVO_SFU_URL` — для локального режима очистите значение (оставьте `CIRVO_SFU_URL=`). Иначе `core-api` анонсирует клиентам несуществующий SFU, и групповые звонки не соединятся. Локально работает mesh;
- `CIRVO_JWT_SECRET` — должен быть длиной ≥32 символа (по умолчанию подходит)
- `POSTGRES_PASSWORD` — пароль для локального Postgres

Экспортируйте переменные в текущую сессию (PowerShell):

```powershell
Get-Content deploy/.env | ForEach-Object {
  if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)=(.*)$') {
    [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
  }
}
```

## 2. Поднять инфраструктуру и применить миграции

```powershell
docker compose --env-file deploy/.env -f deploy/local/docker-compose.yml up -d postgres redis minio
docker compose --env-file deploy/.env -f deploy/local/docker-compose.yml run --rm migrate
```

Контейнер `migrate` использует образ `migrate/migrate:v4.17.1` и прогоняет все миграции из `db/migrations/` поверх БД `cirvo`.

Проверьте, что Postgres готов:

```powershell
docker exec -it $(docker ps -qf "name=postgres") psql -U rucord -d rucord -c "\dt"
```

Должны быть видны таблицы: `users`, `workspaces`, `channels`, `messages`, `read_receipts`, `workspace_invites`, и т.д.

## 3. Запустить Go-сервисы

В трёх отдельных терминалах (каждый с экспортированными env-переменными из шага 1):

```powershell
go run github.com/NotReptile/Cirvo/services/core-api/cmd/core-api
go run github.com/NotReptile/Cirvo/services/realtime/cmd/realtime
go run github.com/NotReptile/Cirvo/services/worker/cmd/worker
```

Ожидаемый вывод:
- `core-api` — `starting http server address=:8080`
- `realtime` — `starting realtime server address=:8090`
- `worker` — `worker tick`

Health checks:
- http://127.0.0.1:8080/healthz
- http://127.0.0.1:8090/healthz

## 4. Запустить десктоп-клиент

В четвёртом терминале:

```powershell
cd apps/desktop
npm install
npm run dev
```

Vite поднимет dev-сервер на http://127.0.0.1:1420 и автоматически проксирует
`/api/*` → core-api (http://127.0.0.1:8080) и `/ws` → realtime
(ws://127.0.0.1:8090). Благодаря этому фронтенд ходит на свой же origin,
никаких CORS-настроек на стороне браузера не требуется.

Если core-api/realtime запущены не на стандартных портах, переопределите
прокси-таргет через переменные `VITE_API_PROXY_TARGET` и
`VITE_REALTIME_PROXY_TARGET` перед `npm run dev`.

## 5. Пробный сценарий

1. На экране входа выберите вкладку **Регистрация**.
2. Заполните: email (`alice@example.com`), username (`alice`, только `a-z0-9_`), пароль (от 8 символов), отображаемое имя.
3. После регистрации появится боковая панель. Создайте воркспейс: имя `Demo`, slug `demo`.
4. Автоматически появится канал `#general`. Можно создать дополнительный канал, например `random`.
5. Отправьте сообщение. Оно сохранится через REST и придёт обратно через WebSocket (`message.created`).
6. Откройте второе окно браузера (или режим инкогнито), зарегистрируйте второго пользователя, попросите модератора (первого) выдать invite через API (см. ниже) или присоединитесь через инвайт-код.

## API-шорткаты для проверки руками

```bash
# Регистрация
curl -X POST http://127.0.0.1:8080/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"a@b.test","username":"alice","password":"secret123","deviceLabel":"curl"}'

# Создать invite (нужен access token от логина)
curl -X POST http://127.0.0.1:8080/api/v1/workspaces/{wsId}/invites \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"maxUses":10}'

# Принять invite
curl -X POST http://127.0.0.1:8080/api/v1/invites/{code}/accept \
  -H "Authorization: Bearer $TOKEN_OF_INVITEE"
```

## Очистка

```powershell
docker compose --env-file deploy/.env -f deploy/local/docker-compose.yml down -v
```

Флаг `-v` удалит volumes (Postgres, MinIO) — следующий запуск начнётся с чистой БД.

## Что куда смотрит

| Компонент | Порт | URL |
|-----------|------|-----|
| core-api  | 8080 | http://127.0.0.1:8080 |
| realtime  | 8090 | ws://127.0.0.1:8090/ws |
| Postgres  | 5433 | postgres://rucord:change-me@127.0.0.1:5433/rucord |
| Redis     | 6379 | redis://127.0.0.1:6379 |
| MinIO     | 9000 / 9001 | http://127.0.0.1:9001 (UI) |
| Desktop (Vite) | 1420 | http://127.0.0.1:1420 |
