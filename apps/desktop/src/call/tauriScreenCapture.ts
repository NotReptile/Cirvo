// K.5/K.9: своя screen-share pipeline через Tauri commands. Запрос кадров
// через `invoke("screen_capture_frame")`, JPEG (ArrayBuffer) → Blob → ImageBitmap
// → VideoFrame → MediaStreamTrackGenerator → MediaStream. Браузер не видит
// это как getDisplayMedia — баннер «сайт делает демонстрацию» не появляется
// (K.9).
//
// Web-сборка / отсутствие MediaStreamTrackGenerator (Firefox/Safari) /
// ошибка Tauri-команды → `isAvailable() === false`, caller использует
// старый `getDisplayMedia` как fallback.
//
// Performance: JPEG-кодирование на CPU и копирование через IPC ограничивают
// путь примерно 15-25 кадрами/с на 1080p (оценка по устройству, замеров на
// живом стриме нет). Для 60 FPS клиент использует getDisplayMedia, см.
// screenSharePicker.ts. Кадры идут бинарным ответом IPC, а не base64.

export interface ScreenSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  width: number;
  height: number;
  thumbnail: string; // base64 JPEG, без префикса data:
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
  let presenting = false;
  const startTs = performance.now();

  // Показ кадра: JPEG → ImageBitmap → VideoFrame → трек. Идёт параллельно
  // со следующим запросом кадра в Rust (конвейер): пока предыдущий кадр
  // декодируется, уже готовится следующий. Если декодирование не успевает,
  // лишние кадры отбрасываются (всегда показываем самый свежий), а не
  // копятся в очереди и не раздувают задержку.
  const present = async (jpeg: ArrayBuffer): Promise<void> => {
    const bitmap = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
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
  };

  const fail = async (err: unknown): Promise<void> => {
    // Окно закрыли / монитор отключили → останавливаем capture, чтобы
    // не спамить ошибками. Caller увидит, что stream завершился.
    console.warn("[screen-capture] frame error", err);
    stopped = true;
    try { await writer.close(); } catch { /* already closed */ }
    trackGen.stop();
    active = null;
  };

  // Rust сам выдерживает FPS и отдаёт новый кадр, как только он готов
  // (пустой ответ = «кадра пока нет», просто спрашиваем снова), поэтому
  // таймеров на стороне JS нет: они только добавляли бы задержку.
  const loop = async (): Promise<void> => {
    while (!stopped) {
      let buf: ArrayBuffer;
      try {
        buf = (await invoke("screen_capture_frame", { id: sourceId, quality, fps })) as ArrayBuffer;
      } catch (err) {
        if (!stopped) await fail(err);
        return;
      }
      if (stopped) return;
      if (!(buf instanceof ArrayBuffer) || buf.byteLength === 0) continue;
      if (presenting) continue; // декодер занят — этот кадр устарел
      presenting = true;
      void present(buf)
        .catch((err) => { if (!stopped) void fail(err); })
        .finally(() => { presenting = false; });
    }
  };

  void loop();

  const stop = (): void => {
    stopped = true;
    try { void writer.close(); } catch { /* ignore */ }
    trackGen.stop();
    if (active && active.stream === stream) active = null;
    // Capture-поток в Rust иначе жил бы ещё 5 с простоя.
    void invoke("screen_capture_stop_all").catch(() => { /* не критично */ });
  };

  active = { stream, stop };
  return stream;
}

export function stopCapture(): void {
  if (!active) return;
  active.stop();
  active = null;
}
