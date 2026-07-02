# Static IP HTTP mode

Этот режим нужен для личного теста без домена: друзья подключаются к серверу
по статическому IP.

Адрес для клиентов:

```text
http://<STATIC_IP>
```

Для текущего сервера:

```text
http://<PUBLIC_IP>
```

Важно: это HTTP без TLS. Для теста с друзьями допустимо, особенно если доступ
ограничен VPN/фаерволом. Для постоянного публичного сервера лучше перейти на
домен + HTTPS или отдельно настраивать сертификат для IP.

## Запуск из VSCode

1. Выполнить task `Stop All`.
2. Выполнить task `Run Desktop Static IP`.
3. В клиенте указать `<PUBLIC_IP>` или явно `http://<PUBLIC_IP>`.

Task `Run Desktop Static IP` делает следующее:

- поднимает локальную Docker-инфру;
- применяет миграции;
- запускает HTTP reverse proxy на `:80`;
- запускает `core-api`, `realtime`, `worker`;
- запускает desktop-клиент через `tauri dev`.

Proxy принимает один публичный HTTP endpoint и маршрутизирует:

- `/readyz`, `/healthz`, `/api/*` -> `core-api:8080`;
- `/ws` -> `realtime:8090`.

## Проверка на серверном ПК

```powershell
Invoke-WebRequest http://127.0.0.1/readyz -UseBasicParsing
Invoke-WebRequest http://127.0.0.1/healthz -UseBasicParsing
```

Ожидаемо: `StatusCode: 200`.

## Проверка снаружи

С другого интернета или VPN-клиента:

```powershell
Invoke-WebRequest http://<PUBLIC_IP>/readyz -UseBasicParsing
```

Если локально `127.0.0.1` отвечает, а публичный IP дает timeout, проблема не в
приложении. Проверить:

- на роутере проброшен TCP `80` на LAN-IP серверного ПК;
- Windows Firewall разрешает входящий TCP `80`;
- серверный ПК действительно выходит через основной интернет со статическим IP,
  а не через VPN;
- провайдер/роутер не блокирует входящие подключения на `80`.

Команда для Windows Firewall запускать в PowerShell от администратора:

```powershell
New-NetFirewallRule `
  -DisplayName "LVC Public HTTP 80" `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort 80
```

## Что вводить в клиенте

Новая версия клиента:

- `<PUBLIC_IP>` автоматически нормализует в `http://<PUBLIC_IP>`;
- `chat.example.com` автоматически нормализует в `https://chat.example.com`;
- явные `http://...` и `https://...` сохраняются как введены.

