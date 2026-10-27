# Security Policy

English | [Русский](#политика-безопасности)

## Supported versions

Security fixes are provided only for the latest release and the `main` branch. Older versions are not patched; please update first.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub: **Security → Report a vulnerability**, or directly at
<https://github.com/NotReptile/Cirvo/security/advisories/new>.

Please include:

- a description of the vulnerability and its impact;
- steps to reproduce (a minimal proof of concept helps);
- affected component (`core-api`, `realtime`, `sfu`, `worker`, desktop client, deployment files) and version or commit;
- your environment (OS, client or server, relevant configuration);
- any suggested fix, if you have one.

Do not include real tokens, passwords or other secrets of third parties.

What to expect: we aim to acknowledge your report within 7 days, assess severity, and agree on a fix and disclosure timeline with you. Please do not disclose details publicly until a fix is released.

## Scope

In scope:

- authentication or authorization bypass, including RBAC and channel access checks;
- access to other users' messages or attachments;
- leaking of tokens, passwords or keys;
- remote code execution in the services or the client;
- rate-limit bypass that enables password brute-forcing.

Out of scope: vulnerabilities in third-party software that Cirvo does not ship or configure (report them upstream), attacks requiring physical access to the server or an already compromised administrator account, and misconfigurations of your own deployment (for example default or leaked secrets).

## For server operators

- Set your own values for `CIRVO_JWT_SECRET`, `POSTGRES_PASSWORD`, `MINIO_ROOT_*`, `ICE_TURN_SHARED_SECRET` and the first administrator's password. Never keep the defaults from `deploy/.env.example`.
- Never publish or commit `deploy/.env`.
- Do not leave `CIRVO_CORS_ORIGINS` empty or set to `*` in production.
- Expose only the ports listed in the [single-node runbook](docs/runbooks/single-node.md).

The security model is described in [docs/security/overview.md](docs/security/overview.md) (in Russian).

---

# Политика безопасности

[English](#security-policy) | Русский

## Поддерживаемые версии

Исправления безопасности выпускаются только для последнего релиза и ветки `main`. Старые версии не исправляются: сначала обновитесь.

## Как сообщить об уязвимости

**Не создавайте публичный issue.** Сообщайте приватно через GitHub: **Security → Report a vulnerability** или сразу по ссылке
<https://github.com/NotReptile/Cirvo/security/advisories/new>.

Что указать в отчёте:

- описание уязвимости и её последствий;
- шаги воспроизведения (поможет минимальный пример);
- затронутый компонент (`core-api`, `realtime`, `sfu`, `worker`, десктоп-клиент, файлы развёртывания) и версию или коммит;
- окружение (ОС, клиент или сервер, значимая конфигурация);
- предлагаемое исправление, если оно есть.

Не прикладывайте реальные токены, пароли и другие секреты третьих лиц.

Чего ожидать: мы стремимся подтвердить получение отчёта в течение 7 дней, оценить серьёзность и согласовать с вами исправление и сроки раскрытия. Пожалуйста, не публикуйте подробности, пока исправление не выпущено.

## Что считается уязвимостью

В области действия:

- обход аутентификации или проверки прав, включая RBAC и доступ к каналам;
- доступ к чужим сообщениям или вложениям;
- утечка токенов, паролей или ключей;
- удалённое выполнение кода в сервисах или клиенте;
- обход ограничений rate limit, позволяющий перебирать пароли.

Вне области действия: уязвимости стороннего ПО, которое Cirvo не поставляет и не настраивает (сообщайте разработчикам этого ПО), атаки, требующие физического доступа к серверу или уже скомпрометированной учётной записи администратора, и ошибки конфигурации вашего развёртывания (например, дефолтные или утёкшие секреты).

## Если вы оператор сервера

- Задайте собственные значения `CIRVO_JWT_SECRET`, `POSTGRES_PASSWORD`, `MINIO_ROOT_*`, `ICE_TURN_SHARED_SECRET` и пароль первого администратора. Не оставляйте значения по умолчанию из `deploy/.env.example`.
- Никогда не публикуйте и не коммитьте `deploy/.env`.
- Не оставляйте `CIRVO_CORS_ORIGINS` пустым или равным `*` в production.
- Открывайте наружу только порты из [single-node runbook](docs/runbooks/single-node.md).

Модель безопасности описана в [docs/security/overview.md](docs/security/overview.md).
