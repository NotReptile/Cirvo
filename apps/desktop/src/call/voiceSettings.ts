// I.2: Voice & video settings — единая точка истины для всех мест,
// которые тянут микрофон/камеру/динамики (callManager, voiceChannelManager,
// settings-таб «Голос и видео»). Все настройки персистятся в localStorage,
// чтобы выживали refresh. Менеджеры запрашивают `audio:`/`video:` constraints
// только через build*Constraints — иначе настройки не применятся в новых
// звонках.

export type CameraResolution = "360p" | "720p" | "1080p";

// I.3: режимы шумоподавления. `off` — никакого NS; `browser` — нативный
// WebRTC-стек Chromium (NS3); `rucord` / `rucord-aggressive` —
// собственные ML-модели (планируются в N.*, пока fallback на browser).
export type DenoiserMode = "off" | "browser" | "rucord" | "rucord-aggressive";

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
  // I.9: push-to-talk режим. Когда включён — микрофон по умолчанию замьючен,
  // unmute только пока зажат PTT-биндинг из I.4. `pttReleaseDelay` — сколько
  // мс держать unmute после отпускания клавиши, чтобы не обрывать речь на
  // микропаузах. 0 = моментально.
  pushToTalk: boolean;
  pttReleaseDelay: number; // 0..2000 ms
}

const LS_KEY = "rucord:voice-settings";

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

// Constraints для getUserMedia({audio}). Шумоподавление выводится из
// denoiserMode: off → false, остальные → true (нативный браузерный NS
// остаётся базой; rucord-режимы — поверх через AudioWorklet, когда
// N.* реализован). Пока N.* не готов, rucord-режимы эквивалентны
// browser'у на runtime.
export function buildAudioConstraints(): MediaTrackConstraints {
  const s = read();
  const c: MediaTrackConstraints = {
    echoCancellation: s.echoCancellation,
    autoGainControl: s.autoGainControl,
    noiseSuppression: s.denoiserMode !== "off"
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
  const id = getOutputDeviceId();
  if (!id) return;
  const elWithSink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof elWithSink.setSinkId !== "function") return;
  if ((el as HTMLMediaElement & { sinkId?: string }).sinkId === id) return;
  try {
    await elWithSink.setSinkId(id);
  } catch {
    /* device может быть отключено — фоллбек на дефолт */
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
