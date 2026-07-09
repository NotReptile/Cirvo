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

  it("deduplicates durable events and advances on sync.ready", () => {
    const client = new RealtimeClient("ws://example.test/ws");
    const received: string[] = [];
    client.subscribe((event) => received.push(event.event));
    client.setAccessToken(tokenFor("user-a"));

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

  it("uses a one-time ticket when available", async () => {
    const client = new RealtimeClient("wss://example.test/ws", async () => "ticket-value");
    client.setAccessToken(tokenFor("user-b"));
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const url = new URL(FakeWebSocket.instances[0].url);
    expect(url.searchParams.get("ticket")).toBe("ticket-value");
    expect(url.searchParams.has("access_token")).toBe(false);
    client.disconnect();
  });
});
