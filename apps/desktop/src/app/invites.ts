// Срок жизни приглашений: варианты выбора, расчёт expiresAt для API и подпись в списке.

export interface InviteTtlOption {
  value: string;
  label: string;
  seconds: number;
}

export const INVITE_TTL_OPTIONS: InviteTtlOption[] = [
  { value: "0", label: "Без срока", seconds: 0 },
  { value: "3600", label: "1 час", seconds: 3600 },
  { value: "86400", label: "1 день", seconds: 86400 },
  { value: "604800", label: "7 дней", seconds: 604800 },
  { value: "2592000", label: "30 дней", seconds: 2592000 }
];

// RFC3339 для поля expiresAt или undefined, если срока нет. Значение вне
// списка (пустое, нечисловое, отрицательное) тоже значит «без срока».
export function inviteExpiresAt(ttlSeconds: unknown, now: number = Date.now()): string | undefined {
  const seconds = Number(ttlSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(now + seconds * 1000).toISOString();
}

export function isInviteExpired(expiresAt: string | undefined, now: number = Date.now()): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at <= now;
}

// Подпись срока в списке: пусто, «до 15.10 14:00» или «истёк».
export function inviteExpiryLabel(expiresAt: string | undefined, now: number = Date.now()): string {
  if (!expiresAt) return "";
  if (isInviteExpired(expiresAt, now)) return "истёк";
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return "";
  const text = date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  return `до ${text}`;
}
