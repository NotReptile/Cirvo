#!/usr/bin/env bash
# Backup для single-node deploy: pg_dump + mc mirror MinIO бакета.
#
# Использование:
#   deploy/backup.sh [output-dir]
#
# По умолчанию пишет в `./backups/<UTC-timestamp>/`. Внутри:
#   postgres.sql.gz   — pg_dump --clean --if-exists, gzip
#   minio/            — снапшот объектов из MINIO_BUCKET
#   manifest.txt      — версия, дата, имена объектов БД и хранилища
#
# Зависимости: docker, docker compose, bash, gzip. Запускать со стороны
# хоста, где поднят `deploy/single-node/docker-compose.yml`. Контейнеры
# `postgres` и `minio` должны быть в состоянии Up.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${RUCORD_BACKUP_ENV_FILE:-$ROOT/deploy/.env}"
COMPOSE_FILE="${RUCORD_BACKUP_COMPOSE_FILE:-$ROOT/deploy/single-node/docker-compose.yml}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "backup: $ENV_FILE not found" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

POSTGRES_DB="${POSTGRES_DB:-rucord}"
POSTGRES_USER="${POSTGRES_USER:-rucord}"
MINIO_BUCKET="${MINIO_BUCKET:-rucord}"

OUT_ROOT="${1:-$ROOT/backups}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_ROOT/$TS"
mkdir -p "$OUT/minio"

DC=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
if [[ -n "${RUCORD_BACKUP_COMPOSE_OVERRIDE:-}" ]]; then
  DC+=(-f "$RUCORD_BACKUP_COMPOSE_OVERRIDE")
fi

echo "[backup] target: $OUT"

echo "[backup] pg_dump $POSTGRES_DB"
"${DC[@]}" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges \
  | gzip > "$OUT/postgres.sql.gz"

echo "[backup] mc mirror $MINIO_BUCKET"
"${DC[@]}" run --rm \
  --entrypoint /bin/sh \
  -v "$OUT/minio:/snapshot" \
  mc -c "
    set -e
    mc alias set rucord http://minio:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" >/dev/null
    mc mirror --quiet --overwrite \"rucord/$MINIO_BUCKET\" /snapshot
  "

{
  echo "rucord-backup version=1"
  echo "created_at=$TS"
  echo "postgres_db=$POSTGRES_DB"
  echo "minio_bucket=$MINIO_BUCKET"
} > "$OUT/manifest.txt"

echo "[backup] done: $OUT"
