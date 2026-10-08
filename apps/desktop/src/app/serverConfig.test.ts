import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ServerCheckError,
  checkServerReachable,
  deriveRealtimeUrl,
  isInsecureServerUrl,
  normalizeServerUrl
} from "./serverConfig";

describe("normalizeServerUrl", () => {
  it("для домена подставляет https и убирает хвостовой слеш", () => {
    expect(normalizeServerUrl("chat.example.com/")).toBe("https://chat.example.com");
  });

  it("для IPv4 и localhost подставляет http", () => {
    expect(normalizeServerUrl("10.0.0.5")).toBe("http://10.0.0.5");
    expect(normalizeServerUrl("localhost:8080")).toBe("http://localhost:8080");
  });

  it("явную схему сохраняет как введена", () => {
    expect(normalizeServerUrl("https://10.0.0.5")).toBe("https://10.0.0.5");
    expect(normalizeServerUrl("http://chat.example.com")).toBe("http://chat.example.com");
  });
});

describe("deriveRealtimeUrl", () => {
  it("https даёт wss, http даёт ws", () => {
    expect(deriveRealtimeUrl("https://chat.example.com")).toBe("wss://chat.example.com/ws");
    expect(deriveRealtimeUrl("http://10.0.0.5:8080")).toBe("ws://10.0.0.5:8080/ws");
  });
});

describe("isInsecureServerUrl", () => {
  it("http на внешнем адресе небезопасен", () => {
    expect(isInsecureServerUrl("http://chat.example.com")).toBe(true);
    expect(isInsecureServerUrl("10.0.0.5")).toBe(true);
  });

  it("https и loopback безопасны", () => {
    expect(isInsecureServerUrl("chat.example.com")).toBe(false);
    expect(isInsecureServerUrl("https://10.0.0.5")).toBe(false);
    expect(isInsecureServerUrl("localhost:8080")).toBe(false);
    expect(isInsecureServerUrl("http://127.0.0.1:8080")).toBe(false);
  });

  it("мусор не считается небезопасным и не бросает исключение", () => {
    expect(isInsecureServerUrl("")).toBe(false);
    expect(isInsecureServerUrl("http://")).toBe(false);
  });
});

describe("checkServerReachable", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function readyResponse(body: unknown, status = 200): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }

  async function failureOf(promise: Promise<void>): Promise<ServerCheckError> {
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(ServerCheckError);
      return err as ServerCheckError;
    }
    throw new Error("ожидалась ошибка");
  }

  it("принимает ответ RuCord со status ready", async () => {
    const fetchMock = vi.fn().mockResolvedValue(readyResponse({ module: "system", status: "ready" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkServerReachable("chat.example.com")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe("https://chat.example.com/readyz");
  });

  it("код 503 даёт ошибку http с кодом ответа", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(readyResponse({}, 503)));
    const err = await failureOf(checkServerReachable("chat.example.com"));
    expect(err.kind).toBe("http");
    expect(err.status).toBe(503);
  });

  it("чужой сервер (200, но не RuCord) даёт not-rucord", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(readyResponse("<html>hello</html>")));
    const err = await failureOf(checkServerReachable("chat.example.com"));
    expect(err.kind).toBe("not-rucord");
  });

  it("JSON без status ready тоже не RuCord", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(readyResponse({ status: "ok" })));
    const err = await failureOf(checkServerReachable("chat.example.com"));
    expect(err.kind).toBe("not-rucord");
  });

  it("сбой сети даёт network с перечислением причин", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const err = await failureOf(checkServerReachable("chat.example.com"));
    expect(err.kind).toBe("network");
    expect(err.message).toContain("CORS");
  });

  it("зависший сервер даёт timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const failure = failureOf(checkServerReachable("chat.example.com", undefined, 5_000));
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await failure;
    expect(err.kind).toBe("timeout");
  });

  it("сервер прислал заголовки и замолчал: timeout, а не вечная проверка", async () => {
    vi.useFakeTimers();
    // Тело ответа никогда не заканчивается.
    const stalled = new Response(new ReadableStream({ start() {} }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stalled));
    const failure = failureOf(checkServerReachable("chat.example.com", undefined, 5_000));
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await failure;
    expect(err.kind).toBe("timeout");
  });

  it("явная отмена пользователем пробрасывается как есть", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const pending = checkServerReachable("chat.example.com", controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(DOMException);
  });
});
