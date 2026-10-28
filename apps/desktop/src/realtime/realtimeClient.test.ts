import { beforeEach, describe, expect, it, vi } from "vitest";

import { RealtimeClient, type RealtimeEvent } from "./realtimeClient";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emit(event: RealtimeEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
}

function tokenFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `header.${payload}.signature`;
}

describe("RealtimeClient cursor", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  it("deduplicates durable events and advances on sync.ready", async () => {
    const client = new RealtimeClient("ws://example.test/ws", async () => "ticket");
    const received: string[] = [];
    client.subscribe((event) => received.push(event.event));
    client.setAccessToken(tokenFor("user-a"));

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    const ws = FakeWebSocket.instances[0];
    ws.open();
    const durable: RealtimeEvent = { version: 2, seq: 7, eventId: "event-7", occurredAt: new Date().toISOString(), event: "message.created", payload: {} };
    ws.emit(durable);
    ws.emit(durable);
    ws.emit({ version: 2, event: "sync.ready", payload: { cursor: 10 } });
    ws.emit({ ...durable, seq: 9, eventId: "event-9" });

    expect(received).toEqual(["message.created", "sync.ready"]);
    client.disconnect();
  });

  it("шлёт keepalive ping и логирует причину закрытия", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const client = new RealtimeClient("wss://example.test/ws", async () => "t");
      client.setAccessToken(tokenFor("user-hb"));
      await vi.advanceTimersByTimeAsync(0);
      const ws = FakeWebSocket.instances[0];
      ws.open();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(ws.sent.map((s) => JSON.parse(s).event)).toEqual(["ping"]);
      (ws.onclose as unknown as (e: object) => void)({ code: 1006, reason: "", wasClean: false });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("code=1006"));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ws.sent).toHaveLength(1);
      client.disconnect();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("uses a one-time ticket when available", async () => {
    const client = new RealtimeClient("wss://example.test/ws", async () => "ticket-value");
    client.setAccessToken(tokenFor("user-b"));
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const url = new URL(FakeWebSocket.instances[0].url);
    expect(url.searchParams.get("ticket")).toBe("ticket-value");
    expect(url.searchParams.has("access_token")).toBe(false);
    client.disconnect();
  });

  it("retries a ticket failure without opening a socket or leaking the token", async () => {
    vi.useFakeTimers();
    try {
      const issue = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("retry-ticket");
      const client = new RealtimeClient("wss://example.test/ws", issue);
      client.setAccessToken(tokenFor("user-c"));
      await vi.advanceTimersByTimeAsync(0);
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(client.getConnectionState()).toBe("reconnecting");
      await vi.advanceTimersByTimeAsync(500);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(new URL(FakeWebSocket.instances[0].url).searchParams.get("ticket")).toBe("retry-ticket");
      expect(FakeWebSocket.instances[0].url).not.toContain("access_token");
      client.disconnect();
    } finally { vi.useRealTimers(); }
  });

  it("does not connect after logout while a ticket request is pending", async () => {
    let resolveTicket!: (value: string) => void;
    const client = new RealtimeClient("wss://example.test/ws", () => new Promise(resolve => { resolveTicket = resolve; }));
    client.setAccessToken(tokenFor("user-d"));
    client.setAccessToken(null);
    resolveTicket("late-ticket");
    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(client.getConnectionState()).toBe("offline");
  });
});
