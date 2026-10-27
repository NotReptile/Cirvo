// Обновления с выбранного Cirvo-сервера: /updates/latest.json и установщик
// требуют активную сессию. Подпись проверяет нативный tauri-plugin-updater.
// Web-сборка / mobile / dev без плагина / битая
// подпись — тихий no-op: checkForUpdate() возвращает null, UI ничего
// не показывает.
//
// Бизнес-логика (ui.ts) видит только абстракцию UpdateHandle — прямых
// импортов @tauri-apps/* там нет.

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

export async function checkForUpdate(serverUrl: string, accessToken: string | null): Promise<UpdateHandle | null> {
  const plugin = await loadUpdater();
  if (!plugin) return null;
  try {
    if (!accessToken || !serverUrl.startsWith("https://")) return null;
    const { invoke, Channel } = await import("@tauri-apps/api/core");
    const update = await invoke<{ version: string; notes: string | null } | null>("check_server_update", { serverUrl, accessToken });
    if (!update) return null;
    console.info(`[updater] доступно обновление ${update.version}`);
    return {
      version: update.version,
      notes: update.notes,
      async install(onProgress) {
        const progress = new Channel<number | null>();
        progress.onmessage = onProgress;
        await invoke("install_server_update", { progress });
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
