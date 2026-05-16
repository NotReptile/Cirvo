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
  status: number;
  code: string;
  message: string;
  requestId?: string;
}

interface ErrorEnvelope {
  error: { code: string; message: string; requestId?: string };
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

  async request<T>(method: string, path: string, body?: unknown, init?: { auth?: boolean }): Promise<T> {
    const needsAuth = init?.auth !== false;
    if (needsAuth && this.tokens && this.isAccessExpired()) {
      await this.refresh();
    }
    const response = await this.doFetch(method, path, body, needsAuth);
    if (response.status === 401 && needsAuth && this.tokens) {
      try {
        await this.refresh();
      } catch {
        this.setTokens(null);
        throw await toApiError(response);
      }
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
    } finally {
      this.setTokens(null);
    }
  }

  private async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    if (!this.tokens) throw new Error("no refresh token");
    const refreshToken = this.tokens.refreshToken;
    this.refreshPromise = (async () => {
      const response = await fetch(`${this.baseUrl}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken })
      });
      if (!response.ok) {
        this.setTokens(null);
        throw await toApiError(response);
      }
      const next = (await response.json()) as AuthTokens;
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
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
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
  const fallback: ApiError = {
    status: response.status,
    code: "http_error",
    message: response.statusText || `HTTP ${response.status}`
  };
  try {
    const data = (await response.json()) as ErrorEnvelope;
    if (data?.error) {
      return {
        status: response.status,
        code: data.error.code,
        message: data.error.message,
        requestId: data.error.requestId
      };
    }
  } catch {
    /* ignore */
  }
  return fallback;
}
