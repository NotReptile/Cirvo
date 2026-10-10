import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  enumerate: vi.fn(),
  gum: vi.fn(),
  render: vi.fn(),
  deviceChange: null as null | (() => void),
  permissionChanges: [] as (() => void)[],
  context: {
    state: { modal: "settings", settings: { tab: "voice" }, status: "" },
    rootEl: { querySelector: vi.fn(() => null) },
    _settingsDevices: null as any,
    _settingsDevicesLoading: false,
    _settingsVoiceSubscribed: false,
    _micTestStream: null as any,
    _camTestStream: null as any,
    _micTestAudioCtx: null as any,
    _micTestAnalyser: null as any,
    _micTestRaf: null as any,
  },
}));
vi.mock("../../call/voiceSettings", () => ({
  enumerateVoiceDevices: fixtures.enumerate,
  buildAudioConstraints: () => ({ deviceId: { exact: "chosen-mic" } }),
  buildVideoConstraints: () => ({ deviceId: { exact: "chosen-camera" } }),
  getVoiceSettings: () => ({}),
  updateVoiceSettings: vi.fn(),
  subscribeVoiceSettings: vi.fn(),
}));
vi.mock("../state", () => ({ uiContext: fixtures.context }));
vi.mock("../runtime", () => ({ requestRender: fixtures.render }));
vi.mock("../errors", () => ({ describeError: (err: Error) => err.message }));
vi.mock("../i18n", () => ({ t: (key: string) => key }));
vi.mock("./loaders", () => ({ applyPttModeToActiveSessions: vi.fn(), updatePttIndicator: vi.fn() }));
vi.mock("./voiceView", () => ({ attachVoiceVideoStreams: vi.fn() }));

