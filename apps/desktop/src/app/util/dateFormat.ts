import { hour12Setting, intlLocale } from "../i18n";

const formatters = new Map<string, Intl.DateTimeFormat>();

// Creating an ICU formatter for every timestamp dominates the first message render.
export function formatDate(
  date: Date,
  options: Intl.DateTimeFormatOptions,
): string {
  const locale = intlLocale();
  const key = `${locale}:${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, formatter);
  }
  return formatter.format(date);
}

export function prepareMessageDateFormats(): void {
  const hour12 = hour12Setting();
  const date = new Date();
  for (const options of [
    {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12,
    },
    { hour: "2-digit", minute: "2-digit", hour12 },
    { weekday: "long" },
    { day: "2-digit", month: "2-digit", year: "numeric" },
    { day: "numeric", month: "long", year: "numeric" },
  ] as Intl.DateTimeFormatOptions[])
    formatDate(date, options);
}
