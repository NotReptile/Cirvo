import { describe, expect, it } from "vitest";
import { clampVolume, createParticipantVolumeStore, type VolumeStorage } from "./participantVolumes";

function memoryStorage(initial: Record<string, string> = {}): VolumeStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const KEY = "rucord.participantVolumes.v1";

describe("participant volumes", () => {
  it("defaults to 100% and keeps voice and screen independent", () => {
    const store = createParticipantVolumeStore(null);
    expect(store.get("u1", "voice")).toBe(1);
    store.set("u1", "voice", 0.3);
    expect(store.get("u1", "voice")).toBe(0.3);
    expect(store.get("u1", "screen")).toBe(1);
    store.set("u1", "screen", 1.8);
    expect(store.get("u1", "voice")).toBe(0.3);
    expect(store.get("u1", "screen")).toBe(1.8);
  });

  it("clamps to 0..200% and ignores non-finite input", () => {
    expect(clampVolume(5)).toBe(2);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(Number.NaN)).toBe(1);
    expect(clampVolume(0.555)).toBe(0.56);
  });

  it("is keyed by userId and persists to storage", () => {
    const storage = memoryStorage();
    createParticipantVolumeStore(storage).set("user-a", "voice", 0.5);
    expect(JSON.parse(storage.data[KEY])).toEqual({ "user-a": { voice: 0.5 } });
    // Новый экземпляр (как после перезагрузки) читает то же значение.
    expect(createParticipantVolumeStore(storage).get("user-a", "voice")).toBe(0.5);
  });

  it("drops keys that return to default and removes empty users", () => {
    const storage = memoryStorage();
    const store = createParticipantVolumeStore(storage);
    store.set("u", "voice", 0.2);
    store.set("u", "voice", 1);
    expect(JSON.parse(storage.data[KEY])).toEqual({});
  });

  it("reset clears both sliders for one user only", () => {
    const store = createParticipantVolumeStore(null);
    store.set("a", "voice", 0.1);
    store.set("a", "screen", 0.2);
    store.set("b", "voice", 1.5);
    store.reset("a");
    expect(store.get("a", "voice")).toBe(1);
    expect(store.get("a", "screen")).toBe(1);
    expect(store.get("b", "voice")).toBe(1.5);
  });

  it("survives broken storage content and throwing storage", () => {
    expect(createParticipantVolumeStore(memoryStorage({ [KEY]: "{not json" })).get("x", "voice")).toBe(1);
    const throwing: VolumeStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    const store = createParticipantVolumeStore(throwing);
    expect(store.get("x", "voice")).toBe(1);
    expect(() => store.set("x", "voice", 0.4)).not.toThrow();
    expect(store.get("x", "voice")).toBe(0.4);
  });
});
