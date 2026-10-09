import { getLocale, hour12Setting, t } from "../i18n";
import { formatDate } from "./dateFormat";

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return formatDate(date, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: hour12Setting(),
  });
}

// formatTimeSmartShort — «14:32». Используется как hover-метка в группе
// сообщений одного автора (Discord-pattern: первое сообщение группы
// показывает полную дату, последующие — только HH:MM при hover'е).
export function formatTimeSmartShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return formatDate(date, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: hour12Setting(),
  });
}

// formatTimeSmart — «Сегодня в 14:32» / «Вчера в 23:01» / «18.05.2026 в 14:32».
// Discord-pattern: timestamps в потоке сообщений и в notifications читаются
// глазом мгновенно, без перевода даты в голове.
//
// I.7: формат часов уважает getTimeFormat() (auto/h12/h24); локаль — intlLocale().
// Weekday и DMY также берут текущую локаль ru-RU/en-US. Сепаратор «в»/«at»
// — через t("time.today"/"time.yesterday") (для today/yesterday) и просто
// space-join для других дней (английский нативно говорит "Monday 14:32",
// без предлога).
export function formatTimeSmart(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const startOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfMsgDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const dayDiff = Math.round((startOfDay - startOfMsgDay) / 86400000);
  const h12 = hour12Setting();
  const hm = formatDate(date, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: h12,
  });
  if (dayDiff === 0) return `${t("time.today")} ${hm}`;
  if (dayDiff === 1) return `${t("time.yesterday")} ${hm}`;
  if (dayDiff > 1 && dayDiff < 7) {
    const weekday = formatDate(date, { weekday: "long" });
    return getLocale() === "en" ? `${weekday} ${hm}` : `${weekday} в ${hm}`;
  }
  const dmy = formatDate(date, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  return getLocale() === "en" ? `${dmy} ${hm}` : `${dmy} в ${hm}`;
}
