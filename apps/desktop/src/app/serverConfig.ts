import { FetchTimeoutError, fetchWithTimeout } from "../network/fetchWithTimeout";

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

export const INSECURE_SERVER_WARNING =
  "Соединение не защищено (http): пароль и сообщения передаются открытым текстом. Используй адрес с https, если сервер его поддерживает.";

// HTTP без TLS: пароль и сообщения идут открытым текстом. Локальный адрес
// (localhost, loopback) безопасен по определению и предупреждения не требует.
export function isInsecureServerUrl(raw: string): boolean {
  try {
    const u = new URL(normalizeServerUrl(raw));
    if (u.protocol !== "http:") return false;
    const host = u.hostname.toLowerCase();
    const loopback = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]" || host === "::1";
    return !loopback;
  } catch {
    return false;
  }
}

export type ServerCheckKind = "invalid-url" | "timeout" | "network" | "http" | "not-rucord";

// Ошибка проверки сервера. message уже написан для пользователя и показывается как есть.
export class ServerCheckError extends Error {
  constructor(readonly kind: ServerCheckKind, message: string, readonly status?: number) {
    super(message);
    this.name = "ServerCheckError";
  }
}

const SERVER_CHECK_TIMEOUT_MS = 8_000;

// Проверка адреса сервера запросом GET /readyz. Браузер не различает DNS,
// недоверенный сертификат, закрытый порт и CORS (во всех случаях TypeError),
// поэтому для «network» перечисляются все вероятные причины.
export async function checkServerReachable(
  url: string,
  signal?: AbortSignal,
  timeoutMs: number = SERVER_CHECK_TIMEOUT_MS
): Promise<void> {
  const base = normalizeServerUrl(url);
  try {
    new URL(base);
  } catch {
    throw new ServerCheckError("invalid-url", "Адрес указан неверно. Пример: chat.example.com");
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(`${base}/readyz`, { method: "GET", signal }, timeoutMs);
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof FetchTimeoutError) {
      throw new ServerCheckError("timeout", `Сервер не ответил за ${Math.round(timeoutMs / 1000)} с`);
    }
    throw new ServerCheckError(
      "network",
      "Нет связи с сервером. Проверь адрес, интернет, сертификат сервера и настройки CORS"
    );
  }

  if (!response.ok) {
    throw new ServerCheckError("http", `Сервер ответил кодом ${response.status}`, response.status);
  }

  let payload: unknown = null;
  try {
    payload = await readJsonWithin(response, timeoutMs);
  } catch (err) {
    if (err instanceof FetchTimeoutError) {
      throw new ServerCheckError("timeout", `Сервер не ответил за ${Math.round(timeoutMs / 1000)} с`);
    }
    /* тело не JSON */
  }
  if (!isReadyPayload(payload)) {
    throw new ServerCheckError("not-rucord", "Это не сервер RuCord: ответ на /readyz не распознан");
  }
}

// Таймер fetchWithTimeout снимается после получения заголовков, поэтому
// сервер, который прислал заголовки и замолчал, подвесил бы проверку навсегда.
function readJsonWithin(response: Response, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void response.body?.cancel().catch(() => undefined);
      reject(new FetchTimeoutError(timeoutMs));
    }, timeoutMs);
    response.json().then(
      (value: unknown) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function isReadyPayload(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && (payload as { status?: unknown }).status === "ready";
}
