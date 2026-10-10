import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  show: vi.fn().mockResolvedValue(true),
  request: vi.fn().mockResolvedValue("granted"),
  sound: vi.fn(),
  settings: { desktopEnabled: true, muteEveryone: false },
  context: { state: {
    me: { presenceMode: "online" },
    notifPrefs: { channels: {} as Record<string, string>, workspaces: {} },
    channels: [],
  } },
}));
vi.mock("../tauriNotifications", () => ({ showDesktopNotification: mocks.show, requestNotificationPermission: mocks.request }));
vi.mock("../state", () => ({ uiContext: mocks.context }));
vi.mock("../notificationSettings", () => ({ getNotificationSettings: () => mocks.settings, playNotificationSound: mocks.sound }));
vi.mock("./callView", () => ({ describePeer: () => "Actor", authorColorStyle: vi.fn() }));
vi.mock("./session", () => ({ loadAllVoicePeeks: vi.fn(), loadWorkspaces: vi.fn(), selectWorkspace: vi.fn() }));
vi.mock("./shell", () => ({ loadWsRoles: vi.fn() }));
vi.mock("./messageList", () => ({ jumpToMessage: vi.fn(), updateMessageList: vi.fn() }));
vi.mock("./messageView", () => ({ renderBody: vi.fn() }));

import { maybeShowBrowserNotification, requestBrowserNotificationPermission } from "./loaders";

const item = { id: "notification-1", kind: "mention", payload: { actorId: "actor", channelId: "channel", snippet: "hello" } } as any;

describe("notification delivery callers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("document", { visibilityState: "hidden" });
    mocks.settings.desktopEnabled = true;
    mocks.settings.muteEveryone = false;
    mocks.context.state.me.presenceMode = "online";
    mocks.context.state.notifPrefs.channels = {};
  });

  it("routes a hidden-window notification through the platform adapter", () => {
    maybeShowBrowserNotification(item);
    expect(mocks.show).toHaveBeenCalledExactlyOnceWith("Actor упомянул вас", "hello", item.id, expect.any(Function));
    expect(mocks.sound).toHaveBeenCalledOnce();
  });

  it.each(["visible", "dnd", "muted", "everyone"])("suppresses delivery for %s", (reason) => {
    if (reason === "visible") vi.stubGlobal("document", { visibilityState: "visible" });
    if (reason === "dnd") mocks.context.state.me.presenceMode = "dnd";
    if (reason === "muted") mocks.context.state.notifPrefs.channels.channel = "none";
    if (reason === "everyone") mocks.settings.muteEveryone = true;
    maybeShowBrowserNotification(reason === "everyone" ? { ...item, kind: "mention_everyone" } : item);
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.sound).not.toHaveBeenCalled();
  });

  it("keeps sound independent when desktop popups are disabled", () => {
    mocks.settings.desktopEnabled = false;
    maybeShowBrowserNotification(item);
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.sound).toHaveBeenCalledOnce();
  });

  it("delegates an explicit permission request to the platform adapter", async () => {
    await requestBrowserNotificationPermission();
    expect(mocks.request).toHaveBeenCalledOnce();
  });
});
