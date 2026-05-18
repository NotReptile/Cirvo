#!/usr/bin/env bash
# Restore single-node инстанса из бэкапа, созданного deploy/backup.sh.
#
# Использование:
#   deploy/restore.sh <backup-dir>
#
# Аргумент — путь к каталогу `./backups/<timestamp>/` (содержит
# postgres.sql.gz и minio/). Действия:
#   1) psql применяет postgres.sql.gz поверх текущей БД (--clean удалит
#      существующие таблицы перед загрузкой).
#   2) mc mirror перезаписывает объекты в MINIO_BUCKET снапшотом.
#
# ВНИМАНИЕ: операция деструктивна. Перед запуском убедись, что
# `deploy/single-node/docker-compose.yml` поднят и НИКТО не пишет в
# систему. Для прод-сценария рекомендуется stop core-api/realtime/worker
# на время restore.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <backup-dir>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy/.env"
COMPOSE_FILE="$ROOT/deploy/single-node/docker-compose.yml"
BACKUP="$(cd "$1" && pwd)"

for f in "$BACKUP/postgres.sql.gz" "$BACKUP/minio"; do
  if [[ ! -e "$f" ]]; then
    echo "restore: $f отсутствует — это не валидный бэкап" >&2
    exit 1
  fi
done

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

POSTGRES_DB="${POSTGRES_DB:-rucord}"
POSTGRES_USER="${POSTGRES_USER:-rucord}"
MINIO_BUCKET="${MINIO_BUCKET:-rucord}"

DC=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")

echo "[restore] source: $BACKUP"

read -r -p "[restore] это перезапишет БД и бакет $MINIO_BUCKET. Продолжить? [yes/NO]: " ack
if [[ "${ack:-}" != "yes" ]]; then
  echo "[restore] отменено"
  exit 0
fi

echo "[restore] psql < postgres.sql.gz"
gunzip -c "$BACKUP/postgres.sql.gz" \
  | "${DC[@]}" exec -T postgres \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1

echo "[restore] mc mirror -> $MINIO_BUCKET"
"${DC[@]}" run --rm \
  --entrypoint /bin/sh \
  -v "$BACKUP/minio:/snapshot:ro" \
  mc -c "
    set -e
    mc alias set rucord http://minio:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" >/dev/null
    mc mb --ignore-existing \"rucord/$MINIO_BUCKET\" >/dev/null
    mc mirror --quiet --overwrite --remove /snapshot \"rucord/$MINIO_BUCKET\"
  "

echo "[restore] done"
