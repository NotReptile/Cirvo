import { DEFAULT_FETCH_TIMEOUT_MS, FetchTimeoutError, fetchWithTimeout } from "./fetchWithTimeout";

export interface AuthTokens {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  sessionId: string;
}

export interface AuthSession extends AuthTokens {
  user: {
    id: string;
    email: string;
    username: string;
    displayName?: string;
  };
}

export interface ApiError {
  // 0 = ответа не было: нет связи с сервером или истёк таймаут (code: "network" | "timeout").
  status: number;
  code: string;
  message: string;
  requestId?: string;
  // J.3(b): для 429 ответов читаем Retry-After (в секундах). Используется
  // composer'ом для slow-mode countdown — показывает «подожди X сек» вместо
  // generic-ошибки.
  retryAfter?: number;
}

interface ErrorEnvelope {
  error: { code: string; message: string; requestId?: string };
}

export function isApiError(err: unknown): err is ApiError {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Partial<ApiError>;
  return typeof e.status === "number" && typeof e.code === "string" && typeof e.message === "string";
}

// Сервер недоступен или временно сбоит: сессию из-за этого сбрасывать нельзя,
// запрос стоит повторить (идемпотентный GET повторяется автоматически).
export function isTransientError(err: unknown): boolean {
  return isApiError(err) && (err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504);
}

// Сервер сказал, что сессия недействительна (токены просрочены, отозваны или
// аккаунт заблокирован). Только в этом случае клиент должен разлогинить.
export function isSessionRejected(err: unknown): boolean {
  return isApiError(err) && (err.status === 401 || err.status === 403);
}

// Отказ именно на обновлении токена: refresh-токен недействителен.
function isRefreshRejected(err: unknown): boolean {
  return isApiError(err) && (err.status === 400 || err.status === 401 || err.status === 403);
}

const UPLOAD_TIMEOUT_MS = 120_000;
const GET_RETRY_DELAY_MS = 400;

function transportError(code: "network" | "timeout", message: string): ApiError {
  return { status: 0, code, message };
}

