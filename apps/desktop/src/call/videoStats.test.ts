import { describe, expect, it } from "vitest";
import { diagnose, summarizeReport, type VideoStatsSnapshot } from "./videoStats";

type Row = Record<string, unknown>;
const report = (rows: Row[]) => ({ forEach: (cb: (v: unknown) => void) => rows.forEach(cb) });

const outbound = (ts: number, bytes: number, frames: number, extra: Row = {}): Row[] => [
  {
    id: "OT1",
    type: "outbound-rtp",
    kind: "video",
    timestamp: ts,
    bytesSent: bytes,
    framesEncoded: frames,
    totalEncodeTime: frames * 0.004,
    frameWidth: 1920,
    frameHeight: 1080,
    framesPerSecond: 58,
    codecId: "C1",
    encoderImplementation: "MediaFoundationVideoEncodeAccelerator",
    qualityLimitationReason: "none",
    nackCount: 3,
    pliCount: 1,
    ...extra,
  },
  { id: "C1", type: "codec", mimeType: "video/H264" },
  {
    id: "CP",
    type: "candidate-pair",
    nominated: true,
    state: "succeeded",
    currentRoundTripTime: 0.012,
    availableOutgoingBitrate: 12_000_000,
  },
];

describe("разбор статистики отправки", () => {
  it("считает битрейт и время кодирования по разности счётчиков", () => {
    const prev = new Map();
    summarizeReport(report(outbound(1000, 0, 0)), prev);
    const snap = summarizeReport(report(outbound(2000, 1_250_000, 60)), prev);
    expect(snap.out?.bitrateKbps).toBe(10000);
    expect(snap.out?.encodeMs).toBe(4);
    expect(snap.out?.fps).toBe(58);
    expect(snap.out?.codec).toBe("H264");
    expect(snap.out?.availableKbps).toBe(12000);
    expect(snap.rttMs).toBe(12);
  });
  it("на первом образце скорость неизвестна, а не ноль", () => {
    const snap = summarizeReport(report(outbound(1000, 500, 5)), new Map());
    expect(snap.out?.bitrateKbps).toBeNull();
  });
});

describe("разбор статистики приёма", () => {
  const inbound = (ts: number, p: Row): Row[] => [
    { id: "IT1", type: "inbound-rtp", kind: "video", timestamp: ts, frameWidth: 1920, frameHeight: 1080, ...p },
  ];
  it("считает потери, буфер джиттера и декодирование за интервал", () => {
    const prev = new Map();
    summarizeReport(
      report(inbound(1000, { bytesReceived: 0, packetsReceived: 0, packetsLost: 0, framesDecoded: 0, totalDecodeTime: 0, jitterBufferDelay: 0, jitterBufferEmittedCount: 0 })),
      prev,
    );
    const snap = summarizeReport(
      report(
        inbound(2000, {
          bytesReceived: 625_000,
          packetsReceived: 950,
          packetsLost: 50,
          framesDecoded: 60,
          totalDecodeTime: 0.3,
          jitterBufferDelay: 6,
          jitterBufferEmittedCount: 60,
          jitter: 0.004,
          framesPerSecond: 60,
        }),
      ),
      prev,
    );
    const i = snap.inbound[0];
    expect(i.bitrateKbps).toBe(5000);
    expect(i.lossPct).toBe(5);
    expect(i.jitterBufferMs).toBe(100);
    expect(i.decodeMs).toBe(5);
    expect(i.jitterMs).toBe(4);
    expect(snap.hints.join(" ")).toContain("теряет пакеты");
  });
});

describe("подсказки по причине лагов", () => {
  const base = (out: Partial<NonNullable<VideoStatsSnapshot["out"]>>): VideoStatsSnapshot => ({
    out: {
      fps: 60, width: 1920, height: 1080, bitrateKbps: 8000, availableKbps: 20000, encodeMs: 4,
      codec: "H264", encoder: null, limitationReason: "none", nackCount: 0, pliCount: 0, ...out,
    },
    inbound: [],
    rttMs: 5,
    hints: [],
  });
  it("cpu и bandwidth различаются", () => {
    expect(diagnose(base({ limitationReason: "cpu" }), 60).join(" ")).toContain("CPU");
    expect(diagnose(base({ limitationReason: "bandwidth" }), 60).join(" ")).toContain("пропускной способности");
  });
  it("мало кадров без ограничений кодека указывает на захват", () => {
    expect(diagnose(base({ fps: 15 }), 60).join(" ")).toContain("захвате экрана");
  });
  it("здоровый поток подсказок не даёт", () => {
    expect(diagnose(base({}), 60, 10000)).toEqual([]);
  });
});
