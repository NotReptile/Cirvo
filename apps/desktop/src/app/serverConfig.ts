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
    value = `${defaultScheme(value)}://${value}`;
  }
  return value.replace(/\/+$/, "");
}

function defaultScheme(rawWithoutScheme: string): "http" | "https" {
  const authority = rawWithoutScheme.split(/[/?#]/, 1)[0] ?? rawWithoutScheme;
  const host = stripPort(authority.replace(/^\[(.*)\]$/, "$1").toLowerCase());
  if (host === "localhost" || host.endsWith(".localhost")) return "http";
  if (isIPv4(host) || isIPv6(host)) return "http";
  return "https";
}

function stripPort(authority: string): string {
  const at = authority.lastIndexOf("@");
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  const bracketed = hostPort.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  if (hostPort.includes(":") && hostPort.split(":").length > 2) return hostPort;
  return hostPort.replace(/:\d+$/, "");
}

function isIPv4(host: string): boolean {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

function isIPv6(host: string): boolean {
  return host.includes(":") && /^[0-9a-f:.]+$/i.test(host);
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
