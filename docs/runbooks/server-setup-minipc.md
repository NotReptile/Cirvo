# Настройка мини-ПК под self-host сервер

Гайд: с нуля (предустановленный Win11) до Linux + Docker, готового
принимать RuCord и другие сервисы. Подходит для любого x86-мини-ПК

> Зачем Linux вместо Windows: Docker Desktop под Windows гоняет
> контейнеры в скрытой VM с двойным NAT — это ломает UDP-релей TURN
> (голос/видео в звонках). Нативный Docker на Linux работает с сетью
> хоста напрямую. Плюс Linux-сервер ест меньше RAM и стабильнее 24/7.

---

## 0. Что понадобится

- USB-флешка ≥ 8 ГБ (содержимое сотрётся).
- Монитор + клавиатура для мини-ПК на время установки (дальше — по SSH).
- Доступ к роутеру Keenetic (проброс портов + маршрут через основного
  провайдера, **не** через VPN).

---

## 1. Скачать Ubuntu Server 24.04 LTS

Берём **Server**, не Desktop — без графической оболочки, меньше жрёт,
управляется по SSH.

- Страница: <https://ubuntu.com/download/server>
- Файл: `ubuntu-24.04.x-live-server-amd64.iso` (~2–3 ГБ).
- 24.04 LTS — поддержка до 2029, ядро 6.8 хорошо знает Ryzen 8000-серию.

Альтернатива для любителей минимализма — **Debian 12** (тоже отлично,
чуть консервативнее пакеты). Гайд писан под Ubuntu; для Debian шаги
почти идентичны.

---

## 2. Записать загрузочную флешку