import {
  ensureSettingsDevicesLoaded,
  refreshSettingsDevices,
  renderDeviceOptions,
  revealVoiceDeviceNames,
  startCamTest,
  startMicTest,
  stopVoiceTestsIfNotActive,
} from "./voiceSettings";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function stream() {
  const stop = vi.fn();
  return { value: { getTracks: () => [{ stop }] } as unknown as MediaStream, stop };
}
const emptyDevices = { audioInputs: [], audioOutputs: [], videoInputs: [] };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe("voice settings device lifecycle", () => {
  beforeEach(() => {
    fixtures.context.state.modal = "closed";
    stopVoiceTestsIfNotActive();
    fixtures.context.state.modal = "settings";
    fixtures.context.state.settings.tab = "voice";
    fixtures.context.state.status = "";
    fixtures.context._settingsDevices = null;
    fixtures.context._settingsDevicesLoading = false;
    fixtures.enumerate.mockReset().mockResolvedValue(emptyDevices);
    fixtures.gum.mockReset();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: fixtures.gum, addEventListener: (_: string, callback: () => void) => { fixtures.deviceChange = callback; } },
      permissions: { query: async () => ({ addEventListener: (_: string, callback: () => void) => { fixtures.permissionChanges.push(callback); } }) },
    });
  });

  it("enumerates on opening without requesting microphone or camera", async () => {
    ensureSettingsDevicesLoaded();
    await flush();
    expect(fixtures.enumerate).toHaveBeenCalledOnce();
    expect(fixtures.gum).not.toHaveBeenCalled();
  });

  it("refreshes after hotplug or permission changes without starting media", async () => {
    expect(fixtures.deviceChange).toBeTypeOf("function");
    fixtures.deviceChange!();
    for (const changed of fixtures.permissionChanges) changed();
    await flush();
    expect(fixtures.enumerate).toHaveBeenCalledTimes(3);
    expect(fixtures.gum).not.toHaveBeenCalled();
  });

  it.each([startMicTest, startCamTest])("stops a late test stream after leaving voice settings", async (start) => {
    const request = deferred<MediaStream>();
    const media = stream();
    fixtures.gum.mockReturnValue(request.promise);
    const pending = start();
    await start();
    expect(fixtures.gum).toHaveBeenCalledOnce();
    fixtures.context.state.settings.tab = "profile";
    stopVoiceTestsIfNotActive();
    request.resolve(media.value);
    await pending;
    expect(media.stop).toHaveBeenCalledOnce();
    expect(fixtures.context._micTestStream).toBeNull();
    expect(fixtures.context._camTestStream).toBeNull();
  });

  it("allows permission retry after denial and always stops the consent stream", async () => {
    const media = stream();
    fixtures.gum.mockRejectedValueOnce(new Error("Permission denied")).mockResolvedValueOnce(media.value);
    await revealVoiceDeviceNames();
    expect(fixtures.context.state.status).toBe("Permission denied");
    await revealVoiceDeviceNames();
    expect(fixtures.gum.mock.calls).toEqual([[{ audio: true }], [{ audio: true }]]);
    expect(media.stop).toHaveBeenCalledOnce();
    expect(fixtures.enumerate).toHaveBeenCalledOnce();
    expect(fixtures.context._micTestStream).toBeNull();
  });

  it("can retry a denied microphone test using the exact selected device", async () => {
    const request = deferred<MediaStream>();
    const media = stream();
    fixtures.gum.mockRejectedValueOnce(new Error("Permission denied")).mockReturnValueOnce(request.promise);
    await startMicTest();
    const pending = startMicTest();
    expect(fixtures.gum).toHaveBeenCalledTimes(2);
    expect(fixtures.gum.mock.calls[1]).toEqual([{ audio: { deviceId: { exact: "chosen-mic" } } }]);
    fixtures.context.state.modal = "closed";
    stopVoiceTestsIfNotActive();
    request.resolve(media.value);
    await pending;
    expect(media.stop).toHaveBeenCalledOnce();
  });

  it("stops a late permission stream without refreshing a closed panel", async () => {
    const request = deferred<MediaStream>();
    const media = stream();
    fixtures.gum.mockReturnValue(request.promise);
    const pending = revealVoiceDeviceNames();
    fixtures.context.state.modal = "closed";
    stopVoiceTestsIfNotActive();
    request.resolve(media.value);
    await pending;
    expect(media.stop).toHaveBeenCalledOnce();
    expect(fixtures.enumerate).not.toHaveBeenCalled();
  });

  it("keeps the newest device refresh when enumeration resolves out of order", async () => {
    const old = deferred<typeof emptyDevices>();
    const current = { ...emptyDevices, audioInputs: [{ deviceId: "usb", label: "USB Mic" }] };
    fixtures.enumerate.mockReturnValueOnce(old.promise).mockResolvedValueOnce(current);
    refreshSettingsDevices();
    refreshSettingsDevices();
    await flush();
    expect(fixtures.context._settingsDevices).toBe(current);
    old.resolve(emptyDevices);
    await flush();
    expect(fixtures.context._settingsDevices).toBe(current);
    expect(fixtures.context._settingsDevicesLoading).toBe(false);
  });

  it("cleans up microphone tracks when AudioContext creation fails", async () => {
    const media = stream();
    fixtures.gum.mockResolvedValue(media.value);
    vi.stubGlobal("window", { AudioContext: class { constructor() { throw new Error("audio unavailable"); } } });
    await startMicTest();
    expect(media.stop).toHaveBeenCalledOnce();
    expect(fixtures.context._micTestStream).toBeNull();
    expect(fixtures.context.state.status).toBe("audio unavailable");
  });

  it("preserves an unavailable selection and escapes visible real device names", () => {
    const options = renderDeviceOptions([{ deviceId: "usb", label: "USB <Mic>" } as MediaDeviceInfo], "missing&mic");
    expect(options).toContain('value="missing&amp;mic" selected');
    expect(options).toContain("vs.devices.unavailable");
    expect(options).toContain("USB &lt;Mic&gt;");
    expect(renderDeviceOptions([{ deviceId: "usb", label: "USB" } as MediaDeviceInfo], "usb")).toContain('value="usb" selected');
  });
});
