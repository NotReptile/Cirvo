import { beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-notification", () => plugin);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string, args: any) => {
  if (command.endsWith("is_permission_granted")) return plugin.isPermissionGranted();
  if (command.endsWith("request_permission")) return plugin.requestPermission();
  if (command.endsWith("notify")) return plugin.sendNotification(args.options);
  throw new Error(`Unexpected command: ${command}`);
} }));

describe("desktop notification platform adapter", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    plugin.isPermissionGranted.mockResolvedValue(true);
    plugin.requestPermission.mockResolvedValue("granted");
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, focus: vi.fn() });
    vi.stubGlobal("Notification", class { static permission = "denied"; });
  });

  it("checks native permission without prompting or consulting browser denial", async () => {
    const adapter = await import("./tauriNotifications");
    expect(await adapter.checkNotificationPermission()).toBe("granted");
    expect(plugin.requestPermission).not.toHaveBeenCalled();
    expect(adapter.getCachedNotificationPermission()).toBe("granted");
  });

  it("sends native notifications even when WebView browser permission is denied", async () => {
    const adapter = await import("./tauriNotifications");
    expect(await adapter.showDesktopNotification("Actor", "Message", "id", vi.fn())).toBe(true);
    expect(plugin.sendNotification).toHaveBeenCalledExactlyOnceWith({ title: "Actor", body: "Message" });
  });

  it("does not prompt or send when native permission is unavailable", async () => {
    plugin.isPermissionGranted.mockResolvedValue(false);
    const adapter = await import("./tauriNotifications");
    expect(await adapter.showDesktopNotification("Actor", "Message", "id", vi.fn())).toBe(false);
    expect(plugin.requestPermission).not.toHaveBeenCalled();
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it("keeps native denial visible and permits an explicit retry", async () => {
    plugin.isPermissionGranted.mockResolvedValue(false);
    plugin.requestPermission.mockResolvedValueOnce("denied").mockResolvedValueOnce("granted");
    const adapter = await import("./tauriNotifications");
    expect(await adapter.requestNotificationPermission()).toBe("denied");
    expect(await adapter.checkNotificationPermission()).toBe("denied");
    expect(await adapter.requestNotificationPermission()).toBe("granted");
  });

  it("reports native API failures and recovers on a later check", async () => {
    plugin.isPermissionGranted.mockRejectedValueOnce(new Error("not allowed"));
    const adapter = await import("./tauriNotifications");
    expect(await adapter.checkNotificationPermission()).toBe("error");
    expect(await adapter.checkNotificationPermission()).toBe("granted");
  });

  it("catches a rejected native notification command", async () => {
    plugin.sendNotification.mockRejectedValueOnce(new Error("OS delivery failed"));
    const adapter = await import("./tauriNotifications");
    expect(await adapter.showDesktopNotification("Actor", "Message", "id", vi.fn())).toBe(false);
  });

  it("uses Web Notifications and preserves click navigation in a browser", async () => {
    const clicked = vi.fn();
    const close = vi.fn();
    let notification: { onclick?: () => void };
    const browserRequest = vi.fn(async () => "granted");
    vi.stubGlobal("window", { focus: vi.fn() });
    vi.stubGlobal("Notification", class {
      static permission = "default";
      static requestPermission = browserRequest;
      onclick?: () => void;
      close = close;
      constructor(public title: string, public options: unknown) { notification = this; }
    });
    const adapter = await import("./tauriNotifications");
    expect(await adapter.requestNotificationPermission()).toBe("granted");
    (Notification as any).permission = "granted";
    expect(await adapter.showDesktopNotification("Actor", "Message", "id", clicked)).toBe(true);
    notification!.onclick!();
    expect(clicked).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });
});
