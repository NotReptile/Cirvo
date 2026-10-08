import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HttpClient,
  isApiError,
  isPasswordChangeRequired,
  isSessionRejected,
  isTransientError,
  type ApiError
} from "./httpClient";

// Окружение vitest: node без DOM. localStorage и fetch подменяются стабами.

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => { data.delete(k); },
    setItem: (k: string, v: string) => { data.set(k, String(v)); }
  };
}

const TOKENS = {
  accessToken: "access-1",
  accessExpiresAt: "2999-01-01T00:00:00Z",
  refreshToken: "refresh-1",
  sessionId: "s1"
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function newClient(withTokens = true): HttpClient {
  vi.stubGlobal("localStorage", memoryStorage(withTokens ? { "rucord:tokens": JSON.stringify(TOKENS) } : {}));
  return new HttpClient("https://chat.example.com");
}

async function catchError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error("ожидалась ошибка");
}

describe("HttpClient: таймаут и сеть", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("превращает зависший запрос в ApiError{status:0, code:timeout}", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const client = newClient(false);
    const failure = catchError(client.post("/api/v1/x", {}, { auth: false }));
    await vi.advanceTimersByTimeAsync(15_000);
    const err = await failure;
    expect(err.status).toBe(0);
    expect(err.code).toBe("timeout");
    expect(isTransientError(err)).toBe(true);
  });

  it("превращает сбой сети в ApiError{status:0, code:network}", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const client = newClient(false);
    const err = await catchError(client.post("/api/v1/x", {}, { auth: false }));
    expect(err).toMatchObject({ status: 0, code: "network" });
  });

  it("GET повторяется один раз при недоступности сервера", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: "unavailable", message: "x" } }, 503))
      .mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = newClient();
    const result = client.get<{ ok: boolean }>("/api/v1/users/me");
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("POST не повторяется: сообщение могло дойти до сервера", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    const client = newClient();
    const err = await catchError(client.post("/api/v1/channels/1/messages", { body: "hi" }));
    expect(err.status).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("HttpClient: обновление токена", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("401, затем успешный refresh: запрос повторяется с новым токеном", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: "unauthorized", message: "expired" } }, 401))
      .mockResolvedValueOnce(json({ ...TOKENS, accessToken: "access-2", refreshToken: "refresh-2" }))
      .mockResolvedValueOnce(json({ id: "u1" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = newClient();
    await expect(client.post("/api/v1/users/me", {})).resolves.toEqual({ id: "u1" });
    expect(client.getTokens()?.accessToken).toBe("access-2");
    const retryHeaders = fetchMock.mock.calls[2][1].headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe("Bearer access-2");
  });

  it("сервер отклонил refresh-токен: токены стираются, пользователь получает 401", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json({ error: { code: "unauthorized", message: "expired" } }, 401))
      .mockResolvedValueOnce(json({ error: { code: "unauthorized", message: "bad refresh" } }, 401)));
    const client = newClient();
    const err = await catchError(client.post("/api/v1/users/me", {}));
    expect(err.status).toBe(401);
    expect(isSessionRejected(err)).toBe(true);
    expect(client.getTokens()).toBeNull();
  });

  it("сеть пропала во время refresh: токены остаются, ошибка временная", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json({ error: { code: "unauthorized", message: "expired" } }, 401))
      .mockRejectedValueOnce(new TypeError("Failed to fetch")));
    const client = newClient();
    const err = await catchError(client.post("/api/v1/users/me", {}));
    expect(isTransientError(err)).toBe(true);
    expect(isSessionRejected(err)).toBe(false);
    expect(client.getTokens()).not.toBeNull();
  });

  it("сбой сервера (500) на refresh не стирает токены", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json({ error: { code: "unauthorized", message: "expired" } }, 401))
      .mockResolvedValueOnce(json({ error: { code: "internal", message: "boom" } }, 500)));
    const client = newClient();
    const err = await catchError(client.post("/api/v1/users/me", {}));
    expect(err.status).toBe(500);
    expect(client.getTokens()).not.toBeNull();
  });

  it("токены уже обновлены другим запросом: второй refresh не делается", async () => {
    let refreshCalls = 0;
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      if (url.endsWith("/api/v1/auth/refresh")) {
        refreshCalls += 1;
        return json({ ...TOKENS, accessToken: "access-2", refreshToken: "refresh-2" });
      }
      if (auth === "Bearer access-2") return json({ ok: true });
      // Запрос B получает 401 только после того, как A уже обновил токены.
      if (url.endsWith("/b")) await gateB;
      return json({ error: { code: "unauthorized", message: "expired" } }, 401);
    }));
    const client = newClient();
    const a = client.get<{ ok: boolean }>("/a");
    const b = client.get<{ ok: boolean }>("/b");
    await expect(a).resolves.toEqual({ ok: true });
    releaseB();
    await expect(b).resolves.toEqual({ ok: true });
    expect(refreshCalls).toBe(1);
    expect(client.getTokens()?.accessToken).toBe("access-2");
  });

  it("ответ refresh оборвался: токены остаются, ошибка временная", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json({ error: { code: "unauthorized", message: "expired" } }, 401))
      .mockResolvedValueOnce(new Response("не json", { status: 200 })));
    const client = newClient();
    const err = await catchError(client.post("/api/v1/users/me", {}));
    expect(isTransientError(err)).toBe(true);
    expect(client.getTokens()).not.toBeNull();
  });

  it("logout при недоступном сервере не бросает исключение и стирает токены", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const client = newClient();
    await expect(client.logout()).resolves.toBeUndefined();
    expect(client.getTokens()).toBeNull();
  });
});

describe("isSessionRejected и isPasswordChangeRequired", () => {
  it("401 и 403 разлогинивают", () => {
    expect(isSessionRejected({ status: 401, code: "authentication_failed", message: "x" })).toBe(true);
    expect(isSessionRejected({ status: 403, code: "authorization_denied", message: "account banned" })).toBe(true);
  });

  it("403 password_change_required не разлогинивает: сессия жива", () => {
    const err = { status: 403, code: "password_change_required", message: "password change required" };
    expect(isPasswordChangeRequired(err)).toBe(true);
    expect(isSessionRejected(err)).toBe(false);
  });

  it("сеть, 5xx и не-ошибки не разлогинивают", () => {
    expect(isSessionRejected({ status: 0, code: "network", message: "x" })).toBe(false);
    expect(isSessionRejected({ status: 503, code: "unavailable", message: "x" })).toBe(false);
    expect(isSessionRejected(new Error("x"))).toBe(false);
    expect(isPasswordChangeRequired(null)).toBe(false);
  });
});

describe("isApiError", () => {
  it("отличает ApiError от обычных ошибок", () => {
    expect(isApiError({ status: 0, code: "network", message: "x" })).toBe(true);
    expect(isApiError(new Error("x"))).toBe(false);
    expect(isApiError(null)).toBe(false);
  });
});
