# Engineering Conventions

## Repository

- keep cross-cutting contracts in `libs/contracts`;
- keep shared runtime helpers in `libs/shared-go` and `libs/shared-ts`;
- do not hide environment-specific behavior in code branches when configuration can express it.

## Backend

- keep `core-api` logically modular even while deployed as one process;
- do not read another module's storage directly without a formal contract;
- treat `realtime` as transport infrastructure, not domain authority.

## Database

- schema changes go through numbered migrations;
- seed data must stay technical and environment-scoped;
- relational storage owns canonical domain records.

## Client

- UI stays separate from network and realtime adapters;
- local cache is an optimization, not an authority;
- media integration points stay isolated from generic view code.

## Configuration

- use external configuration for all addresses, secrets, domains and limits;
- support deployment profiles `local`, `single-node` and `internet-facing` without changing code structure;
- support runtime stages `dev`, `test` and `prod` through configuration, not through branch-specific code.
