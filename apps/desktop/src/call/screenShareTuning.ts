// Настройка отправки демонстрации экрана: приоритет «плавность / чёткость»,
// параметры RTCRtpSender и порядок кодеков. Чистые функции вынесены отдельно,
// чтобы их можно было проверить без браузера; обращения к WebRTC-объектам
// (sender, transceiver) обёрнуты в try/catch: в разных рантаймах часть полей
// не поддерживается, и это не должно ломать демонстрацию.

export interface ScreenShareQualityLike {
  width: number;
  height: number;
  frameRate: number;
  maxBitrate: number;
}

// Для выбора режима/кодека/способа захвата достаточно FPS и высоты.
type PresetShape = Pick<ScreenShareQualityLike, "frameRate" | "height">;

// Что важнее при нехватке канала/CPU: плавность (держим FPS, снижаем
// разрешение) или чёткость (держим разрешение, роняем FPS).
export type ScreenShareMode = "auto" | "smooth" | "sharp";
export type ResolvedScreenShareMode = "smooth" | "balanced" | "sharp";

// Кодек отправки. `auto` — H.264 для тяжёлых пресетов (аппаратное
// кодирование есть почти везде, программный VP8 на 1440p60 не успевает),
// для лёгких остаётся порядок браузера.
export type ScreenShareCodec = "auto" | "h264" | "vp9" | "vp8";
export type ResolvedScreenShareCodec = "default" | "h264" | "vp9" | "vp8";

// Способ захвата. `native` — getDisplayMedia (аппаратный захват WebView2,
// настоящие 60 FPS); `compat` — собственный захват Tauri (JPEG через IPC,
// практически до ~15–25 FPS, зато без системного выбора источника);
// `auto` — native для 60 FPS и разрешений выше 1080p, иначе compat.
export type ScreenCaptureMethod = "auto" | "native" | "compat";

export interface ScreenShareOptions {
  mode: ScreenShareMode;
  codec: ScreenShareCodec;
  capture: ScreenCaptureMethod;
}

export const DEFAULT_SCREEN_SHARE_OPTIONS: ScreenShareOptions = {
  mode: "auto",
  codec: "auto",
  capture: "auto",
};

export function sanitizeScreenShareOptions(
  raw: Partial<Record<keyof ScreenShareOptions, unknown>> | null | undefined,
): ScreenShareOptions {
  const pick = <T extends string>(v: unknown, allowed: readonly T[], def: T): T =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : def;
  return {
    mode: pick(raw?.mode, ["auto", "smooth", "sharp"] as const, "auto"),
    codec: pick(raw?.codec, ["auto", "h264", "vp9", "vp8"] as const, "auto"),
    capture: pick(raw?.capture, ["auto", "native", "compat"] as const, "auto"),
  };
}

export function resolveMode(
  mode: ScreenShareMode,
  quality: PresetShape,
): ResolvedScreenShareMode {
  if (mode === "smooth") return "smooth";
  if (mode === "sharp") return "sharp";
  return quality.frameRate >= 60 ? "smooth" : "balanced";
}

// track.contentHint: «motion» говорит кодеку, что это видео (держать FPS),
// «detail» — что это текст/интерфейс (держать резкость). Пустая строка —
// решение браузера (для захвата экрана это «detail»-поведение).
export function contentHintFor(mode: ResolvedScreenShareMode): "motion" | "detail" | "" {
  if (mode === "smooth") return "motion";
  if (mode === "sharp") return "detail";
  return "";
}

export function degradationPreferenceFor(
  mode: ResolvedScreenShareMode,
): "maintain-framerate" | "maintain-resolution" | "balanced" {
  if (mode === "smooth") return "maintain-framerate";
  if (mode === "sharp") return "maintain-resolution";
  return "balanced";
}

export function isHeavyPreset(quality: PresetShape): boolean {
  return quality.frameRate >= 60 || quality.height > 1080;
}

export function resolveCodec(
  codec: ScreenShareCodec,
  quality: PresetShape,
): ResolvedScreenShareCodec {
  if (codec === "auto") return isHeavyPreset(quality) ? "h264" : "default";
  return codec;
}

// true — для этого пресета нужен захват через getDisplayMedia.
export function shouldUseNativeCapture(
  method: ScreenCaptureMethod,
  quality: PresetShape | undefined,
): boolean {
  if (method === "native") return true;
  if (method === "compat") return false;
  return !!quality && isHeavyPreset(quality);
}

