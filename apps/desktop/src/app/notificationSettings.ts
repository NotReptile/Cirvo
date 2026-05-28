// I.8: глобальные настройки уведомлений. Frontend-only, персистится в
// localStorage. Влияет на (а) показывать ли desktop-notification через
// Web Notifications API, (b) проигрывать ли звук при входящем event'е,
// (c) подавлять ли @everyone/@here-уведомления (feature ещё не
// реализована серверно, флаг — задел на будущее).

export interface NotificationSettings {
  desktopEnabled: boolean;
  soundEnabled: boolean;
  muteEveryone: boolean;
}

const LS_KEY = "rucord:notifications";

const DEFAULTS: NotificationSettings = {
  desktopEnabled: true,
  soundEnabled: true,
  muteEveryone: false
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

// Короткий beep через WebAudio — без wav-ассета. ~120ms синусоиды 880 Hz
// с быстрым fade-out, общая громкость 0.08 (не пугаем).
let audioCtx: AudioContext | null = null;

export function playNotificationSound(): void {
  if (!read().soundEnabled) return;
  if (typeof window === "undefined") return;
  type AC = typeof AudioContext;
  const Ctor: AC | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AC }).webkitAudioContext;
  if (!Ctor) return;
  try {
    if (!audioCtx) audioCtx = new Ctor();
    const ctx = audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(660, ctx.currentTime + 0.06);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  } catch {
    /* autoplay-policy блокирует AudioContext до первого user gesture —
       молча игнорим, юзер услышит beep после первого клика */
  }
}

// Сейчас @everyone серверно ещё не реализован — пока эвристика по тексту
// сообщения. Когда серверный mention.kind="everyone" появится — заменим.
export function isEveryoneMention(body: string | undefined): boolean {
  if (!body) return false;
  return /(?:^|\s)@(everyone|here)\b/i.test(body);
}
