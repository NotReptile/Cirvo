import { describe, expect, it } from "vitest";
import { createPcmFeeder, decodePcmBase64, type PcmChunk } from "./screenAudio";

function deferred<T = unknown>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function encodeF32(values: number[]): string {
  const bytes = new Uint8Array(new Float32Array(values).buffer);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe("decodePcmBase64", () => {
  it("restores interleaved float32 samples", () => {
    const decoded = decodePcmBase64(encodeF32([0.5, -0.25, 1, 0]));
    expect(Array.from(decoded)).toEqual([0.5, -0.25, 1, 0]);
  });
});

describe("createPcmFeeder", () => {
  it("closes each chunk only after the generator accepted it", async () => {
    const pendingWrites: ReturnType<typeof deferred>[] = [];
    const closed: number[] = [];
    const feeder = createPcmFeeder({
      sampleRate: 48000,
      channels: 2,
      write: () => {
        const d = deferred();
        pendingWrites.push(d);
        return d.promise;
      },
      makeChunk: ({ timestamp }) => ({ close: () => closed.push(timestamp) }) as PcmChunk,
    });

    expect(feeder.push(new Float32Array(4), 100)).toBe(true);
    expect(closed).toEqual([]);
    pendingWrites[0].resolve(undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toEqual([100]);
  });

  it("drops chunks instead of growing the queue when the generator stalls", () => {
    const feeder = createPcmFeeder({
      sampleRate: 48000,
      channels: 2,
      maxPending: 2,
      write: () => new Promise(() => {}),
      makeChunk: () => ({ close: () => {} }),
    });
    expect(feeder.push(new Float32Array(4), 1)).toBe(true);
    expect(feeder.push(new Float32Array(4), 2)).toBe(true);
    expect(feeder.push(new Float32Array(4), 3)).toBe(false);
    expect(feeder.dropped).toBe(1);
  });

  it("ignores empty or partial frames and passes the frame count per channel", () => {
    const seen: { frameCount: number; length: number }[] = [];
    const feeder = createPcmFeeder({
      sampleRate: 48000,
      channels: 2,
      write: async () => {},
      makeChunk: ({ data, frameCount }) => {
        seen.push({ frameCount, length: data.length });
        return { close: () => {} };
      },
    });
    expect(feeder.push(new Float32Array(1), 0)).toBe(false);
    expect(feeder.push(new Float32Array(5), 0)).toBe(true);
    expect(seen).toEqual([{ frameCount: 2, length: 4 }]);
  });
});
