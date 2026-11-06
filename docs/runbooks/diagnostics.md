# Диагностика и проверка подключения

Порядок: сначала сервер, потом сеть до сервера, потом клиент. Везде ниже
`DOMAIN` — значение `CIRVO_DOMAIN` (например `chat.example.com`).

## 1. Сервер (на Linux-хосте)

```bash
docker compose -f deploy/single-node/docker-compose.yml --env-file deploy/.env ps
docker compose -f deploy/single-node/docker-compose.yml --env-file deploy/.env logs --tail=100 core-api realtime sfu coturn
```

Все сервисы должны быть `Up`, у `postgres`, `redis`, `minio`, `sfu` ещё и `healthy`.
Если `reverse-proxy` не стартует, а `sfu` падает, проверь `CIRVO_SFU_PUBLIC_IP`:
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
Если заголовка нет, добавь origin в `CIRVO_CORS_ORIGINS` и перезапусти `core-api`.

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
| `/readyz` отвечает, а вход падает с CORS-ошибкой | В `CIRVO_CORS_ORIGINS` нет `http://tauri.localhost` | Добавить все три Tauri-оригина, перезапустить `core-api` |
| Из домашней сети домен не открывается, снаружи открывается | Роутер не умеет hairpin NAT | Split-DNS: имя сервера в LAN → LAN-адрес |
| Чат работает, голос не соединяется | Закрыт UDP `50000` или `3478`, либо неверный `CIRVO_SFU_PUBLIC_IP` | Проверить проброс портов и значение IP |
| Голос работает в LAN, снаружи нет | `CIRVO_SFU_PUBLIC_IP` указывает на LAN-адрес | Указать внешний IP |
| «Хранилище файлов временно недоступно» при вложении или вставке скриншота | `core-api` не может подключиться к MinIO | См. раздел «Хранилище файлов» ниже |
| Ошибка сертификата при `CIRVO_TLS_EMAIL=internal` | Корневой сертификат Caddy не установлен в Windows | См. [windows-client.md](windows-client.md), раздел «Самоподписанный сертификат» |

### Хранилище файлов (MinIO)

`core-api` подключается к MinIO лениво и повторяет попытки сам (пауза растёт до
30 секунд), поэтому порядок запуска контейнеров не важен и перезапуск после
восстановления MinIO не нужен. Признаки проблемы:

- клиент пишет «Хранилище файлов временно недоступно»; API отвечает
  `503` с кодом `service_unavailable`;
- `curl -s https://DOMAIN/readyz` возвращает `"storage":"unavailable"`
  (`ready`: всё в порядке, `not_configured`: не заданы `MINIO_*`);
- в логах `core-api` одна строка `object storage unavailable, will retry in background`
  с причиной, а после восстановления `object storage connected`.

```bash
docker compose -f deploy/single-node/docker-compose.yml --env-file deploy/.env ps minio
docker compose -f deploy/single-node/docker-compose.yml --env-file deploy/.env logs --tail=100 minio
docker compose -f deploy/single-node/docker-compose.yml --env-file deploy/.env logs core-api | grep "object storage"
```

Если `minio` не `healthy`, смотри его логи (место на диске, права на том,
неверные учётные данные) и подними его: `up -d minio`. Если `storage` равен
`not_configured`, задай `MINIO_*` в `deploy/.env` по `deploy/.env.example` и
пересоздай `core-api`.

## 5. Группы отказов

- ошибки авторизации (`401`, `403 account banned`);
- обрыв WebSocket (`/ws`, `/sfu/ws`): смотри логи `realtime` и `sfu`;
- расхождение миграций: после `git pull` не выполнен `run --rm migrate`;
- не настроено объектное хранилище (`MINIO_*`): не грузятся вложения;
- недоступен Redis: сообщения идут, но не доставляются в реальном времени.

## 6. Демонстрация экрана: рывки и задержка

Живая статистика: «Настройки → Голос и видео → Демонстрация экрана → Диагностика
потока» (обновляется раз в секунду во время демонстрации или просмотра чужой).
Что смотреть:

| Показатель | Норма | Что значит отклонение |
| --- | --- | --- |
| FPS отправки | близко к пресету (60 для `1080p60`) | заметно ниже при `ограничение: none`: узкое место в захвате экрана; попробуй «Захват экрана → Системный» |
| `ограничение` | `none` | `cpu`: кодек не успевает (снизь пресет или смени кодек); `bandwidth`: браузер урезает качество из-за канала |
| Канал ≈ | выше битрейта пресета | ниже потолка: упираемся в сеть до сервера |
| Кодирование, мс/кадр | меньше 1000/FPS (16 мс для 60) | иначе кодек не тянет FPS |
| Потери, % (приём) | 0 | больше 2%: рывки из-за сети |
| Буфер джиттера, мс (приём) | до ~100 | растёт при нестабильной доставке и прибавляет задержку |
| RTT | единицы мс в LAN | больше 100 мс: проблема сети, не картинки |

Сервер (SFU): для потоков 1440p60 (до 18 Мбит/с) на Linux-хосте стоит поднять лимит
буфера UDP-сокета, иначе пакеты теряются в ядре:
`sysctl -w net.core.rmem_max=8388608 net.core.wmem_max=8388608`. SFU сам запрашивает
буферы по 8 МБ, ядро ограничивает их этими значениями. Новых портов и переменных
окружения нет.
