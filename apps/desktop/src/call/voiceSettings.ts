// I.2: Voice & video settings — единая точка истины для всех мест,
// которые тянут микрофон/камеру/динамики (callManager, voiceChannelManager,
// settings-таб «Голос и видео»). Все настройки персистятся в localStorage,
// чтобы выживали refresh. Менеджеры запрашивают `audio:`/`video:` constraints
// только через build*Constraints — иначе настройки не применятся в новых
// звонках.

export type CameraResolution = "360p" | "720p" | "1080p";

// I.3: режимы шумоподавления. `off` — никакого NS; `browser` — нативный
// WebRTC-стек Chromium (NS3); `cirvo` — RNNoise через AudioWorklet
// (denoiser.ts, интенсивность = dry/wet микс); `cirvo-aggressive` —
// нативный NS + RNNoise на 100% поверх.
export type DenoiserMode = "off" | "browser" | "cirvo" | "cirvo-aggressive";

// Wave 9: эффект камеры (videoEffects.ts) — размытие фона через Mediapipe
// Selfie Segmentation. Применяется при следующем включении камеры.
export type CameraEffect = "none" | "blur-light" | "blur-strong";

export interface VoiceSettings {
  audioInputId: string | null; // null = system default
  audioOutputId: string | null;
  videoInputId: string | null;
  micGain: number; // 0..2 (1 = native, >1 — boost через GainNode)
  outputVolume: number; // 0..1 (для HTMLMediaElement.volume)
  cameraResolution: CameraResolution;
  echoCancellation: boolean;
  autoGainControl: boolean;
  // I.3: единый источник истины для шумоподавления. Раньше тут был
  // bool noiseSuppression — он же теперь выводится из denoiserMode
  // в buildAudioConstraints() (off → false, остальные → true).
  denoiserMode: DenoiserMode;
  denoiserIntensity: number; // 0..100, применится когда N.* модели появятся
  // Wave 9: размытие фона камеры. Живёт здесь же, потому что и звук, и
  // видео настраиваются в одном табе «Голос и видео».
  cameraEffect: CameraEffect;
  // I.9: push-to-talk режим. Когда включён — микрофон по умолчанию замьючен,
  // unmute только пока зажат PTT-биндинг из I.4. `pttReleaseDelay` — сколько
  // мс держать unmute после отпускания клавиши, чтобы не обрывать речь на
  // микропаузах. 0 = моментально.
  pushToTalk: boolean;
  pttReleaseDelay: number; // 0..2000 ms
}

const LS_KEY = "cirvo:voice-settings";

const DEFAULTS: VoiceSettings = {
  audioInputId: null,
  audioOutputId: null,
  videoInputId: null,
  micGain: 1,
  outputVolume: 1,
  cameraResolution: "720p",
  echoCancellation: true,
  autoGainControl: true,
  denoiserMode: "browser",
  denoiserIntensity: 50,
  cameraEffect: "none",
  pushToTalk: false,
  pttReleaseDelay: 200
};

const RESOLUTION_PROFILES: Record<CameraResolution, { width: number; height: number }> = {
  "360p": { width: 640, height: 360 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 }
};

let cache: VoiceSettings | null = null;
const listeners: Array<(s: VoiceSettings) => void> = [];

function read(): VoiceSettings {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<VoiceSettings>;
      cache = { ...DEFAULTS, ...parsed };
      return cache;
    }
  } catch {
    /* ignore corrupt JSON */
  }
  cache = { ...DEFAULTS };
  return cache;
}

function write(next: VoiceSettings): void {
  cache = next;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch {
    /* quota / disabled storage */
  }
  for (const fn of listeners) fn(next);
}

export function getVoiceSettings(): VoiceSettings {
  return read();
}

export function updateVoiceSettings(patch: Partial<VoiceSettings>): VoiceSettings {
  const next = { ...read(), ...patch };
  write(next);
  return next;
}

export function subscribeVoiceSettings(fn: (s: VoiceSettings) => void): () => void {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

// Constraints для getUserMedia({audio}). Матрица NS по denoiserMode (N.2/N.4):
//   off               → нативный NS выключен, RNNoise нет;
//   browser           → только нативный NS Chromium (NS3);
//   cirvo            → нативный NS ВЫКЛЮЧЕН — RNNoise (denoiser.ts) должен
//                       видеть сырой шум, иначе два NS подряд режут речь;
//   cirvo-aggressive → нативный NS + RNNoise 100% поверх (максимум подавления).
export function buildAudioConstraints(): MediaTrackConstraints {
  const s = read();
  const c: MediaTrackConstraints = {
    echoCancellation: s.echoCancellation,
    autoGainControl: s.autoGainControl,
    noiseSuppression: s.denoiserMode === "browser" || s.denoiserMode === "cirvo-aggressive"
  };
  if (s.audioInputId) {
    c.deviceId = { exact: s.audioInputId };
  }
  return c;
}

// Для getUserMedia({video}). Если камера не выбрана и нет custom-разрешения —
// возвращаем `true` чтобы браузер сам подобрал.
export function buildVideoConstraints(): MediaTrackConstraints | boolean {
  const s = read();
  const profile = RESOLUTION_PROFILES[s.cameraResolution] ?? RESOLUTION_PROFILES["720p"];
  const c: MediaTrackConstraints = {
    width: { ideal: profile.width },
    height: { ideal: profile.height }
  };
  if (s.videoInputId) {
    c.deviceId = { exact: s.videoInputId };
  }
  return c;
}

export function getOutputDeviceId(): string | null {
  return read().audioOutputId;
}

export function getOutputVolume(): number {
  return read().outputVolume;
}

// Применить выбранный output-device к HTMLMediaElement (setSinkId
// поддерживается в Chromium/Edge, не во всех Safari/Firefox — на
// неподдерживаемых тихо игнорируем).
export async function applyOutputDevice(el: HTMLMediaElement): Promise<void> {
  const id = getOutputDeviceId() ?? "";
  const elWithSink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof elWithSink.setSinkId !== "function") return;
  if ((el as HTMLMediaElement & { sinkId?: string }).sinkId === id) return;
  try {
    await elWithSink.setSinkId(id);
  } catch (err) {
    if (id && err instanceof DOMException && err.name === "NotFoundError") {
      await elWithSink.setSinkId("");
      if (getOutputDeviceId() === id) updateVoiceSettings({ audioOutputId: null });
      return;
    }
    throw err;
  }
}

export interface EnumeratedDevices {
  audioInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
}

export async function enumerateVoiceDevices(): Promise<EnumeratedDevices> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { audioInputs: [], audioOutputs: [], videoInputs: [] };
  }
  const list = await navigator.mediaDevices.enumerateDevices();
  return {
    audioInputs: list.filter((d) => d.kind === "audioinput"),
    audioOutputs: list.filter((d) => d.kind === "audiooutput"),
    videoInputs: list.filter((d) => d.kind === "videoinput")
  };
}
