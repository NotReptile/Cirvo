const STORAGE_KEY = "rucord:server-url";

export function getStoredServerUrl(): string | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeServerUrl(raw);
  } catch {
    return null;
  }
}

export function setStoredServerUrl(url: string): void {
  window.localStorage.setItem(STORAGE_KEY, normalizeServerUrl(url));
}

export function clearStoredServerUrl(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

export function normalizeServerUrl(raw: string): string {
  let value = raw.trim();
  if (!value) return value;
  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  return value.replace(/\/+$/, "");
}

export function deriveRealtimeUrl(apiBaseUrl: string): string {
  const u = new URL(apiBaseUrl);
  const scheme = u.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${u.host}/ws`;
}

export function isProductionShell(): boolean {
  return !import.meta.env.DEV;
}

export async function checkServerReachable(url: string, signal?: AbortSignal): Promise<void> {
  const target = `${normalizeServerUrl(url)}/readyz`;
  const response = await fetch(target, { method: "GET", signal });
  if (!response.ok) {
    throw new Error(`Сервер ответил ${response.status}`);
  }
}
