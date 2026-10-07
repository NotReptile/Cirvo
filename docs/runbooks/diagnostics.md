# Диагностика и проверка подключения

Порядок: сначала сервер, потом сеть до сервера, потом клиент. Везде ниже
`DOMAIN` — значение `RUCORD_DOMAIN` (например `chat.example.com`).

## 1. Сервер (на Linux-хосте)

```bash
docker compose -f deploy/single-node/docker-compose.yml --env-file deploy/.env ps
docker compose -f deploy/single-node/docker-compose.yml --env-file deploy/.env logs --tail=100 core-api realtime sfu coturn
```

Все сервисы должны быть `Up`, у `postgres`, `redis`, `minio`, `sfu` ещё и `healthy`.
Если `reverse-proxy` не стартует, а `sfu` падает, проверь `RUCORD_SFU_PUBLIC_IP`:
в production SFU без него не запускается, а Caddy ждёт SFU.

## 2. HTTP, TLS и CORS (с любого компьютера)

```bash
curl -s https://DOMAIN/healthz     # {"service":"core-api","status":"ok"}
curl -s https://DOMAIN/readyz      # {"module":"system","status":"ready"}
```

Без `-k`: если curl ругается на сертификат, клиент тоже не подключится.
Срок сертификата Let's Encrypt:

```bash
echo | openssl s_client -connect DOMAIN:443 -servername DOMAIN 2>/dev/null | openssl x509 -noout -issuer -enddate
```

Проверка CORS для Windows-клиента (WebView2 ходит с `http://tauri.localhost`):

```bash
curl -i -X OPTIONS https://DOMAIN/api/v1/auth/login \
  -H "Origin: http://tauri.localhost" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type,authorization"
```

Ожидаем `204` и заголовок `Access-Control-Allow-Origin: http://tauri.localhost`.
Если заголовка нет, добавь origin в `RUCORD_CORS_ORIGINS` и перезапусти `core-api`.

## 3. Windows-компьютер пользователя

```powershell
Test-NetConnection DOMAIN -Port 443
Invoke-WebRequest https://DOMAIN/readyz -UseBasicParsing
```

`Test-NetConnection` проверяет только TCP. Порты `3478` и `50000/udp` (голос)
он не проверит. Для них используй встроенную проверку: админка → Метрики →
«Проверить STUN/TURN».

## 4. Типичные симптомы

| Симптом | Вероятная причина | Что делать |
| --- | --- | --- |
| «Не удалось подключиться: Failed to fetch» на первом экране | CORS, недоверенный сертификат, DNS или закрыт 443 | Пройти пункты 2 и 3 по порядку |
| `/readyz` отвечает, а вход падает с CORS-ошибкой | В `RUCORD_CORS_ORIGINS` нет `http://tauri.localhost` | Добавить все три Tauri-оригина, перезапустить `core-api` |
| Из домашней сети домен не открывается, снаружи открывается | Роутер не умеет hairpin NAT | Split-DNS: имя сервера в LAN → LAN-адрес |
| Чат работает, голос не соединяется | Закрыт UDP `50000` или `3478`, либо неверный `RUCORD_SFU_PUBLIC_IP` | Проверить проброс портов и значение IP |
| Голос работает в LAN, снаружи нет | `RUCORD_SFU_PUBLIC_IP` указывает на LAN-адрес | Указать внешний IP |
| Ошибка сертификата при `RUCORD_TLS_EMAIL=internal` | Корневой сертификат Caddy не установлен в Windows | См. [windows-client.md](windows-client.md), раздел «Самоподписанный сертификат» |

## 5. Группы отказов

- ошибки авторизации (`401`, `403 account banned`);
- обрыв WebSocket (`/ws`, `/sfu/ws`): смотри логи `realtime` и `sfu`;
- расхождение миграций: после `git pull` не выполнен `run --rm migrate`;
- не настроено объектное хранилище (`MINIO_*`): не грузятся вложения;
- недоступен Redis: сообщения идут, но не доставляются в реальном времени.
