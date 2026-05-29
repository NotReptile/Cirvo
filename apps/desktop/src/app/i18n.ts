// I.7: язык и формат времени.
//
// Минимальная инфраструктура для i18n + time-format. Локаль и time-format
// персистятся в localStorage и читаются на старте. t("key") — функция
// перевода с fallback на ключ если строки нет в словаре (Wesensgleich:
// видишь `settings.language.title` в UI = забыли добавить перевод).
//
// Coverage migration — инкрементальный: новые/часто-видимые строки сразу
// идут через t(), миграция остальных по мере касания. Это нормальный
// подход для постепенной локализации без big-bang переписывания
// 9000-строчного ui.ts за один присест.
//
// Backend strings (audit-actions, system messages, server errors) НЕ
// локализуем — они приходят на русском от сервера и остаются как есть.

export type Locale = "ru" | "en";
export type TimeFormat = "auto" | "h12" | "h24";

const LOCALE_KEY = "rucord:locale";
const TIME_FORMAT_KEY = "rucord:time-format";
const DEFAULT_LOCALE: Locale = "ru";
const DEFAULT_TIME_FORMAT: TimeFormat = "auto";

let currentLocale: Locale = readStoredLocale();
let currentTimeFormat: TimeFormat = readStoredTimeFormat();

const listeners = new Set<() => void>();

function readStoredLocale(): Locale {
  try {
    const raw = localStorage.getItem(LOCALE_KEY);
    if (raw === "ru" || raw === "en") return raw;
  } catch { /* ignore */ }
  return DEFAULT_LOCALE;
}

function readStoredTimeFormat(): TimeFormat {
  try {
    const raw = localStorage.getItem(TIME_FORMAT_KEY);
    if (raw === "auto" || raw === "h12" || raw === "h24") return raw;
  } catch { /* ignore */ }
  return DEFAULT_TIME_FORMAT;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (currentLocale === locale) return;
  currentLocale = locale;
  try { localStorage.setItem(LOCALE_KEY, locale); } catch { /* ignore */ }
  notify();
}

export function getTimeFormat(): TimeFormat {
  return currentTimeFormat;
}

export function setTimeFormat(fmt: TimeFormat): void {
  if (currentTimeFormat === fmt) return;
  currentTimeFormat = fmt;
  try { localStorage.setItem(TIME_FORMAT_KEY, fmt); } catch { /* ignore */ }
  notify();
}

// hour12 mapping для Intl.DateTimeFormat. undefined = пусть Intl выберет
// по локали; true/false override.
export function hour12Setting(): boolean | undefined {
  if (currentTimeFormat === "h12") return true;
  if (currentTimeFormat === "h24") return false;
  return undefined;
}

// BCP-47 locale tag для Intl. У браузера локаль может быть `ru-RU`/`en-US`/etc;
// для format'а нам нужно chevet просто `ru` или `en`.
export function intlLocale(): string {
  return currentLocale === "ru" ? "ru-RU" : "en-US";
}

export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const l of Array.from(listeners)) {
    try { l(); } catch { /* ignore */ }
  }
}

// ---- словарь ---------------------------------------------------------------

type Dict = Record<string, string>;
type DictMap = Record<Locale, Dict>;

const DICT: DictMap = {
  ru: {
    "common.save": "Сохранить",
    "common.cancel": "Отмена",
    "common.close": "Закрыть",
    "common.delete": "Удалить",
    "common.loading": "Загрузка…",
    "settings.group.account": "Аккаунт",
    "settings.group.interact": "Взаимодействие",
    "settings.group.appearance": "Внешний вид",
    "settings.group.advanced": "Расширенные",
    "settings.tab.profile": "Профиль",
    "settings.tab.privacy": "Конфиденциальность",
    "settings.tab.voice": "Голос и видео",
    "settings.tab.notifications": "Уведомления",
    "settings.tab.hotkeys": "Горячие клавиши",
    "settings.tab.language": "Язык и время",
    "settings.tab.appearance": "Внешний вид",
    "settings.tab.advanced": "Расширенные",
    "settings.search": "Поиск настроек",
    "settings.logout": "Выйти из аккаунта",
    "settings.user.edit": "Редактировать профиль…",
    "settings.language.title": "Язык интерфейса",
    "settings.language.hint": "Перезагрузка не требуется — UI обновится сразу. Серверные сообщения (журнал событий, системные плашки) остаются на русском.",
    "settings.language.option.ru": "Русский",
    "settings.language.option.en": "English",
    "settings.timeformat.title": "Формат времени",
    "settings.timeformat.hint": "Автоматически — как настроена операционная система. Иначе принудительно 12/24-часовой формат.",
    "settings.timeformat.option.auto": "Автоматически",
    "settings.timeformat.option.h12": "12-часовой (AM/PM)",
    "settings.timeformat.option.h24": "24-часовой",
    "time.today": "Сегодня в",
    "time.yesterday": "Вчера в"
  },
  en: {
    "common.save": "Save",
    "common.cancel": "Cancel",
    "common.close": "Close",
    "common.delete": "Delete",
    "common.loading": "Loading…",
    "settings.group.account": "Account",
    "settings.group.interact": "Interaction",
    "settings.group.appearance": "Appearance",
    "settings.group.advanced": "Advanced",
    "settings.tab.profile": "Profile",
    "settings.tab.privacy": "Privacy",
    "settings.tab.voice": "Voice & video",
    "settings.tab.notifications": "Notifications",
    "settings.tab.hotkeys": "Keyboard shortcuts",
    "settings.tab.language": "Language & time",
    "settings.tab.appearance": "Appearance",
    "settings.tab.advanced": "Advanced",
    "settings.search": "Search settings",
    "settings.logout": "Log out",
    "settings.user.edit": "Edit profile…",
    "settings.language.title": "Interface language",
    "settings.language.hint": "No reload needed — the UI refreshes immediately. Server messages (audit log, system notices) remain in Russian.",
    "settings.language.option.ru": "Russian",
    "settings.language.option.en": "English",
    "settings.timeformat.title": "Time format",
    "settings.timeformat.hint": "Automatic — follows the operating system. Otherwise force 12- or 24-hour clock.",
    "settings.timeformat.option.auto": "Automatic",
    "settings.timeformat.option.h12": "12-hour (AM/PM)",
    "settings.timeformat.option.h24": "24-hour",
    "time.today": "Today at",
    "time.yesterday": "Yesterday at"
  }
};

export function t(key: string): string {
  const dict = DICT[currentLocale];
  return dict[key] ?? DICT[DEFAULT_LOCALE][key] ?? key;
}
