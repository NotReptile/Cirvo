import { beforeAll, describe, expect, it, vi } from "vitest";
import { RemoteAudioRouter, type AudioContextLike, type HolderElementLike } from "./remoteAudio";

// Фейковый WebAudio-граф: видно, какие узлы созданы и с каким усилением.
function fakeContext() {
  const gains: { gain: { value: number }; disconnected: boolean }[] = [];
  const ctx: AudioContextLike & { setSinkId: ReturnType<typeof vi.fn> } = {
    destination: { name: "destination" },
    state: "running",
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    },
    createGain() {
      const node = {
        gain: { value: 1 },
        disconnected: false,
        connect(target: unknown) {
          return target;
        },
        disconnect() {
          node.disconnected = true;
        },
      };
      gains.push(node);
      return node;
    },
    setSinkId: vi.fn(async () => {}),
  };
  return { ctx, gains };
}

function fakeHolders() {
  const holders: (HolderElementLike & { removed: boolean })[] = [];
  const createHolder = (): HolderElementLike => {
    const h = {
      srcObject: null as MediaStream | null,
      muted: false,
      autoplay: false,
      removed: false,
      remove() {
        h.removed = true;
      },
    };
    holders.push(h);
    return h;
  };
  return { holders, createHolder };
}

function track(id: string, readyState: MediaStreamTrackState = "live"): MediaStreamTrack {
  return { id, kind: "audio", readyState } as unknown as MediaStreamTrack;
}

describe("RemoteAudioRouter", () => {
  beforeAll(() => {
    vi.stubGlobal(
      "MediaStream",
      class {
        tracks: MediaStreamTrack[];
        constructor(tracks: MediaStreamTrack[] = []) {
          this.tracks = tracks;
        }
      },
    );
  });

  it("creates one gain node per slot and allows volume up to 200%", () => {
    const { ctx, gains } = fakeContext();
    const router = new RemoteAudioRouter({ createContext: () => ctx, createHolder: () => null });
    router.sync([
      { id: "voice:s1", track: track("v1"), volume: 1.5 },
      { id: "screen:s1", track: track("s1"), volume: 0.4 },
    ]);
    expect(gains.map((g) => g.gain.value)).toEqual([1.5, 0.4]);
    expect(router.slotIds).toEqual(["voice:s1", "screen:s1"]);
  });

  it("keeps voice and screen gains independent of each other", () => {
    const { ctx, gains } = fakeContext();
    const router = new RemoteAudioRouter({ createContext: () => ctx, createHolder: () => null });
    router.sync([
      { id: "voice:s1", track: track("v1"), volume: 0 },
      { id: "screen:s1", track: track("s1"), volume: 2 },
    ]);
    router.setVolume("screen:s1", 0.5);
    expect(gains[0].gain.value).toBe(0);
    expect(gains[1].gain.value).toBe(0.5);
  });

  it("does not recreate a node while the same track stays and only updates its gain", () => {
    const { ctx, gains } = fakeContext();
    const router = new RemoteAudioRouter({ createContext: () => ctx, createHolder: () => null });
    const t = track("v1");
    router.sync([{ id: "voice:s1", track: t, volume: 1 }]);
    router.sync([{ id: "voice:s1", track: t, volume: 0.25 }]);
    expect(gains).toHaveLength(1);
    expect(gains[0].gain.value).toBe(0.25);
  });

  it("releases slots that are no longer wanted, including their holder element", () => {
    const { ctx, gains } = fakeContext();
    const { createHolder, holders } = fakeHolders();
    const router = new RemoteAudioRouter({ createContext: () => ctx, createHolder });
    router.sync([{ id: "voice:s1", track: track("v1"), volume: 1 }]);
    router.sync([]);
    expect(gains[0].disconnected).toBe(true);
    expect(holders[0].removed).toBe(true);
    expect(router.slotIds).toEqual([]);
  });

  it("replaces a slot when its track object changes", () => {
    const { ctx, gains } = fakeContext();
    const router = new RemoteAudioRouter({ createContext: () => ctx, createHolder: () => null });
    router.sync([{ id: "screen:s1", track: track("a"), volume: 1 }]);
    router.sync([{ id: "screen:s1", track: track("b"), volume: 1 }]);
    expect(gains).toHaveLength(2);
    expect(gains[0].disconnected).toBe(true);
    expect(gains[1].disconnected).toBe(false);
  });

  it("skips ended tracks", () => {
    const { ctx, gains } = fakeContext();
    const router = new RemoteAudioRouter({ createContext: () => ctx, createHolder: () => null });
    router.sync([{ id: "voice:s1", track: track("v1", "ended"), volume: 1 }]);
    expect(gains).toHaveLength(0);
    expect(router.slotIds).toEqual([]);
  });

  it("deafen silences every slot without losing the user's volume", () => {
    const { ctx, gains } = fakeContext();
    const router = new RemoteAudioRouter({ createContext: () => ctx, createHolder: () => null });
    router.sync([{ id: "voice:s1", track: track("v1"), volume: 1.2 }]);
    router.setOutput({ deafened: true });
    expect(gains[0].gain.value).toBe(0);
    router.setOutput({ deafened: false });
    expect(gains[0].gain.value).toBeCloseTo(1.2);
  });

  it("scales every slot by the global output volume", () => {
    const { ctx, gains } = fakeContext();
    const router = new RemoteAudioRouter({ createContext: () => ctx, createHolder: () => null });
    router.sync([{ id: "voice:s1", track: track("v1"), volume: 2 }]);
    router.setOutput({ volume: 0.5 });
    expect(gains[0].gain.value).toBe(1);
  });

  it("routes the output device to the context only when it changes", () => {
    const { ctx } = fakeContext();
    const router = new RemoteAudioRouter({ createContext: () => ctx, createHolder: () => null });
    router.sync([{ id: "voice:s1", track: track("v1"), volume: 1 }]);
    router.setOutput({ sinkId: "headset" });
    router.setOutput({ sinkId: "headset" });
    expect(ctx.setSinkId).toHaveBeenCalledTimes(1);
    expect(ctx.setSinkId).toHaveBeenCalledWith("headset");
  });

  it("does nothing when no audio context can be created", () => {
    const create = vi.fn(() => null);
    const router = new RemoteAudioRouter({ createContext: create, createHolder: () => null });
    expect(() => router.sync([{ id: "voice:s1", track: track("v1"), volume: 1 }])).not.toThrow();
    router.sync([{ id: "voice:s2", track: track("v2"), volume: 1 }]);
    expect(router.slotIds).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("dispose releases every slot", () => {
    const { ctx, gains } = fakeContext();
    const router = new RemoteAudioRouter({ createContext: () => ctx, createHolder: () => null });
    router.sync([
      { id: "voice:s1", track: track("v1"), volume: 1 },
      { id: "screen:s1", track: track("s1"), volume: 1 },
    ]);
    router.dispose();
    expect(gains.every((g) => g.disconnected)).toBe(true);
    expect(router.slotIds).toEqual([]);
  });
});
