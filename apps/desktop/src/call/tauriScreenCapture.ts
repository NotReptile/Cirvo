// K.5/K.9: своя screen-share pipeline через Tauri commands. Polling 15fps
// через `invoke("screen_capture_frame")`, base64 JPEG → Blob → ImageBitmap
// → VideoFrame → MediaStreamTrackGenerator → MediaStream. Браузер не видит
// это как getDisplayMedia — баннер «сайт делает демонстрацию» не появляется
// (K.9).
//
// Web-сборка / отсутствие MediaStreamTrackGenerator (Firefox/Safari) /
// ошибка Tauri-команды → `isAvailable() === false`, caller использует
// старый `getDisplayMedia` как fallback.
//
// Performance: 15 fps, JPEG quality 60-70, max ~1080p. CPU ~5-10% одного
// ядра на Windows. Latency end-to-end ~150ms (capture+encode+invoke+
// decode+display). Достаточно для разговорного screen-share, для геймплея
// нужен HW-accelerated WGC — отдельный пункт.

export interface ScreenSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  width: number;
  height: number;
  thumbnail: string; // base64 JPEG, без префикса data:
}

interface CapturedFrame {
  width: number;
  height: number;
  jpeg: string;
}

// Лениво ищем @tauri-apps/api invoke. На web-сборке его нет.
let invokeFn: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
let invokeChecked = false;

async function getInvoke(): Promise<typeof invokeFn> {
  if (invokeChecked) return invokeFn;
  invokeChecked = true;
  if (typeof window === "undefined") return null;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (!w.__TAURI_INTERNALS__) return null;
  try {
    const mod = await import("@tauri-apps/api/core");
    invokeFn = mod.invoke as typeof invokeFn;
    return invokeFn;
  } catch {
    return null;
  }
}

// MediaStreamTrackGenerator поддерживается только в Chromium-based
// (WebView2/Chrome/Edge). Firefox/Safari → нет, фоллбэк на getDisplayMedia.
function hasTrackGenerator(): boolean {
  return typeof (window as unknown as { MediaStreamTrackGenerator?: unknown }).MediaStreamTrackGenerator !== "undefined";
}

export async function isAvailable(): Promise<boolean> {
  const invoke = await getInvoke();
  return !!invoke && hasTrackGenerator() && typeof VideoFrame !== "undefined";
}

export async function listSources(): Promise<ScreenSource[]> {
  const invoke = await getInvoke();
  if (!invoke) throw new Error("Tauri not available");
  const sources = (await invoke("screen_list_sources")) as ScreenSource[];
  return sources;
}

// Активная сессия захвата. Используется для остановки polling-loop'а и
// closing'а MediaStream'а из toggleScreenShare.
interface ActiveCapture {
  stream: MediaStream;
  stop: () => void;
}

let active: ActiveCapture | null = null;

export function isCapturing(): boolean {
  return active !== null;
}

export async function startCapture(sourceId: string, fps = 15, quality = 65): Promise<MediaStream> {
  if (active) {
    stopCapture();
  }
  const invoke = await getInvoke();
  if (!invoke || !hasTrackGenerator() || typeof VideoFrame === "undefined") {
    throw new Error("screen capture not available in this runtime");
  }

  type TrackGenCtor = new (init: { kind: "video" }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> };
  const TrackGen = (window as unknown as { MediaStreamTrackGenerator: TrackGenCtor }).MediaStreamTrackGenerator;
  const trackGen = new TrackGen({ kind: "video" });
  const writer = trackGen.writable.getWriter();
  const stream = new MediaStream([trackGen]);

  let stopped = false;
  let frameNum = 0;
  const startTs = performance.now();

  // Polling-loop. Между кадрами выдерживаем 1000/fps мс; если предыдущий
  // invoke ещё не вернулся — пропускаем тик (не накапливаем backlog).
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const frame = (await invoke("screen_capture_frame", { id: sourceId, quality })) as CapturedFrame;
      if (stopped) return;
      // base64 → ArrayBuffer → ImageBitmap → VideoFrame.
      const bin = atob(frame.jpeg);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const blob = new Blob([buf.buffer as ArrayBuffer], { type: "image/jpeg" });
      const bitmap = await createImageBitmap(blob);
      if (stopped) {
        bitmap.close();
        return;
      }
      const timestamp = Math.round((performance.now() - startTs) * 1000); // µs
      const vf = new VideoFrame(bitmap, { timestamp });
      try {
        await writer.write(vf);
      } finally {
        vf.close();
        bitmap.close();
      }
      frameNum++;
    } catch (err) {
      // Окно закрыли / монитор отключили → останавливаем capture, чтобы
      // не спамить ошибками. Caller увидит, что stream завершился.
      console.warn("[screen-capture] frame error", err);
      stopped = true;
      try { await writer.close(); } catch { /* already closed */ }
      trackGen.stop();
      active = null;
      return;
    }
    if (!stopped) {
      setTimeout(tick, Math.max(1, Math.floor(1000 / fps)));
    }
  };

  void tick();

  const stop = (): void => {
    stopped = true;
    try { void writer.close(); } catch { /* ignore */ }
    trackGen.stop();
    if (active && active.stream === stream) active = null;
  };

  active = { stream, stop };
  return stream;
}

export function stopCapture(): void {
  if (!active) return;
  active.stop();
  active = null;
}
