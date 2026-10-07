# Документация RuCord

Этот каталог: версионируемый источник правды по технической документации.
Язык: основные руководства (runbook'и, README, audit) на русском, часть
архитектурных заметок на английском.

Корневые файлы: [README.md](../README.md) (быстрый старт),
[AGENTS.md](../AGENTS.md) (правила для ИИ-агентов), [CHANGELOG.md](../CHANGELOG.md),
[CONTRIBUTING.md](../CONTRIBUTING.md), [SECURITY.md](../SECURITY.md).

## Оператору сервера

| Документ | Для чего |
| --- | --- |
| [runbooks/single-node.md](runbooks/single-node.md) | Развёртывание на одной Linux-машине (основной режим) |
| [runbooks/server-setup-minipc.md](runbooks/server-setup-minipc.md) | Подготовка мини-ПК под сервер: ОС, Docker, firewall, DNS |
| [runbooks/backup-and-restore.md](runbooks/backup-and-restore.md) | Бэкап и восстановление |
| [runbooks/diagnostics.md](runbooks/diagnostics.md) | Проверка подключения и разбор типичных отказов |
| [`../deploy/.env.example`](../deploy/.env.example) | Справочник переменных окружения |

## Пользователю и тестировщику клиента

| Документ | Для чего |
| --- | --- |
| [runbooks/windows-client.md](runbooks/windows-client.md) | Установка клиента на Windows, подключение к серверу |
| [runbooks/public-vpn-manual-test-checklist.md](runbooks/public-vpn-manual-test-checklist.md) | Подробный ручной тест с двумя компьютерами |
| [runbooks/desktop-release.md](runbooks/desktop-release.md) | Как собрать exe и выпустить релиз |

## Разработчику

| Документ | Для чего |
| --- | --- |
| [runbooks/local-development.md](runbooks/local-development.md) | Локальная разработка |
| [architecture/overview.md](architecture/overview.md) | Границы сервисов, runtime composition |
| [architecture/monorepo-structure.md](architecture/monorepo-structure.md) | Структура репозитория |
| [architecture/backend-modules.md](architecture/backend-modules.md) | Модули `core-api` и правила зависимостей |
| [architecture/client-architecture.md](architecture/client-architecture.md) | Слои десктоп-клиента |
| [architecture/realtime-and-calls.md](architecture/realtime-and-calls.md) | Realtime, сигналинг и медиа |
| [database/domain-model.md](database/domain-model.md) | Модель данных |
| [database/migrations-strategy.md](database/migrations-strategy.md) | Миграции и bootstrap |
| [api/overview.md](api/overview.md) | HTTP-контракты |
| [security/overview.md](security/overview.md) | Auth, сессии, права, секреты |
| [deployment/environments.md](deployment/environments.md) | Окружения local и single-node |
| [engineering/conventions.md](engineering/conventions.md) | Соглашения репозитория |
| [adr/](adr/) | Записи архитектурных решений, в том числе [SFU и медиа-путь](adr/adr-sfu-media-path.md) |
| [`../libs/contracts/README.md`](../libs/contracts/README.md) | Контракты между сервисами |

## Исходное ТЗ

| Документ | Для чего |
| --- | --- |
| [tz_communication_platform_architecture.md](tz_communication_platform_architecture.md) | Исходное ТЗ (март 2026). Не as-built: актуальное состояние смотри в `architecture/` |

## Устаревшие и исторические материалы

- [runbooks/internet-facing.md](runbooks/internet-facing.md): профиль `internet-facing` не поддерживается.
- [runbooks/static-ip-http.md](runbooks/static-ip-http.md): тест по HTTP на голом IP, сервер был на Windows.
