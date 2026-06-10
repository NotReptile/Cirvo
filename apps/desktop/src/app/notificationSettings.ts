// I.8: глобальные настройки уведомлений. Frontend-only, персистится в
// localStorage. Влияет на (а) показывать ли desktop-notification через
// Web Notifications API, (b) проигрывать ли звук при входящем event'е,
// (c) подавлять ли @everyone/@here-уведомления (Wave 4: сервер шлёт
// kind="mention_everyone", флаг глушит их popup+звук).

// Wave 4: выбор звука. Все варианты синтезируются WebAudio — без ассетов.
export type NotificationSoundKind = "beep" | "ding" | "pop" | "chime";

export const SOUND_LABELS: Record<NotificationSoundKind, string> = {
  beep: "Бип (классика)",
  ding: "Динь",
  pop: "Поп",
  chime: "Перезвон"
};

export interface NotificationSettings {
  desktopEnabled: boolean;
  soundEnabled: boolean;
  muteEveryone: boolean;
  sound: NotificationSoundKind;
}

const LS_KEY = "rucord:notifications";

const DEFAULTS: NotificationSettings = {
  desktopEnabled: true,
  soundEnabled: true,
  muteEveryone: false,
  sound: "beep"
};

let cache: NotificationSettings | null = null;

function read(): NotificationSettings {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<NotificationSettings>;
      cache = { ...DEFAULTS, ...parsed };
      return cache;
    }
  } catch {
    /* corrupt JSON — fallback */
  }
  cache = { ...DEFAULTS };
  return cache;
}

export function getNotificationSettings(): NotificationSettings {
  return read();
}

export function updateNotificationSettings(
  patch: Partial<NotificationSettings>
): NotificationSettings {
  const next = { ...read(), ...patch };
  cache = next;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch {
    /* quota / disabled */
  }
  return next;
}

// Звуки синтезируются WebAudio — без wav-ассетов. Громкость ~0.08 (не пугаем).
let audioCtx: AudioContext | null = null;

// Один тон: частота, время старта (отступ от now), длительность, форма.
function tone(ctx: AudioContext, freq: number, at: number, dur: number, type: OscillatorType = "sine", vol = 0.08): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime + at);
  gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
  gain.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime + at);
  osc.stop(ctx.currentTime + at + dur + 0.02);
}

// preview — проиграть конкретный вариант (для «Прослушать» в настройках),
// игнорируя soundEnabled.
export function playNotificationSound(preview?: NotificationSoundKind): void {
  const settings = read();
  if (!preview && !settings.soundEnabled) return;
  if (typeof window === "undefined") return;
  type AC = typeof AudioContext;
  const Ctor: AC | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AC }).webkitAudioContext;
  if (!Ctor) return;
  try {
    if (!audioCtx) audioCtx = new Ctor();
    const ctx = audioCtx;
    switch (preview ?? settings.sound) {
      case "ding":
        tone(ctx, 1320, 0, 0.4);
        break;
      case "pop":
        tone(ctx, 300, 0, 0.07, "triangle", 0.12);
        tone(ctx, 180, 0.02, 0.06, "triangle", 0.1);
        break;
      case "chime":
        tone(ctx, 660, 0, 0.18);
        tone(ctx, 880, 0.1, 0.18);
        tone(ctx, 990, 0.2, 0.3);
        break;
      default: // beep — классический двухчастотный
        tone(ctx, 880, 0, 0.08);
        tone(ctx, 660, 0.06, 0.12);
        break;
    }
  } catch {
    /* autoplay-policy блокирует AudioContext до первого user gesture —
       молча игнорим, юзер услышит звук после первого клика */
  }
}

