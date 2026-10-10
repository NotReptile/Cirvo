import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  permission: "granted" as string | null,
  enabled: true,
  native: true,
  check: vi.fn(), request: vi.fn(), render: vi.fn(),
  callbacks: new Map<string, (event: any) => Promise<void>>(),
}));
vi.mock("../tauriNotifications", () => ({
  checkNotificationPermission: fixtures.check,
  getCachedNotificationPermission: () => fixtures.permission,
  usesNativeNotifications: () => fixtures.native,
}));
vi.mock("../notificationSettings", () => ({
  getNotificationSettings: () => ({ desktopEnabled: fixtures.enabled, soundEnabled: false, muteEveryone: false, sound: "beep" }),
  updateNotificationSettings: ({ desktopEnabled }: { desktopEnabled?: boolean }) => { if (desktopEnabled !== undefined) fixtures.enabled = desktopEnabled; },
  SOUND_LABELS: { beep: "Beep" }, playNotificationSound: vi.fn(),
}));
vi.mock("./loaders", () => ({ requestBrowserNotificationPermission: fixtures.request }));
vi.mock("../state", () => ({ uiContext: {
  state: { modal: "settings", settings: { tab: "notifications" } },
  rootEl: { querySelector: (selector: string) => ({ selector }) },
} }));
vi.mock("../runtime", () => ({ requestRender: fixtures.render }));
vi.mock("../i18n", () => ({ t: (key: string) => key }));
vi.mock("../dom", () => ({ bindEvent: (element: { selector: string }, _: string, handler: any) => { fixtures.callbacks.set(element.selector, handler); } }));

describe("notification settings permissions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fixtures.permission = "granted";
    fixtures.enabled = true;
    fixtures.native = true;
    fixtures.check.mockResolvedValue("granted");
    fixtures.request.mockResolvedValue(undefined);
    fixtures.callbacks.clear();
  });

  it("loads actual adapter permission without prompting", async () => {
    const settings = await import("./settingsNotifications");
    expect(settings.renderSettingsNotificationsTab()).toContain("nt.perm.loading");
    await Promise.resolve();
    expect(settings.renderSettingsNotificationsTab()).toContain("nt.perm.granted");
    expect(fixtures.check).toHaveBeenCalledOnce();
    expect(fixtures.request).not.toHaveBeenCalled();
  });

  it("hides permission warnings and performs no check while desktop notifications are off", async () => {
    fixtures.enabled = false;
    fixtures.permission = "denied";
    const settings = await import("./settingsNotifications");
    expect(settings.renderSettingsNotificationsTab()).not.toContain("nt.perm.denied");
    expect(fixtures.check).not.toHaveBeenCalled();
  });

  it.each([true, false])("uses the correct permission help for native=%s", async (native) => {
    fixtures.native = native;
    fixtures.permission = "denied";
    const settings = await import("./settingsNotifications");
    settings.renderSettingsNotificationsTab();
    await Promise.resolve();
    const rendered = settings.renderSettingsNotificationsTab();
    expect(rendered).toContain(native ? "nt.perm.denied.native" : "nt.perm.denied</span>");
    expect(fixtures.request).not.toHaveBeenCalled();
  });

  it("requests consent only after enabling the notification toggle", async () => {
    fixtures.enabled = false;
    const settings = await import("./settingsNotifications");
    settings.attachSettingsNotificationsHandlers();
    expect(fixtures.request).not.toHaveBeenCalled();
    await fixtures.callbacks.get("#notif-desktop")!({ currentTarget: { checked: true } });
    expect(fixtures.enabled).toBe(true);
    expect(fixtures.request).toHaveBeenCalledOnce();
  });
});
