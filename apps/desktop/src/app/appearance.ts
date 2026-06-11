// I.5: тема и внешний вид. Persist в localStorage, применение на
// bootstrap'е и при изменении в settings. Никаких импортов из ui.ts —
// модуль самодостаточный, чтобы его мог дёрнуть bootstrap до того,
// как ui-state инициализирован.

export type ThemeMode = "dark" | "light" | "auto";
export type Density = "cozy" | "compact";
// Wave 7 (I.14): анимация GIF/APNG-аватаров. hover = статичный первый
// кадр, анимация при наведении; never = всегда статичный кадр.
export type GifAvatarsMode = "always" | "hover" | "never";

export interface AppearanceSettings {
  theme: ThemeMode;
  accent: string; // hex #rrggbb или "" = дефолт темы
  density: Density;
  groupMessages: boolean; // склеивать подряд идущие от одного автора
  roleColors: boolean; // подсвечивать имя автора цветом роли
  gifAvatars: GifAvatarsMode;
}

const LS_KEY = "rucord:appearance";

const DEFAULTS: AppearanceSettings = {
  theme: "dark",
  accent: "",
  density: "cozy",
  groupMessages: true,
  roleColors: true,
  gifAvatars: "always"
};

let cache: AppearanceSettings | null = null;

function read(): AppearanceSettings {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppearanceSettings>;
      cache = { ...DEFAULTS, ...parsed };
      return cache;
    }
  } catch {
    /* corrupt JSON */
  }
  cache = { ...DEFAULTS };
  return cache;
}

function write(next: AppearanceSettings): void {
  cache = next;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch {
    /* quota */
  }
  applyAppearance();
}

export function getAppearance(): AppearanceSettings {
  return read();
}

export function updateAppearance(patch: Partial<AppearanceSettings>): AppearanceSettings {
  const next = { ...read(), ...patch };
  write(next);
  return next;
}

// resolveTheme — для "auto" смотрит prefers-color-scheme. Вызывается
// каждый раз при applyAppearance, чтобы при смене системной темы UI
// подхватывал (плюс есть listener'а на matchMedia ниже).
function resolveTheme(mode: ThemeMode): "dark" | "light" {
  if (mode === "auto") {
    const mq = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-color-scheme: light)")
      : null;
    return mq && mq.matches ? "light" : "dark";
  }
  return mode;
}

export function applyAppearance(): void {
  if (typeof document === "undefined") return;
  const s = read();
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(s.theme);
  if (s.density === "compact") root.dataset.density = "compact";
  else delete root.dataset.density;
  if (s.accent) {
    root.style.setProperty("--accent", s.accent);
    // Hover: чуть темнее основного. color-mix даёт ровный результат без
    // ручного rgb-arithmetic.
    root.style.setProperty("--accent-hover", `color-mix(in srgb, ${s.accent} 80%, black)`);
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-hover");
  }
  if (!s.groupMessages) root.dataset.groupMessages = "off";
  else delete root.dataset.groupMessages;
  if (!s.roleColors) root.dataset.roleColors = "off";
  else delete root.dataset.roleColors;
}

let _autoListenerInstalled = false;
export function watchSystemTheme(): void {
  if (_autoListenerInstalled) return;
  if (typeof window === "undefined" || !window.matchMedia) return;
  _autoListenerInstalled = true;
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const onChange = () => {
    // Применяем только если юзер в "auto" режиме — иначе явный выбор
    // юзера не должен «перетираться» системой.
    if (read().theme === "auto") applyAppearance();
  };
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
  else if (typeof mq.addListener === "function") mq.addListener(onChange);
}
