// Platform boundary: UI never imports Tauri APIs directly.
export type DesktopNotificationPermission = NotificationPermission | "unsupported" | "error";

let cachedPermission: DesktopNotificationPermission | null = null;
let checking: Promise<DesktopNotificationPermission> | null = null;
let requesting: Promise<DesktopNotificationPermission> | null = null;

export function usesNativeNotifications(): boolean {
  return typeof window !== "undefined" &&
    Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export function getCachedNotificationPermission(): DesktopNotificationPermission | null {
  if (!usesNativeNotifications())
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  return cachedPermission;
}

export async function checkNotificationPermission(): Promise<DesktopNotificationPermission> {
  if (!usesNativeNotifications()) return getCachedNotificationPermission()!;
  if (checking) return checking;
  checking = (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const granted = await invoke<boolean | null>("plugin:notification|is_permission_granted");
      cachedPermission = granted === true ? "granted" : granted === false ? "denied" : "default";
    } catch {
      cachedPermission = "error";
    }
    return cachedPermission;
  })().finally(() => { checking = null; });
  return checking;
}

// Call only in response to an explicit user action.
export async function requestNotificationPermission(): Promise<DesktopNotificationPermission> {
  if (requesting) return requesting;
  requesting = (async () => {
    try {
      if (usesNativeNotifications()) {
        const { invoke } = await import("@tauri-apps/api/core");
        const granted = await invoke<boolean | null>("plugin:notification|is_permission_granted");
        const permission = granted ? "granted" : await invoke<string>("plugin:notification|request_permission");
        cachedPermission = permission === "granted" || permission === "denied" ? permission : "default";
      } else if (typeof Notification === "undefined") {
        cachedPermission = "unsupported";
      } else {
        cachedPermission = Notification.permission === "default"
          ? await Notification.requestPermission() : Notification.permission;
      }
    } catch {
      cachedPermission = "error";
    }
    return cachedPermission;
  })().finally(() => { requesting = null; });
  return requesting;
}

export async function showDesktopNotification(
  title: string,
  body: string,
  tag: string,
  onClick: () => void,
): Promise<boolean> {
  if (await checkNotificationPermission() !== "granted") return false;
  try {
    if (usesNativeNotifications()) {
      // The plugin's JS constructor discards the notify promise. Invoke its
      // native command directly so delivery failures are caught here.
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("plugin:notification|notify", { options: { title, body } });
    } else {
      const notification = new Notification(title, { body, tag });
      notification.onclick = () => {
        window.focus();
        onClick();
        notification.close();
      };
    }
    return true;
  } catch {
    return false;
  }
}
