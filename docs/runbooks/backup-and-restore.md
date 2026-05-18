# Backup and Restore

Бэкап single-node инстанса = pg_dump + копия объектов MinIO. Конфигурацию
(`deploy/.env`, Caddyfile, compose-файл) хранить отдельно — она в git и
содержит секреты, которые в бэкап намеренно не попадают.

## Состав снапшота

Скрипт `deploy/backup.sh` создаёт каталог
`./backups/<UTC-timestamp>/` со структурой:

```text
backups/20260518T120000Z/
  manifest.txt          # версия формата, дата, имена БД/бакета
  postgres.sql.gz       # pg_dump --clean --if-exists --no-owner --no-privileges
  minio/                # mc mirror содержимого MINIO_BUCKET (плоский src/dst)
```

`--no-owner --no-privileges` нужны чтобы restore работал в БД с другим
владельцем (актуально при миграции на новый хост). `--clean --if-exists`
делает restore идемпотентным — старые таблицы сбрасываются перед
загрузкой.

## Создание бэкапа

```bash
deploy/backup.sh                       # пишет в ./backups/<ts>/
deploy/backup.sh /mnt/external/rucord  # либо в любой каталог
```

Требования:

- `deploy/single-node/docker-compose.yml` поднят, контейнеры `postgres` и
  `minio` в Up;
- `deploy/.env` существует и содержит `POSTGRES_*`, `MINIO_ROOT_*`,
  `MINIO_BUCKET`;
- доступны `docker compose`, `bash`, `gzip`.

На Windows запускать через WSL или Git Bash. На Linux/macOS — нативно.

Бэкап **не блокирует** core-api / realtime / worker. pg_dump использует
MVCC-снапшот; mc mirror отлично переживает параллельную запись (новые
объекты могут попасть в следующий снапшот, не в этот).

## Регулярный запуск

Cron-пример (ежедневно в 03:00 UTC, ротация — хранить 14 последних):

```cron
0 3 * * * cd /opt/rucord && deploy/backup.sh /var/backups/rucord && \
  ls -1dt /var/backups/rucord/*/ | tail -n +15 | xargs -r rm -rf
```

Снапшоты ОБЯЗАТЕЛЬНО уносить с хоста (rsync на отдельный сервер, rclone
в S3, тарбол в чужой регион — что угодно). Бэкап на тот же диск ломается
вместе с диском.

## Restore

ВАЖНО: операция деструктивна. Останови сервисы перед restore:

```bash
# Если core-api/realtime/worker запущены как host-процессы — останови их
# обычным способом. Контейнеры compose не трогаем (нужны postgres/minio).

deploy/restore.sh ./backups/20260518T120000Z
```

Скрипт переспросит `yes/NO`. Что произойдёт:

1. `psql < postgres.sql.gz` с `--clean --if-exists` — таблицы и данные
   перезаписываются на состояние снапшота;
2. `mc mirror --remove` — объекты в `MINIO_BUCKET` приводятся к
   снапшоту: лишние удаляются, недостающие — копируются.

После restore прогнать миграции на случай если код на хосте новее
снапшота (бэкап содержит ровно ту схему, что была в pg на момент
снапшота — если за это время добавились миграции, их нужно применить):

```bash
docker compose -f deploy/single-node/docker-compose.yml \
  --env-file deploy/.env run --rm migrate
```

Затем поднять core-api/realtime/worker обратно.

## Проверка восстановления

Чтобы убедиться что бэкап рабочий — раз в N недель прогонять restore на
**отдельной** машине (или в отдельном compose-проекте с другим
`COMPOSE_PROJECT_NAME` и `MINIO_BUCKET`) и убеждаться что:

- core-api стартует, `/healthz` отвечает 200, `/readyz` 200;
- логин админа проходит, видны workspace/каналы/сообщения из снапшота;
- объекты media отдаются через `/api/v1/media/<id>`.

Без этого «бэкапа» можно считать что у тебя нет. Большая часть отказов
бэкапов обнаруживается именно при первой реальной попытке восстановить.

## Что НЕ покрывает этот бэкап

- содержимое Redis — короткоживущие данные (сессии presence,
  rate-limit-счётчики). После restore все онлайн-статусы сбросятся, и
  это ожидаемо;
- `deploy/.env` и Caddyfile — секреты и конфиг. Хранить в git
  (.env — приватный, encrypted-storage / vault);
- TLS-сертификаты Caddy. Лежат в named volume `caddy-data`. Для
  Let's Encrypt — Caddy перевыпустит при первом обращении. Для
  `internal` self-signed CA — корневой сертификат пропадёт, клиентам
  придётся принять новый.
