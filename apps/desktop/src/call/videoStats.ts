// Диагностика плавности демонстрации экрана: разбор RTCStatsReport в
// короткие числа (FPS, битрейт, потери, RTT, буфер джиттера, причина
// ограничения качества). Разбор вынесен в чистые функции, чтобы их можно
// было проверить без браузера; VideoStatsCollector хранит предыдущие
// значения счётчиков, чтобы считать скорость по разности.

export interface OutboundVideoStats {
  fps: number | null;
  width: number | null;
  height: number | null;
  bitrateKbps: number | null;
  // Оценка пропускной способности канала от браузера (по TWCC/REMB).
  // Если она ниже maxBitrate пресета, упираемся в сеть, а не в настройки.
  availableKbps: number | null;
  encodeMs: number | null;
  codec: string | null;
  encoder: string | null;
  limitationReason: string | null;
  nackCount: number | null;
  pliCount: number | null;
}

export interface InboundVideoStats {
  fps: number | null;
  width: number | null;
  height: number | null;
  bitrateKbps: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  // Средняя задержка в буфере джиттера на кадр.
  jitterBufferMs: number | null;
  decodeMs: number | null;
  framesDropped: number | null;
  freezeCount: number | null;
  codec: string | null;
  decoder: string | null;
}

export interface VideoStatsSnapshot {
  out: OutboundVideoStats | null;
  inbound: InboundVideoStats[];
  rttMs: number | null;
  hints: string[];
}

type Stat = Record<string, unknown> & { id: string; type: string; timestamp: number };
type ReportLike = { forEach(cb: (value: unknown) => void): void };

