// K.5(c): системный звук в screen-share. Подключаем cpal+WASAPI loopback
// через tauri-команды (только Windows). Rust присылает f32 LE PCM кадры
// событием `screen-audio:pcm`, мы декодим в Float32Array, заворачиваем в
// AudioData и пишем в MediaStreamTrackGenerator({kind:"audio"}). Track
// добавляется в screen-share MediaStream рядом с video-track'ом.
//
// Mic при этом не трогаем — он остаётся отдельным WebRTC-track'ом
// (microphone stream → peer connection).
//
// Web-сборка / mac / linux: команды `screen_audio_start` нет → invoke
// бросает, caller просто не получает audio-track. Pure-fallback на
// getDisplayMedia({audio:true}) не делаем — там браузерная плашка опять
// вылезет (K.9), теряем смысл.

interface PcmPayload {
  pcm: string;       // base64 f32 LE interleaved
  timestamp: number; // µs от старта capture
}

interface AudioStartInfo {
  sample_rate: number;
  channels: number;
}

let invokeFn: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
let listenFn: ((event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>) | null = null;
let modsChecked = false;

async function loadTauri(): Promise<{ invoke: typeof invokeFn; listen: typeof listenFn } | null> {
  if (modsChecked) return invokeFn && listenFn ? { invoke: invokeFn, listen: listenFn } : null;
  modsChecked = true;
  if (typeof window === "undefined") return null;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (!w.__TAURI_INTERNALS__) return null;
  try {
    const core = await import("@tauri-apps/api/core");
    const event = await import("@tauri-apps/api/event");
    invokeFn = core.invoke as typeof invokeFn;
    listenFn = event.listen as typeof listenFn;
    return { invoke: invokeFn, listen: listenFn };
  } catch {
    return null;
  }
}

function hasAudioTrackGenerator(): boolean {
  return typeof (window as unknown as { MediaStreamTrackGenerator?: unknown }).MediaStreamTrackGenerator !== "undefined"
    && typeof (window as unknown as { AudioData?: unknown }).AudioData !== "undefined";
}

export async function isAudioAvailable(): Promise<boolean> {
  if (!hasAudioTrackGenerator()) return false;
  const tauri = await loadTauri();
  return !!tauri;
}

interface ActiveAudio {
  track: MediaStreamTrack;
  unlisten: () => void;
  stop: () => Promise<void>;
}

let active: ActiveAudio | null = null;

export async function startScreenAudio(): Promise<MediaStreamTrack> {
  if (active) {
    await stopScreenAudio();
  }
  const tauri = await loadTauri();
  if (!tauri || !tauri.invoke || !tauri.listen) {
    throw new Error("screen audio not available in this runtime");
  }
  if (!hasAudioTrackGenerator()) {
    throw new Error("MediaStreamTrackGenerator(audio) not supported");
  }

  const info = (await tauri.invoke("screen_audio_start")) as AudioStartInfo;
  const sampleRate = info.sample_rate;
  const channels = info.channels;

  type TrackGenCtor = new (init: { kind: "audio" }) => MediaStreamTrack & { writable: WritableStream<AudioData> };
  const TrackGen = (window as unknown as { MediaStreamTrackGenerator: TrackGenCtor }).MediaStreamTrackGenerator;
  const trackGen = new TrackGen({ kind: "audio" });
  const writer = trackGen.writable.getWriter();

  let stopped = false;
  const unlistenPromise = tauri.listen("screen-audio:pcm", (e: { payload: unknown }) => {
    if (stopped) return;
    const payload = e.payload as PcmPayload;
    // base64 → Uint8Array → Float32Array (interleaved).
    const bin = atob(payload.pcm);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const frameCount = Math.floor(f32.length / channels);
    if (frameCount === 0) return;
    try {
      const audioData = new AudioData({
        format: "f32",
        sampleRate,
        numberOfFrames: frameCount,
        numberOfChannels: channels,
        timestamp: payload.timestamp,
        data: f32
      });
      void writer.write(audioData).catch(() => { /* track closed */ });
      audioData.close();
    } catch (err) {
      console.warn("[screen-audio] write failed", err);
    }
  });

  const unlisten = await unlistenPromise;

  const stop = async (): Promise<void> => {
    stopped = true;
    try { unlisten(); } catch { /* ignore */ }
    try { await writer.close(); } catch { /* already closed */ }
    try { trackGen.stop(); } catch { /* ignore */ }
    try {
      await tauri.invoke?.("screen_audio_stop");
    } catch (err) {
      console.warn("[screen-audio] stop invoke failed", err);
    }
    if (active && active.track === trackGen) active = null;
  };

  active = { track: trackGen, unlisten, stop };
  return trackGen;
}

export async function stopScreenAudio(): Promise<void> {
  if (!active) return;
  await active.stop();
  active = null;
}

export function isScreenAudioActive(): boolean {
  return active !== null;
}
