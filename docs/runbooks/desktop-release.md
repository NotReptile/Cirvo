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
| Авто-обновление у пользователей | **Не работает, пока репозиторий приватный** (см. ниже) |
| Подпись exe (Authenticode) | Нет. SmartScreen покажет предупреждение |
| Опубликованные релизы | Пока нет |

### Почему авто-обновление не работает в приватном репозитории

Клиент проверяет `https://github.com/NotReptile/RuCord/releases/latest/download/latest.json`.
Для приватного репозитория без авторизации GitHub отвечает 404, и клиент
молча пропускает проверку. Скачать установщик со страницы Releases тоже могут
только участники репозитория.

Пока репозиторий приватный, обновления ставятся **вручную**: новый
`RuCord_x.y.z_x64-setup.exe` запускается поверх старой версии. Выбор пути на будущее:

1. Сделать репозиторий публичным: updater заработает без изменений. Перед
   публикацией просканируй историю git на секреты (`gitleaks detect`), добавь
   `LICENSE` и включи Secret scanning и Push protection в настройках репозитория.
2. Раздавать `latest.json` и установщик с собственного сервера (путь в Caddy)
   и поменять `plugins.updater.endpoints` в `tauri.conf.json`.

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
Actions → `desktop-release` → **Run workflow**. Укажи этот существующий тег и
отметь `prerelease`. Суффикс после `-` при проверке версии отбрасывается, а
релиз остаётся черновиком. Чтобы собрать ещё и macOS с Linux, выбери
`platforms = all`. Минуты macOS в приватном репозитории считаются с множителем ×10.

При ручном запуске исходники берутся из указанного тега независимо от выбранной
ветки. Если поле `tag` пустое, нужно выбрать тег при запуске. Несуществующий тег
остановит сборку на checkout; повторный запуск с `platforms = all` использует
тот же тег, что и первоначальная Windows-сборка.

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
- **Проверка обновления на живом клиенте.** Цепочка v0.1.1 → v0.1.2 не
  прогонялась: она заработает только после публикации репозитория или
  переноса `latest.json` на свой сервер.