**Windows:** [Rufus](https://rufus.ie) или
[balenaEtcher](https://etcher.balena.io).

- Rufus: выбрать ISO → схема разделов **GPT**, целевая система **UEFI** →
  Старт → режим записи «DD Image» если спросит.

---

## 3. BIOS/UEFI мини-ПК

Воткнуть флешку, включить, жать `Del` или `F7`/`F2` при старте (у BMAX
обычно `Del` для BIOS, `F7` — boot menu).

В BIOS:

- **Secure Boot** → Disabled (Ubuntu умеет с ним работать, но проще
  выключить, чтобы не ловить сюрпризы с драйверами).
- **Boot order** → USB первым, либо просто загрузиться через boot-menu
  (`F7`).
- Сохранить (`F10`) → перезагрузка с флешки.

> Win11 будет полностью стёрт — это ок, лицензия зашита в UEFI, при
> желании вернёшь. Бэкап нужных данных с Win сделай заранее (там вряд ли
> что-то есть на новом ПК).

---

## 4. Установка Ubuntu Server

Установщик текстовый, стрелки + Enter:

1. **Language**: English (меньше багов в логах/гайдах).
2. **Keyboard**: Russian или English по вкусу.
3. **Installation type**: `Ubuntu Server` (не minimized).
4. **Network**: воткни Ethernet — он подхватит DHCP. IP запомнишь позже;
   статику зададим после установки.
5. **Proxy**: пусто.
6. **Mirror**: оставь дефолт.
7. **Storage**:
   - `Use an entire disk` → выбрать внутренний SSD (500 ГБ).
   - **Сними галку** `Set up this disk as an LVM group`? — можно оставить
     LVM (дефолт), он удобен для будущего расширения. Оставь как есть.
   - Если LVM выделил не весь диск (Ubuntu по умолчанию даёт ~100 ГБ
     корню) — на экране summary найди `ubuntu-lv`, нажми Edit и выстави
     максимальный размер (`Max`), иначе половина SSD пропадёт. **Важно.**
   - Confirm → Continue (диск будет отформатирован).
8. **Profile**:
   - Your name: любое.
   - Server name (hostname): например `rucord-server`.
   - Username: например `admin` (это твой Linux-юзер, не путать с
     RuCord-админом).
   - Пароль: надёжный, запомни/запиши.
9. **Upgrade to Ubuntu Pro**: Skip.
10. **SSH Setup**: ✅ **Install OpenSSH server** — обязательно (иначе не
    зайдёшь удалённо). Import SSH key — пропусти, ключ добавим потом.
11. **Featured snaps**: ничего не выбирай (Docker поставим вручную —
    snap-версия Docker глючнее).
12. Установка пойдёт, в конце — `Reboot Now`. Вынь флешку.

---

## 5. Первый вход и базовая настройка

После ребута на экране мини-ПК будет строка вида
`rucord-server login:`. Узнай IP:

```bash
ip -4 addr show | grep inet
```

Запиши LAN-IP (например `192.168.1.50`). Дальше можно отключить
монитор/клаву и зайти с рабочего ПК по SSH:

```bash
ssh admin@192.168.1.50
```

### 5.1 Обновления

```bash
sudo apt update && sudo apt upgrade -y
sudo reboot
```

### 5.2 Статический LAN-IP

Чтобы проброс портов на роутере не «съезжал» при смене DHCP-аренды.
Два варианта — выбери один:

**Вариант A (проще, рекомендую): DHCP-резервация на Keenetic.**
В вебе роутера → список устройств → найди сервер по MAC → «Закрепить
IP-адрес». Готово, на стороне сервера ничего не трогаешь.

**Вариант B: статика через netplan на сервере.**

```bash
sudo nano /etc/netplan/50-cloud-init.yaml
```

Привести к виду (подставь свой интерфейс из `ip a` — обычно `enp1s0`
или `eth0`, и свободный IP вне DHCP-пула):

```yaml
network:
  version: 2
  ethernets:
    enp1s0:
      dhcp4: false
      addresses: [192.168.1.50/24]
      routes:
        - to: default
          via: 192.168.1.1        # IP роутера
      nameservers:
        addresses: [192.168.1.1, 1.1.1.1]
```

```bash
sudo netplan apply
```

### 5.3 SSH по ключу (вместо пароля) — опционально, но желательно

На **рабочем ПК** (Windows PowerShell):

```powershell
ssh-keygen -t ed25519          # если ключа ещё нет
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh admin@192.168.1.50 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

Затем на сервере запретить вход по паролю:

```bash
sudo nano /etc/ssh/sshd_config
# PasswordAuthentication no
sudo systemctl restart ssh
```

### 5.4 Файрвол (ufw)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49160:49200/udp
sudo ufw allow 50000/udp
sudo ufw enable
sudo ufw status
```

(Порты — под RuCord + coturn. Другие сервисы добавишь по мере надобности.)

### 5.5 Авто-обновления безопасности

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades   # выбрать Yes
```

---

## 6. Docker Engine + Compose

**Не** snap, **не** Docker Desktop — официальный Docker Engine:

```bash
# Зависимости
sudo apt update
sudo apt install -y ca-certificates curl gnupg

# GPG-ключ Docker
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Репозиторий
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Установка
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Запускать docker без sudo
sudo usermod -aG docker $USER
newgrp docker   # или перелогиниться

# Проверка
docker run --rm hello-world
docker compose version
```

---

## 7. Роутер Keenetic

1. **Проброс портов** (Переадресация портов) — перенаправить на
   **новый IP сервера** (например `192.168.1.50`), а не на старый
   Windows-ПК:
   - TCP 80, TCP 443 (UDP 443 не нужен: HTTP/3 в Caddyfile отключён)
   - TCP 3478, UDP 3478
   - UDP 49160–49200
   - UDP 50000 (SFU RTP)
2. **Маршрут через основного провайдера, НЕ через VPN**:
   «Приоритеты подключений» → привязать устройство-сервер к профилю с
   основным провайдером (выделенный IP `<PUBLIC_IP>`). Это критично:
   иначе исходящий релей-трафик уйдёт через VPN с чужим source-IP и
   медиа в звонках не дойдёт (см. диагностику в истории проекта).
3. Проверка egress с сервера:

   ```bash
   curl https://api.ipify.org
   ```

   Должно показать `<PUBLIC_IP>` (а не VPN-адрес). Если показывает
   VPN — маршрут ещё не применился.

---

## 8. Деплой RuCord

```bash
sudo apt install -y git
git clone https://github.com/NotReptile/RuCord.git rucord   # приватный репозиторий: нужен токен или SSH-ключ
cd rucord

# Конфиг
cp deploy/.env.example deploy/.env
nano deploy/.env
#   - POSTGRES_PASSWORD, MINIO_*, RUCORD_JWT_SECRET — свои секреты
#   - RUCORD_DOMAIN=chat.example.com
#   - RUCORD_TLS_EMAIL=<твой email>
#   - RUCORD_CORS_ORIGINS=tauri://localhost,http://tauri.localhost,https://tauri.localhost
#   - ICE_TURN_URLS и ICE_TURN_SHARED_SECRET — TURN UDP/TCP + временные credentials
#   - RUCORD_SFU_URL, RUCORD_SFU_PUBLIC_IP, RUCORD_SFU_UDP_PORT=50000
#   - RUCORD_BOOTSTRAP_* — первый админ

# Миграции
docker compose -f deploy/single-node/docker-compose.yml \
  --env-file deploy/.env --profile tools run --rm migrate

# Запуск
docker compose -f deploy/single-node/docker-compose.yml \
  --env-file deploy/.env up -d --build

# Логи
docker compose -f deploy/single-node/docker-compose.yml \
  --env-file deploy/.env logs -f core-api
```

Проверка снаружи: `https://chat.example.com/readyz` → `200`.

> Перенос данных со старого Windows-инстанса (аккаунты, история, файлы) —
> отдельная процедура: `deploy/backup.sh` на старом хосте и `deploy/restore.sh`
> на новом, см. [backup-and-restore.md](backup-and-restore.md).

---

## 9. Динамический IP (duckdns)

IP у duckdns динамический. Нужен апдейтер, чтобы A-запись всегда
указывала на актуальный `<PUBLIC_IP>` (а coturn перечитывал его при
рестарте). Cron на сервере:

```bash
crontab -e
# каждые 5 минут обновлять duckdns
*/5 * * * * curl -fsS "https://www.duckdns.org/update?domains=<ПОДДОМЕН>&token=<ТВОЙ_ТОКЕН>&ip=" >/dev/null 2>&1
```

(пустой `ip=` → duckdns берёт IP из запроса; т.к. сервер ходит через
основного провайдера — это и будет `<PUBLIC_IP>`.)

> coturn резолвит `external-ip` при старте. Если IP сменился — нужен
> `docker compose ... restart coturn`. Автоматический рестарт при смене IP
> не настроен.

---

## 10. Несколько сервисов на одной коробке

RuCord уже за Caddy (reverse-proxy). Другие сервисы вешаются туда же по
поддоменам или путям. Для отдельных поддоменов удобно завести ещё
duckdns-домены и роутить их в Caddyfile на нужные контейнеры. На мини-ПК с
8745HS и 16 ГБ спокойно живёт десяток лёгких сервисов.