async function sendRequest(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetchWithTimeout(url, init, timeoutMs);
  } catch (err) {
    if (err instanceof FetchTimeoutError) {
      throw transportError("timeout", `Сервер не отвечает (таймаут ${Math.round(timeoutMs / 1000)} с)`);
    }
    throw transportError("network", "Нет связи с сервером");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type TokenChangeListener = (tokens: AuthTokens | null) => void;

const TOKEN_STORAGE_KEY = "rucord:tokens";

export class HttpClient {
  private tokens: AuthTokens | null = null;
  private refreshPromise: Promise<void> | null = null;
  private listeners = new Set<TokenChangeListener>();

  constructor(readonly baseUrl: string) {
    this.tokens = readStoredTokens();
  }

  onTokensChanged(listener: TokenChangeListener): () => void {
    this.listeners.add(listener);
    listener(this.tokens);
    return () => this.listeners.delete(listener);
  }

  getTokens(): AuthTokens | null {
    return this.tokens;
  }

  setTokens(tokens: AuthTokens | null): void {
    this.tokens = tokens;
    if (tokens) {
      localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
    for (const listener of this.listeners) {
      listener(tokens);
    }
  }

  async uploadFile<T>(path: string, file: File): Promise<T> {
    const form = new FormData();
    form.append("file", file, file.name);
    if (this.tokens && this.isAccessExpired()) {
      await this.refresh();
    }
    const usedToken = this.tokens?.accessToken ?? null;
    let response = await this.doUpload(path, form);
    if (response.status === 401 && this.tokens) {
      await this.refreshAfter401(response, usedToken);
      response = await this.doUpload(path, form);
    }
    if (!response.ok) {
      throw await toApiError(response);
    }
    return parseBody<T>(response);
  }

  async getBlob(path: string): Promise<Blob> {
    if (this.tokens && this.isAccessExpired()) {
      await this.refresh();
    }
    const usedToken = this.tokens?.accessToken ?? null;
    let response = await this.doFetch("GET", path, undefined, true);
    if (response.status === 401 && this.tokens) {
      await this.refreshAfter401(response, usedToken);
      response = await this.doFetch("GET", path, undefined, true);
    }
    if (!response.ok) {
      throw await toApiError(response);
    }
    return response.blob();
  }

  private async doUpload(path: string, form: FormData): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.tokens) headers["Authorization"] = `Bearer ${this.tokens.accessToken}`;
    return sendRequest(`${this.baseUrl}${path}`, { method: "POST", headers, body: form }, UPLOAD_TIMEOUT_MS);
  }

  // Идемпотентный GET при недоступности сервера (нет связи, таймаут, 502-504)
  // повторяется один раз. Остальные методы не повторяются: сообщение или
  // загрузка могли дойти до сервера.
  async request<T>(method: string, path: string, body?: unknown, init?: { auth?: boolean }): Promise<T> {
    if (method !== "GET") return this.requestOnce<T>(method, path, body, init);
    try {
      return await this.requestOnce<T>(method, path, body, init);
    } catch (err) {
      if (!isTransientError(err)) throw err;
      await delay(GET_RETRY_DELAY_MS);
      return this.requestOnce<T>(method, path, body, init);
    }
  }

  private async requestOnce<T>(method: string, path: string, body?: unknown, init?: { auth?: boolean }): Promise<T> {
    const needsAuth = init?.auth !== false;
    if (needsAuth && this.tokens && this.isAccessExpired()) {
      await this.refresh();
    }
    const usedToken = this.tokens?.accessToken ?? null;
    const response = await this.doFetch(method, path, body, needsAuth);
    if (response.status === 401 && needsAuth && this.tokens) {
      await this.refreshAfter401(response, usedToken);
      const retry = await this.doFetch(method, path, body, true);
      if (!retry.ok) {
        throw await toApiError(retry);
      }
      return parseBody<T>(retry);
    }
    if (!response.ok) {
      throw await toApiError(response);
    }
    return parseBody<T>(response);
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body?: unknown, opts?: { auth?: boolean }): Promise<T> {
    return this.request<T>("POST", path, body, opts);
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }
  del<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  async login(login: string, password: string): Promise<AuthSession> {
    const session = await this.post<AuthSession>(
      "/api/v1/auth/login",
      { login, password, deviceLabel: "rucord-desktop" },
      { auth: false }
    );
    this.setTokens(extractTokens(session));
    return session;
  }

  async register(payload: {
    email: string;
    username: string;
    password: string;
    displayName?: string;
  }): Promise<AuthSession> {
    const session = await this.post<AuthSession>(
      "/api/v1/auth/register",
      { ...payload, deviceLabel: "rucord-desktop" },
      { auth: false }
    );
    this.setTokens(extractTokens(session));
    return session;
  }

  async logout(): Promise<void> {
    try {
      if (this.tokens) {
        await this.post("/api/v1/auth/logout");
      }
    } catch {
      // Сервер недоступен или сессия уже закрыта: локальный выход всё равно нужен.
    } finally {
      this.setTokens(null);
    }
  }

  // Ответ 401 на запрос с токеном: пробуем обновить токен. Если сервер отклонил
  // refresh-токен, сессия закончилась и токены стираются. Если обновить не
  // удалось из-за сети или сбоя сервера, токены остаются: это временная
  // проблема, а не конец сессии.
  private async refreshAfter401(original: Response, usedAccessToken: string | null): Promise<void> {
    // Пока запрос шёл, другой запрос уже обновил токены: второй refresh не
    // нужен (с ротацией он лишний, а потерянный ответ мог бы разлогинить),
    // достаточно повторить сам запрос с новым токеном.
    if (usedAccessToken !== null && this.tokens && this.tokens.accessToken !== usedAccessToken) return;
    try {
      await this.refresh();
    } catch (err) {
      if (isRefreshRejected(err)) {
        this.setTokens(null);
        throw await toApiError(original);
      }
      throw err;
    }
  }

  private async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    if (!this.tokens) throw { status: 401, code: "authentication_failed", message: "no refresh token" } satisfies ApiError;
    const refreshToken = this.tokens.refreshToken;
    this.refreshPromise = (async () => {
      const response = await sendRequest(
        `${this.baseUrl}/api/v1/auth/refresh`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken })
        },
        DEFAULT_FETCH_TIMEOUT_MS
      );
      if (!response.ok) {
        const apiError = await toApiError(response);
        // Токены стираются только если сервер отклонил сам refresh-токен.
        // 5xx, 429 и прочее: сессия жива, стоит повторить позже.
        if (isRefreshRejected(apiError)) this.setTokens(null);
        throw apiError;
      }
      let next: AuthTokens;
      try {
        next = (await response.json()) as AuthTokens;
      } catch {
        // Ответ оборвался или пришёл не JSON: токены остаются, это временный сбой.
        throw transportError("network", "Ответ сервера не распознан");
      }
      this.setTokens({
        accessToken: next.accessToken,
        accessExpiresAt: next.accessExpiresAt,
        refreshToken: next.refreshToken,
        sessionId: next.sessionId
      });
    })();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private isAccessExpired(): boolean {
    if (!this.tokens) return false;
    const expiresAt = Date.parse(this.tokens.accessExpiresAt);
    if (!Number.isFinite(expiresAt)) return false;
    return Date.now() >= expiresAt - 5_000;
  }

  private async doFetch(method: string, path: string, body: unknown, withAuth: boolean): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (withAuth && this.tokens) headers["Authorization"] = `Bearer ${this.tokens.accessToken}`;
    return sendRequest(
      `${this.baseUrl}${path}`,
      {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      },
      DEFAULT_FETCH_TIMEOUT_MS
    );
  }
}

function extractTokens(session: AuthSession): AuthTokens {
  return {
    accessToken: session.accessToken,
    accessExpiresAt: session.accessExpiresAt,
    refreshToken: session.refreshToken,
    sessionId: session.sessionId
  };
}

function readStoredTokens(): AuthTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthTokens;
  } catch {
    return null;
  }
}

async function parseBody<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function toApiError(response: Response): Promise<ApiError> {
  const retryAfterRaw = response.headers.get("Retry-After");
  const retryAfter = retryAfterRaw ? Math.max(0, parseInt(retryAfterRaw, 10) || 0) : undefined;
  const fallback: ApiError = {
    status: response.status,
    code: "http_error",
    message: response.statusText || `HTTP ${response.status}`,
    retryAfter
  };
  try {
    const data = (await response.json()) as ErrorEnvelope;
    if (data?.error) {
      return {
        status: response.status,
        code: data.error.code,
        message: data.error.message,
        requestId: data.error.requestId,
        retryAfter
      };
    }
  } catch {
    /* ignore */
  }
  return fallback;
}
