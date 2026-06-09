// F.8: auto-update через `tauri-plugin-updater`. Манифест latest.json
// (подписанный Tauri-keypair'ом) раздаётся из GitHub Releases — endpoint
// задан в tauri.conf.json. Web-сборка / mobile / dev без плагина / битая
// подпись — тихий no-op: checkForUpdate() возвращает null, UI ничего
// не показывает.
//
// Бизнес-логика (ui.ts) видит только абстракцию UpdateHandle — прямых
// импортов @tauri-apps/* там нет (правило из «Решений» TASKS.md).

export interface UpdateHandle {
  version: string;
  notes: string | null;
  /** Скачивает и устанавливает. onProgress: 0..100 либо null (размер неизвестен). */
  install(onProgress: (pct: number | null) => void): Promise<void>;
}

let updaterPromise: Promise<typeof import("@tauri-apps/plugin-updater") | null> | null = null;

async function loadUpdater(): Promise<typeof import("@tauri-apps/plugin-updater") | null> {
  if (updaterPromise) return updaterPromise;
  updaterPromise = (async () => {
    if (typeof window === "undefined") return null;
    const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
    if (!w.__TAURI_INTERNALS__) return null;
    try {
      return await import("@tauri-apps/plugin-updater");
    } catch (err) {
      console.info("[updater] плагин не загрузился (web/mobile?):", err);
      return null;
    }
  })();
  return updaterPromise;
}

export async function checkForUpdate(): Promise<UpdateHandle | null> {
  const plugin = await loadUpdater();
  if (!plugin) return null;
  try {
    const update = await plugin.check();
    if (!update) return null;
    console.info(`[updater] доступно обновление ${update.version} (текущая ${update.currentVersion})`);
    return {
      version: update.version,
      notes: update.body ?? null,
      async install(onProgress) {
        let total: number | null = null;
        let downloaded = 0;
        await update.downloadAndInstall((event) => {
          switch (event.event) {
            case "Started":
              total = event.data.contentLength ?? null;
              onProgress(total ? 0 : null);
              break;
            case "Progress":
              downloaded += event.data.chunkLength;
              onProgress(total ? Math.min(100, Math.round((downloaded / total) * 100)) : null);
              break;
            case "Finished":
              onProgress(100);
              break;
          }
        });
      }
    };
  } catch (err) {
    // Нет сети / пустой pubkey (keypair ещё не сгенерирован) / релиза нет —
    // всё это штатные кейсы self-host'а, не пугаем юзера.
    console.info("[updater] проверка обновлений не удалась:", err);
    return null;
  }
}

// Перезапуск после установки. На Windows NSIS-инсталлер сам убивает процесс,
// поэтому relaunch может не успеть выполниться — это нормально.
export async function relaunchApp(): Promise<void> {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (!w.__TAURI_INTERNALS__) return;
  try {
    const proc = await import("@tauri-apps/plugin-process");
    await proc.relaunch();
  } catch (err) {
    console.warn("[updater] relaunch не удался:", err);
  }
}
