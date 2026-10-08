// Единицы измерения для полей админки. Лимиты хранятся и передаются в байтах,
// а вводить их удобнее в мегабайтах.

const BYTES_IN_MB = 1024 * 1024;

// Байты в мегабайты для поля ввода: до двух знаков после запятой, без
// хвостовых нулей (26214400 -> "25", 1572864 -> "1.5").
export function bytesToMb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0";
  return String(Math.round((bytes / BYTES_IN_MB) * 100) / 100);
}

// Мегабайты из поля ввода в байты. Пустое, отрицательное и нечисловое значение
// даёт null: поле не отправляется, настройка остаётся прежней.
export function mbToBytes(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  const mb = Number(trimmed);
  if (!Number.isFinite(mb) || mb < 0) return null;
  return Math.round(mb * BYTES_IN_MB);
}
