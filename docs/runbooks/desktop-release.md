# Desktop release: сборка exe и обновления

Релизный пайплайн desktop-клиента: тег `v*` → GitHub Actions собирает
Windows-установщики и кладёт их в **draft**-релиз. Ты проверяешь файлы и
нажимаешь Publish.

## Текущее состояние

| Что | Статус |
| --- | --- |
| Workflow `desktop-release.yml` | Готов. По умолчанию собирает только Windows (`.msi` и NSIS `.exe`) |
| Ключ подписи обновлений | Создан. Публичная часть записана в `tauri.conf.json` → `plugins.updater.pubkey` |
| Secrets `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Добавлены в репозиторий |
| Репозиторий | **Приватный** |
| Авто-обновление у пользователей | Через `/updates/latest.json` выбранного сервера, с авторизацией RuCord |
| Подпись exe (Authenticode) | Нет. SmartScreen покажет предупреждение |
| Опубликованные релизы | Список в GitHub Releases; собираются из проверенного тега |

### Обновления при приватном репозитории

Первый установщик передаётся вручную либо скачивается участником приватного
репозитория. Последующие обновления клиент получает с выбранного HTTPS-сервера:
`/updates/latest.json`. Манифест и файлы установщика защищены проверкой сессии
RuCord. GitHub-токен в клиенте не нужен.

Оператор копирует подписанный NSIS-установщик и `.sig` из релиза на сервер,
затем запускает `python3 deploy/prepare-desktop-update.py --release-dir <DIR>
--output-dir <DIR> --base-url https://chat.example.com`. Скрипт создаёт
`latest.json` с URL и подписью. Для отдельного внешнего адреса подготовь второй
манифест с его HTTPS-адресом; URL установщика обязан иметь тот же origin.
Пример защищённого маршрута: `deploy/single-node/Caddyfile.updates.example`.
Сначала размести установщик, затем атомарно замени манифест.

Нативный updater использует доверие ОС и проверяет криптографическую подпись
установщика по закреплённому публичному ключу. При ошибке сети, авторизации
или подписи обновление не устанавливается. Ручная установка новой версии поверх
старой остаётся доступна.

## Ключ подписи обновлений

Ключ создан командой `npm run tauri signer generate`. Приватный ключ и пароль
лежат **вне репозитория**, на компьютере разработчика, в `%USERPROFILE%\.tauri\`
(`rucord.key`, `rucord.key.password`). Публичный ключ — `rucord.key.pub`.

> Приватный ключ потерять нельзя. Без него нельзя выпустить обновление,
> которое примут уже установленные клиенты: придётся выпускать новый ключ и
> просить всех переустановить приложение. Сделай копию в менеджер паролей.

Чтобы заменить ключ (например, при утечке):

```powershell
cd apps/desktop
npm run tauri signer generate -- -w $HOME/.tauri/rucord.key
```

Затем вписать новый публичный ключ в `tauri.conf.json`, обновить два Secrets
(`gh secret set TAURI_SIGNING_PRIVATE_KEY < $HOME/.tauri/rucord.key`) и выпустить
релиз. Клиенты со старым ключом обновление не примут.

## Выпуск релиза

1. Поднять версию в **трёх** файлах (должны совпадать, workflow проверяет это
   и падает при расхождении):
   - `apps/desktop/package.json` → `version`;
   - `apps/desktop/src-tauri/tauri.conf.json` → `version`;
   - `apps/desktop/src-tauri/Cargo.toml` → `version`.
2. Дописать изменения в [CHANGELOG.md](../../CHANGELOG.md).
3. Закоммитить, влить в `main`, затем поставить тег:

   ```powershell
   git tag v0.1.1
   git push origin v0.1.1
   ```

4. Actions → `desktop-release` собирает Windows-установщик (около 15–25 минут).
5. В Releases появится **draft** «RuCord v0.1.1» с файлами `RuCord_0.1.1_x64-setup.exe`,
   `RuCord_0.1.1_x64_en-US.msi`, `.sig` и `latest.json`.
6. Скачать `.exe`, поставить на чистую машину, убедиться, что запускается и
   подключается к серверу (см. [windows-client.md](windows-client.md)).
7. Нажать **Publish release**.

### Пробная сборка без релиза для пользователей

Сначала создай тег вида `v0.1.1-test` на нужном коммите и отправь его в репозиторий.
Теги с суффиксом после `-` автоматически **не** собираются, поэтому сборка не
стартует сама. Actions → `desktop-release` → **Run workflow**. Укажи этот
существующий тег и отметь `prerelease`. Суффикс при проверке версии
отбрасывается, а релиз остаётся черновиком. Чтобы собрать ещё и macOS с Linux,
выбери `platforms = all`. Минуты macOS в приватном репозитории считаются с
множителем ×10.

При ручном запуске исходники берутся из указанного тега независимо от выбранной
ветки. Если поле `tag` пустое, нужно выбрать тег при запуске. Пустое поле или
несуществующий тег останавливают запуск на первом шаге с понятной ошибкой;
повторный запуск с `platforms = all` использует тот же тег, что и первоначальная
Windows-сборка.

## Как друзьям получить установщик (пока репозиторий приватный)

- Добавить их в репозиторий как collaborators (`Settings → Collaborators`) с
  правом Read. Тогда они скачают `.exe` со страницы Releases.
- Либо скачать установщик самому и передать файл напрямую (облако, флешка).
  Приложите SHA-256: `Get-FileHash RuCord_0.1.1_x64-setup.exe`.

## Установка на Windows

- Установщик `perMachine`: нужны права администратора.
- SmartScreen предупредит о неизвестном издателе: **Подробнее → Выполнить в любом случае**.
  Чтобы убрать предупреждение, нужен платный сертификат подписи кода.
- Нужен WebView2 Runtime. В Windows 11 он есть, в Windows 10 установщик докачает его сам.

## Локальная сборка

Требования: Rust stable, MSVC Build Tools, Node.js 20.19+ (или 22.12+).
`createUpdaterArtifacts: true` требует приватный ключ и при локальном
`npm run tauri build`:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $HOME/.tauri/rucord.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Get-Content $HOME/.tauri/rucord.key.password -Raw
cd apps/desktop
npm run tauri build
```

Результат: `apps/desktop/src-tauri/target/release/bundle/nsis/RuCord_<версия>_x64-setup.exe`
и `bundle/msi/`. `npm run tauri dev` ключа не требует.

## Что не настроено

- **Windows Authenticode.** Нужен сертификат подписи кода (платный) и шаг
  signtool в workflow.
- **macOS notarization.** Нужен Apple Developer ID ($99 в год) и шаг notarytool.
- **Установка следующей версии через updater.** Для полного прогона нужна
  следующая подписанная версия на сервере. Проверка manifest и подписи файла
  отдельно не доказывает успешную замену установленного приложения.
