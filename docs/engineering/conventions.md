# Engineering Conventions

## Repository

- keep cross-cutting contracts in `libs/contracts`;
- keep shared runtime helpers in `libs/shared-go` and `libs/shared-ts`;
- do not hide environment-specific behavior in code branches when configuration can express it;
- HTTP API: источник истины - код маршрутов `core-api`, а не `libs/contracts/http/openapi.yaml` (спецификация неполная, см. [API overview](../api/overview.md)).

## Backend

- keep `core-api` logically modular even while deployed as one process;
- do not read another module's storage directly without a formal contract;
- treat `realtime` as transport infrastructure, not domain authority;
- проверки прав - только через `permission.Authorize` / `AuthorizeChannel` с новой `permission.Action`, без inline-сравнения ролей;
- `sfu` не принимает решений о доступе: ACL voice-канала остаётся в `core-api`, SFU проверяет только тикет, живую сессию и участие в `channel_participants`.

## Database

- schema changes go through numbered migrations;
- domain-level bootstrap (first admin, default workspace) is provisioned by `core-api/internal/bootstrap` from env, not committed as SQL seed;
- relational storage owns canonical domain records.

## Client

- UI stays separate from network and realtime adapters;
- local cache is an optimization, not an authority;
- media integration points stay isolated from generic view code;
- `@tauri-apps/*` импортируется только в тонких адаптерах с web-fallback (`tauri*.ts`, `call/screenAudio.ts`), лениво и после проверки `__TAURI_INTERNALS__`; бизнес-логика Tauri не видит. Подробности: [client-architecture.md](../architecture/client-architecture.md).

## Configuration

- use external configuration for all addresses, secrets, domains and limits;
- поддерживаемые профили деплоя - `local` и `single-node`, без изменения структуры кода; публичный деплой - это `single-node` (см. [environments.md](../deployment/environments.md));
- support runtime stages `dev`, `test` and `prod` through configuration, not through branch-specific code. Сейчас код по `RUCORD_STAGE` не ветвится, а по `RUCORD_ENV` различает только `production` в `sfu`.