interface Prev {
  ts: number;
  bytes?: number;
  frames?: number;
  codecTime?: number;
  jbDelay?: number;
  jbCount?: number;
  lost?: number;
  received?: number;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const round = (v: number | null, digits = 0): number | null => {
  if (v === null) return null;
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

function ratePerSec(cur: number | null, prev: number | undefined, dtMs: number): number | null {
  if (cur === null || prev === undefined || dtMs <= 0) return null;
  const d = cur - prev;
  return d < 0 ? null : (d * 1000) / dtMs;
}

export function summarizeReport(
  report: ReportLike,
  prevStore: Map<string, Prev>,
): VideoStatsSnapshot {
  const stats = new Map<string, Stat>();
  report.forEach((v) => {
    const s = v as Stat;
    if (s && typeof s.id === "string") stats.set(s.id, s);
  });

  let out: OutboundVideoStats | null = null;
  const inbound: InboundVideoStats[] = [];
  let rttMs: number | null = null;
  let available: number | null = null;

  for (const s of stats.values()) {
    if (s.type === "candidate-pair" && (s.nominated === true || s.state === "succeeded")) {
      const rtt = num(s.currentRoundTripTime);
      if (rtt !== null && s.nominated === true) rttMs = rtt * 1000;
      const a = num(s.availableOutgoingBitrate);
      if (a !== null && s.nominated === true) available = a / 1000;
    }
  }

  for (const s of stats.values()) {
    const kind = str(s.kind) ?? str(s.mediaType);
    if (kind !== "video") continue;
    const prev = prevStore.get(s.id);
    const dt = prev ? s.timestamp - prev.ts : 0;
    const codecStat = str(s.codecId) ? stats.get(s.codecId as string) : undefined;
    const codec = codecStat ? str(codecStat.mimeType)?.replace("video/", "") ?? null : null;

    if (s.type === "outbound-rtp") {
      const bytes = num(s.bytesSent);
      const frames = num(s.framesEncoded);
      const encTime = num(s.totalEncodeTime);
      const dFrames = frames !== null && prev?.frames !== undefined ? frames - prev.frames : null;
      const dEnc = encTime !== null && prev?.codecTime !== undefined ? encTime - prev.codecTime : null;
      const bitrate = ratePerSec(bytes, prev?.bytes, dt);
      const reason = str(s.qualityLimitationReason);
      out = {
        fps: round(num(s.framesPerSecond) ?? ratePerSec(frames, prev?.frames, dt), 0),
        width: num(s.frameWidth),
        height: num(s.frameHeight),
        bitrateKbps: bitrate === null ? null : round((bitrate * 8) / 1000),
        availableKbps: round(available),
        encodeMs:
          dEnc !== null && dFrames !== null && dFrames > 0 ? round((dEnc / dFrames) * 1000, 1) : null,
        codec,
        encoder: str(s.encoderImplementation),
        limitationReason: reason,
        nackCount: num(s.nackCount),
        pliCount: num(s.pliCount),
      };
      prevStore.set(s.id, { ts: s.timestamp, bytes: bytes ?? undefined, frames: frames ?? undefined, codecTime: encTime ?? undefined });
    } else if (s.type === "inbound-rtp") {
      const bytes = num(s.bytesReceived);
      const frames = num(s.framesDecoded);
      const decTime = num(s.totalDecodeTime);
      const jbDelay = num(s.jitterBufferDelay);
      const jbCount = num(s.jitterBufferEmittedCount);
      const lost = num(s.packetsLost);
      const received = num(s.packetsReceived);
      const dFrames = frames !== null && prev?.frames !== undefined ? frames - prev.frames : null;
      const dDec = decTime !== null && prev?.codecTime !== undefined ? decTime - prev.codecTime : null;
      const dJbDelay = jbDelay !== null && prev?.jbDelay !== undefined ? jbDelay - prev.jbDelay : null;
      const dJbCount = jbCount !== null && prev?.jbCount !== undefined ? jbCount - prev.jbCount : null;
      const dLost = lost !== null && prev?.lost !== undefined ? lost - prev.lost : null;
      const dRecv = received !== null && prev?.received !== undefined ? received - prev.received : null;
      const bitrate = ratePerSec(bytes, prev?.bytes, dt);
      const jitter = num(s.jitter);
      inbound.push({
        fps: round(num(s.framesPerSecond) ?? ratePerSec(frames, prev?.frames, dt), 0),
        width: num(s.frameWidth),
        height: num(s.frameHeight),
        bitrateKbps: bitrate === null ? null : round((bitrate * 8) / 1000),
        lossPct:
          dLost !== null && dRecv !== null && dLost + dRecv > 0
            ? round((Math.max(0, dLost) / (dLost + dRecv)) * 100, 1)
            : null,
        jitterMs: jitter === null ? null : round(jitter * 1000, 1),
        jitterBufferMs:
          dJbDelay !== null && dJbCount !== null && dJbCount > 0
            ? round((dJbDelay / dJbCount) * 1000)
            : null,
        decodeMs:
          dDec !== null && dFrames !== null && dFrames > 0 ? round((dDec / dFrames) * 1000, 1) : null,
        framesDropped: num(s.framesDropped),
        freezeCount: num(s.freezeCount),
        codec,
        decoder: str(s.decoderImplementation),
      });
      prevStore.set(s.id, {
        ts: s.timestamp,
        bytes: bytes ?? undefined,
        frames: frames ?? undefined,
        codecTime: decTime ?? undefined,
        jbDelay: jbDelay ?? undefined,
        jbCount: jbCount ?? undefined,
        lost: lost ?? undefined,
        received: received ?? undefined,
      });
    }
  }

  const snapshot: VideoStatsSnapshot = { out, inbound, rttMs: round(rttMs), hints: [] };
  snapshot.hints = diagnose(snapshot);
  return snapshot;
}

// Человекочитаемые выводы: что вероятнее всего мешает плавности.
export function diagnose(s: VideoStatsSnapshot, targetFps?: number, maxKbps?: number): string[] {
  const hints: string[] = [];
  const o = s.out;
  if (o) {
    if (o.limitationReason === "cpu") {
      hints.push("Кодек не успевает: не хватает CPU/GPU на отправляющей стороне. Снизьте пресет или выберите другой кодек.");
    } else if (o.limitationReason === "bandwidth") {
      hints.push("Браузер урезает качество из-за пропускной способности канала до сервера.");
    }
    if (o.availableKbps !== null && o.bitrateKbps !== null && o.availableKbps > 0 && o.availableKbps < (maxKbps ?? Infinity) * 0.7 && o.limitationReason !== "none") {
      hints.push("Оценка канала ниже потолка битрейта пресета: упираемся в сеть, а не в настройки.");
    }
    if (o.fps !== null && targetFps && o.fps < targetFps * 0.7 && (o.limitationReason === null || o.limitationReason === "none")) {
      hints.push("Кадров в кодек поступает меньше целевого, а ограничений кодека нет: узкое место в захвате экрана (источник кадров), не в сети.");
    }
    if ((o.encodeMs ?? 0) > 1000 / Math.max(1, targetFps ?? 60)) {
      hints.push("Кодирование одного кадра дольше интервала между кадрами: кодек не тянет этот FPS.");
    }
  }
  if (s.rttMs !== null && s.rttMs > 100) {
    hints.push("Высокий RTT до сервера: задержка в сети, а не в картинке.");
  }
  for (const i of s.inbound) {
    if ((i.lossPct ?? 0) > 2) hints.push("Входящий поток теряет пакеты (более 2%): рывки и размытие из-за сети.");
    if ((i.jitterBufferMs ?? 0) > 150) hints.push("Большой буфер джиттера у зрителя: нестабильная доставка, добавляется задержка.");
    if ((i.freezeCount ?? 0) > 0) hints.push("У зрителя были заморозки картинки.");
    if ((i.decodeMs ?? 0) > 16) hints.push("Декодирование на стороне зрителя медленное (более 16 мс на кадр).");
  }
  return Array.from(new Set(hints));
}

export class VideoStatsCollector {
  private prev = new Map<string, Prev>();

  async collect(
    pcs: Array<{ pc: RTCPeerConnection; role: "pub" | "sub" | "mesh" }>,
  ): Promise<VideoStatsSnapshot> {
    let out: OutboundVideoStats | null = null;
    const inbound: InboundVideoStats[] = [];
    let rttMs: number | null = null;
    for (const { pc } of pcs) {
      try {
        const report = await pc.getStats();
        const snap = summarizeReport(report as unknown as ReportLike, this.prev);
        if (snap.out && (!out || (snap.out.bitrateKbps ?? 0) > (out.bitrateKbps ?? 0))) out = snap.out;
        inbound.push(...snap.inbound);
        if (snap.rttMs !== null) rttMs = rttMs === null ? snap.rttMs : Math.max(rttMs, snap.rttMs);
      } catch {
        /* PC закрыт — пропускаем */
      }
    }
    const result: VideoStatsSnapshot = { out, inbound, rttMs, hints: [] };
    result.hints = diagnose(result);
    return result;
  }

  reset(): void {
    this.prev.clear();
  }
}

// Форматирование для вывода в настройках.
export function formatOutbound(o: OutboundVideoStats): string {
  const res = o.width && o.height ? `${o.width}×${o.height}` : "—";
  const parts = [
    `${res} @ ${o.fps ?? "—"} FPS`,
    `${o.bitrateKbps !== null ? (o.bitrateKbps / 1000).toFixed(1) : "—"} Мбит/с`,
    o.availableKbps !== null ? `канал ≈ ${(o.availableKbps / 1000).toFixed(1)} Мбит/с` : null,
    o.encodeMs !== null ? `кодирование ${o.encodeMs} мс/кадр` : null,
    o.codec ? `${o.codec}${o.encoder ? ` (${o.encoder})` : ""}` : null,
    `ограничение: ${o.limitationReason ?? "—"}`,
    o.nackCount !== null ? `NACK ${o.nackCount}` : null,
    o.pliCount !== null ? `PLI ${o.pliCount}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

export function formatInbound(i: InboundVideoStats): string {
  const res = i.width && i.height ? `${i.width}×${i.height}` : "—";
  const parts = [
    `${res} @ ${i.fps ?? "—"} FPS`,
    `${i.bitrateKbps !== null ? (i.bitrateKbps / 1000).toFixed(1) : "—"} Мбит/с`,
    i.lossPct !== null ? `потери ${i.lossPct}%` : null,
    i.jitterMs !== null ? `джиттер ${i.jitterMs} мс` : null,
    i.jitterBufferMs !== null ? `буфер ${i.jitterBufferMs} мс` : null,
    i.decodeMs !== null ? `декод ${i.decodeMs} мс/кадр` : null,
    i.codec ? `${i.codec}${i.decoder ? ` (${i.decoder})` : ""}` : null,
    i.framesDropped ? `пропущено кадров ${i.framesDropped}` : null,
    i.freezeCount ? `заморозок ${i.freezeCount}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}
