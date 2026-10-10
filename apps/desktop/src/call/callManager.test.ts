import { beforeEach, describe, expect, it, vi } from "vitest";
import { CallManager } from "./callManager";

vi.mock("./denoiser", () => ({
  wrapMicStream: async (stream: any) => ({
    stream,
    dispose: () => stream.getTracks().forEach((t: any) => t.stop()),
  }),
}));

class Peer {
  static instances: Peer[] = [];
  remoteDescription: any = null;
  localDescription: any = null;
  connectionState = "new";
  onconnectionstatechange: (() => void) | null = null;
  senders: any[] = [];
  constructor() {
    Peer.instances.push(this);
  }
  async setRemoteDescription(value: any) {
    this.remoteDescription = value;
  }
  async setLocalDescription(value: any) {
    this.localDescription = value;
  }
  async createAnswer() {
    if (!this.remoteDescription) throw Error("offer missing");
    return { type: "answer", sdp: "answer" };
  }
  async createOffer() {
    return { type: "offer", sdp: "offer" };
  }
  getSenders() {
    return this.senders;
  }
  addTrack(track: any) {
    const sender = { track };
    this.senders.push(sender);
    return sender;
  }
  async addIceCandidate() {}
  async getStats() {
    return new Map();
  }
  close() {
    this.connectionState = "closed";
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  let listener: (event: any) => void = () => {};
  const ice = deferred<any>();
  const http = {
    get: vi.fn((path: string) =>
      path === "/api/v1/media/config" ? ice.promise : new Promise(() => {}),
    ),
    post: vi.fn(async () => ({
      id: "outgoing",
      startedAt: "2026-10-09T00:00:00Z",
    })),
  };
  const realtime = {
    subscribe: (fn: any) => {
      listener = fn;
      return () => {};
    },
    send: vi.fn(),
  };
  const manager = new CallManager(http as any, realtime as any);
  const emit = (event: string, payload: any = {}) =>
    listener({
      event,
      payload: {
        call_id: "incoming",
        from_user_id: "peer",
        from_session_id: "peer-session",
        ...payload,
      },
    });
  return { manager, ice, http, realtime, emit };
}
describe("call signaling order", () => {
  beforeEach(() => {
    Peer.instances = [];
    vi.stubGlobal("RTCPeerConnection", Peer);
    const track = { kind: "audio", enabled: true, stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [track],
          getAudioTracks: () => [track],
        })),
      },
    });
  });
  it("keeps an offer received while ICE is loading, without waiting for call metadata", async () => {
    const f = fixture();
    f.emit("call.invite");
    f.emit("call.offer", { sdp: { type: "offer", sdp: "remote" } });
    expect(Peer.instances).toHaveLength(0);
    f.ice.resolve({ iceServers: [] });
    await vi.waitFor(() =>
      expect(Peer.instances[0]?.remoteDescription?.sdp).toBe("remote"),
    );
    await f.manager.acceptIncoming();
    expect(f.realtime.send).toHaveBeenCalledWith(
      "call.answer",
      expect.objectContaining({ target_session_id: "peer-session" }),
    );
    f.manager.dispose();
  });
  it("accept waits for the delayed offer and cancellation releases that wait", async () => {
    const f = fixture();
    f.ice.resolve({ iceServers: [] });
    f.emit("call.invite");
    await vi.waitFor(() =>
      expect(f.manager.getSnapshot().state).toBe("incoming"),
    );
    const accepted = f.manager.acceptIncoming();
    expect(Peer.instances[0].localDescription).toBeNull();
    f.manager.hangup();
    await accepted;
    expect(f.realtime.send).not.toHaveBeenCalledWith(
      "call.answer",
      expect.anything(),
    );
    f.manager.dispose();
  });
  it("renegotiation answer preserves an active call", async () => {
    const f = fixture();
    f.ice.resolve({ iceServers: [] });
    f.emit("call.invite");
    f.emit("call.offer", { sdp: { type: "offer", sdp: "remote" } });
    await vi.waitFor(() =>
      expect(Peer.instances[0]?.remoteDescription).toMatchObject({
        type: "offer",
      }),
    );
    const pc = Peer.instances[0];
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    f.emit("call.answer", { sdp: { type: "answer", sdp: "renegotiation" } });
    await vi.waitFor(() =>
      expect(pc.remoteDescription.sdp).toBe("renegotiation"),
    );
    expect(f.manager.getSnapshot().state).toBe("active");
    f.manager.dispose();
  });
  it("microphone denial creates no call record", async () => {
    const f = fixture();
    f.ice.resolve({ iceServers: [] });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(
      new Error("permission denied"),
    );
    await expect(f.manager.placeCall("peer")).rejects.toThrow(
      "permission denied",
    );
    expect(f.http.post).not.toHaveBeenCalled();
    f.manager.dispose();
  });
  it("camera denial remains visible to the UI without ending an active call", async () => {
    const f = fixture();
    f.ice.resolve({ iceServers: [] });
    f.emit("call.invite");
    f.emit("call.offer", { sdp: { type: "offer", sdp: "remote" } });
    await vi.waitFor(() => expect(Peer.instances[0]?.remoteDescription).toMatchObject({ type: "offer" }));
    await f.manager.acceptIncoming();
    const pc = Peer.instances[0];
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    const denied = new DOMException("camera permission denied", "NotAllowedError");
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(denied);
    await expect(f.manager.toggleCamera()).rejects.toBe(denied);
    expect(f.manager.getSnapshot()).toMatchObject({ state: "active", cameraOn: false });
    f.manager.dispose();
  });
});
