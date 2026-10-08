# syntax=docker/dockerfile:1
#
# MinIO и клиент mc собираются из исходников на закреплённых коммитах:
# репозитории minio/minio и minio/mc заархивированы, а публичные образы
# (minio/minio, minio/mc, quay.io/minio/minio) больше не отдаются анонимно.
#
# Коммиты лежат в файлах MINIO_REF и MC_REF рядом с этим Dockerfile. Их же
# читает CI (.github/workflows/smoke.yml), поэтому версия одна на всех.
# Это те же коммиты, что на боевом сервере.
#
# Цели сборки:
#   minio - сервер объектного хранилища (compose: сервис minio)
#   mc    - клиент для deploy/backup.sh и deploy/restore.sh (compose: сервис mc)
#
# Внимание: апстрим в архиве, обновлений безопасности не будет. Замена на
# поддерживаемое S3-хранилище стоит в планах (см. docs/runbooks/single-node.md).

ARG GO_VERSION=1.26

FROM golang:${GO_VERSION}-bookworm AS build-minio
ENV CGO_ENABLED=0 GOWORK=off
COPY MINIO_REF /refs/MINIO_REF
RUN go install "github.com/minio/minio@$(tr -d '\r\n' < /refs/MINIO_REF)"

FROM golang:${GO_VERSION}-bookworm AS build-mc
ENV CGO_ENABLED=0 GOWORK=off
COPY MC_REF /refs/MC_REF
RUN go install "github.com/minio/mc@$(tr -d '\r\n' < /refs/MC_REF)"

FROM debian:bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS minio
COPY --from=build-minio /go/bin/minio /usr/local/bin/minio
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/data"]

FROM base AS mc
COPY --from=build-mc /go/bin/mc /usr/local/bin/mc
ENTRYPOINT ["/usr/local/bin/mc"]
