import { t } from "../i18n";
import { formatDate } from "./dateFormat";

export function dayKeyOf(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sod = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((sod(now) - sod(d)) / 86400000);
  if (diff === 0) return t("date.today");
  if (diff === 1) return t("date.yesterday");
  return formatDate(d, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