// Во сколько раз нужно уменьшить захваченную картинку, чтобы она влезла в
// пресет. Только уменьшение: апскейл не нужен. Собственный захват Tauri
// отдаёт родное разрешение монитора, так что без этого 4K-монитор при
// пресете 720p шёл бы в 4K с битрейтом на 720p.
export function scaleDownFor(
  quality: ScreenShareQualityLike,
  source: { width?: number; height?: number } | null | undefined,
): number {
  const w = source?.width ?? 0;
  const h = source?.height ?? 0;
  if (w <= 0 || h <= 0) return 1;
  const scale = Math.max(1, w / quality.width, h / quality.height);
  return Math.round(scale * 100) / 100;
}

type EncodingExt = RTCRtpEncodingParameters & {
  networkPriority?: string;
  priority?: string;
  scaleResolutionDownBy?: number;
};

// Мутирует и возвращает params. maxFramerate/maxBitrate ограничивают
// потолок; networkPriority/priority просят DSCP и приоритет в пейсере
// браузера; degradationPreference — что жертвовать при нехватке ресурсов.
export function buildSendParameters(
  params: RTCRtpSendParameters,
  quality: ScreenShareQualityLike,
  mode: ResolvedScreenShareMode,
  source?: { width?: number; height?: number } | null,
): RTCRtpSendParameters {
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}];
  }
  const enc = params.encodings[0] as EncodingExt;
  enc.maxBitrate = quality.maxBitrate;
  enc.maxFramerate = quality.frameRate;
  enc.scaleResolutionDownBy = scaleDownFor(quality, source);
  enc.networkPriority = "high";
  enc.priority = "high";
  (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
    degradationPreferenceFor(mode);
  return params;
}

// Применяет параметры к sender. До первого согласования setParameters
// бывает недоступен, поэтому при ошибке повторяем несколько раз. Если
// какое-то поле рантайм не принимает, пробуем только базовые (битрейт и FPS).
export async function applySenderTuning(
  sender: RTCRtpSender,
  quality: ScreenShareQualityLike,
  mode: ResolvedScreenShareMode,
  retryDelaysMs: number[] = [250, 1000, 3000],
): Promise<void> {
  const settings = sender.track?.getSettings?.();
  const source = settings ? { width: settings.width, height: settings.height } : null;
  const attempt = async (full: boolean): Promise<void> => {
    const params = sender.getParameters();
    if (full) {
      buildSendParameters(params, quality, mode, source);
    } else {
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = quality.maxBitrate;
      params.encodings[0].maxFramerate = quality.frameRate;
    }
    await sender.setParameters(params);
  };
  const tryOnce = async (): Promise<boolean> => {
    try {
      await attempt(true);
      return true;
    } catch {
      try {
        await attempt(false);
        return true;
      } catch {
        return false;
      }
    }
  };
  if (await tryOnce()) return;
  for (const delay of retryDelaysMs) {
    await new Promise((r) => setTimeout(r, delay));
    if (await tryOnce()) return;
  }
}

function mimeRank(mime: string, preferred: string[]): number {
  const idx = preferred.indexOf(mime.toLowerCase());
  return idx === -1 ? preferred.length : idx;
}

const CODEC_MIME: Record<Exclude<ResolvedScreenShareCodec, "default">, string> = {
  h264: "video/h264",
  vp9: "video/vp9",
  vp8: "video/vp8",
};

// Переставляет выбранный кодек вперёд, остальные остаются (в прежнем
// порядке) как запасные: если у собеседника или сервера выбранного кодека
// нет, согласование всё равно сойдётся на другом. Список не сокращается.
export function orderCodecs(
  codecs: RTCRtpCodec[],
  codec: ResolvedScreenShareCodec,
): RTCRtpCodec[] {
  if (codec === "default") return codecs;
  const preferred = [CODEC_MIME[codec]];
  return codecs
    .map((c, i) => ({ c, i }))
    .sort((a, b) => mimeRank(a.c.mimeType, preferred) - mimeRank(b.c.mimeType, preferred) || a.i - b.i)
    .map((x) => x.c);
}

export function applyCodecPreference(
  transceiver: RTCRtpTransceiver | undefined | null,
  codec: ResolvedScreenShareCodec,
): void {
  if (!transceiver || codec === "default") return;
  try {
    const caps = RTCRtpSender.getCapabilities?.("video");
    if (!caps?.codecs?.length) return;
    transceiver.setCodecPreferences(orderCodecs(caps.codecs, codec));
  } catch {
    /* рантайм не поддерживает setCodecPreferences — остаёмся на порядке браузера */
  }
}

export function applyContentHint(track: MediaStreamTrack, mode: ResolvedScreenShareMode): void {
  try {
    track.contentHint = contentHintFor(mode);
  } catch {
    /* ignore */
  }
}
