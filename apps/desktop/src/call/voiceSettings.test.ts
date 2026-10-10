import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyOutputDevice, getOutputDeviceId, updateVoiceSettings } from "./voiceSettings";

describe("output device routing", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    updateVoiceSettings({ audioOutputId: null });
  });

  it("resets an already selected output when system default is chosen", async () => {
    const setSinkId = vi.fn(async () => {});
    await applyOutputDevice({ sinkId: "headphones", setSinkId } as any);
    expect(setSinkId).toHaveBeenCalledExactlyOnceWith("");
  });

  it("does not call the platform when the selected sink is already applied", async () => {
    const setSinkId = vi.fn();
    await applyOutputDevice({ sinkId: "", setSinkId } as any);
    expect(setSinkId).not.toHaveBeenCalled();
  });

  it("actually falls back to system default when the saved output is disconnected", async () => {
    updateVoiceSettings({ audioOutputId: "disconnected" });
    const setSinkId = vi.fn().mockRejectedValueOnce(new DOMException("missing", "NotFoundError"))
      .mockResolvedValueOnce(undefined);
    await applyOutputDevice({ sinkId: "old", setSinkId } as any);
    expect(setSinkId.mock.calls).toEqual([["disconnected"], [""]]);
    expect(getOutputDeviceId()).toBeNull();
  });

  it("preserves permission errors without silently selecting another device", async () => {
    updateVoiceSettings({ audioOutputId: "headphones" });
    const denied = new DOMException("denied", "NotAllowedError");
    const setSinkId = vi.fn().mockRejectedValue(denied);
    await expect(applyOutputDevice({ sinkId: "", setSinkId } as any)).rejects.toBe(denied);
    expect(setSinkId).toHaveBeenCalledExactlyOnceWith("headphones");
  });
});
