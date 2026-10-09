export interface RealtimeEvent {
  version?: number;
  seq?: number;
  eventId?: string;
  occurredAt?: string;
  event: string;
  workspaceId?: string;
  channelId?: string;
  payload: unknown;
}

type Listener = (event: RealtimeEvent) => void;

// Wave 0: состояние WS-соединения для индикатора в UI и resync-логики.
// "offline" — нет токена / manual disconnect; "connecting" — первое
// подключение; "reconnecting" — соединение упало, ждём/пробуем повторно;
// "connected" — сокет открыт.
export type ConnectionState = "offline" | "connecting" | "reconnecting" | "connected";

type StateListener = (state: ConnectionState) => void;

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private accessToken: string | null = null;
  private reconnectAttempts = 0;
  private manualClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connState: ConnectionState = "offline";
  private stateListeners = new Set<StateListener>();
  private cursor = 0;
  private cursorKey: string | null = null;
  private tokenSubject: string | null = null;
  private connecting = false;
  private connectGeneration = 0;
  private syncPending = false;
  private pendingEvents: RealtimeEvent[] = [];

  constructor(
    readonly endpoint: string,
    private readonly issueTicket?: () => Promise<string | null>
  ) {}

  getConnectionState(): ConnectionState {
    return this.connState;
  }

  onConnectionStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private setConnState(next: ConnectionState): void {
    if (this.connState === next) return;
    this.connState = next;
    for (const l of this.stateListeners) l(next);
  }

  setAccessToken(token: string | null): void {
    const nextSubject = token ? subjectFromToken(token) : null;
    if (this.tokenSubject && nextSubject && this.tokenSubject !== nextSubject) {
      this.disconnect();
    }
    this.accessToken = token;
    this.tokenSubject = nextSubject;
    if (!token) {
      this.cursor = 0;
      this.cursorKey = null;
      this.disconnect();
      return;
    }
    this.cursorKey = `rucord:realtime-cursor:${this.endpoint}:${nextSubject ?? "unknown"}`;
    this.cursor = readCursor(this.cursorKey);
    void this.connect();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(event: string, payload: unknown): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.socket.send(JSON.stringify({ event, payload }));
      return true;
    } catch {
      return false;
    }
  }

  acknowledgeCursor(cursor: number): void {
    if (!Number.isSafeInteger(cursor) || cursor < 0) return;
    this.cursor = cursor;
    if (!this.cursorKey) return;
    try {
      localStorage.setItem(this.cursorKey, String(cursor));
    } catch {
      // Storage can be disabled; in-memory resume still works this session.
    }
  }

  completeSnapshot(cursor: number): void {
    this.acknowledgeCursor(cursor);
    this.syncPending = false;
    const pending = this.pendingEvents
      .splice(0, this.pendingEvents.length)
      .filter((event) => typeof event.seq === "number" && event.seq > this.cursor)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    for (const event of pending) {
      this.acknowledgeCursor(event.seq!);
      this.notify(event);
    }
  }

  beginSnapshot(): void {
    this.syncPending = true;
    this.pendingEvents = [];
  }

  private notify(event: RealtimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async connect(): Promise<void> {
    if (!this.accessToken) return;
    if (this.connecting) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.connecting = true;
    const generation = ++this.connectGeneration;
    this.manualClose = false;
    this.setConnState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
    let ticket: string | null = null;
    if (this.issueTicket) {
      try {
        ticket = await this.issueTicket();
      } catch {
        // Never put a reusable token in the URL when ticket issuance fails.
      }
    }
    if (generation !== this.connectGeneration) return;
    if (!this.accessToken || this.manualClose) {
      this.connecting = false;
      return;
    }
    const url = new URL(this.endpoint);
    if (!ticket) {
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }
    url.searchParams.delete("access_token");
    url.searchParams.set("ticket", ticket);
    if (this.cursor > 0) url.searchParams.set("cursor", String(this.cursor));
    const socket = new WebSocket(url.toString());
    this.connecting = false;
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.setConnState("connected");
    };
    socket.onmessage = (event) => {
      let parsed: RealtimeEvent | null = null;
      try {
        parsed = JSON.parse(event.data) as RealtimeEvent;
      } catch {
        return;
      }
      if (!parsed) return;
      if (parsed.event === "sync.required") {
        this.syncPending = true;
        this.pendingEvents = [];
      }
      if (parsed.event === "sync.ready") {
        const next = Number((parsed.payload as { cursor?: unknown } | null)?.cursor);
        if (Number.isSafeInteger(next) && next >= 0) {
          this.syncPending = false;
          this.acknowledgeCursor(next);
        }
      }
      if (parsed.version === 2 && typeof parsed.seq === "number") {
        if (parsed.seq <= this.cursor) return;
        if (this.syncPending) {
          this.pendingEvents.push(parsed);
          return;
        }
        this.acknowledgeCursor(parsed.seq);
      }
      this.notify(parsed);
    };
    socket.onclose = () => {
      this.socket = null;
      if (this.manualClose || !this.accessToken) {
        this.setConnState("offline");
        return;
      }
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      socket.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.manualClose || !this.accessToken || this.reconnectTimer) return;
    this.setConnState("reconnecting");
    const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempts++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  // G.6.b: попросить сервер перечитать workspace-membership без разрыва
  // соединения (вступили в воркспейс / создали новый). Сервер подтверждает
  // свежим presence.snapshot. Если сокет не открыт — no-op: ближайший
  // connect() и так загрузит актуальный membership из БД.
  refreshSubscriptions(): void {
    this.send("subscription.refresh", {});
  }

  disconnect(): void {
    this.manualClose = true;
    this.connectGeneration += 1;
    this.connecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.setConnState("offline");
  }
}

function readCursor(key: string): number {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function subjectFromToken(token: string): string | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const payload = JSON.parse(atob(normalized)) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}
