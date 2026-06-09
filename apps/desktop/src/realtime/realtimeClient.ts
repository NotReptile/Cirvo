export interface RealtimeEvent {
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

  constructor(readonly endpoint: string) {}

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
    this.accessToken = token;
    if (!token) {
      this.disconnect();
      return;
    }
    this.connect();
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

  private connect(): void {
    if (!this.accessToken) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.manualClose = false;
    this.setConnState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
    const url = `${this.endpoint}?access_token=${encodeURIComponent(this.accessToken)}`;
    const socket = new WebSocket(url);
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
      for (const listener of this.listeners) {
        listener(parsed);
      }
    };
    socket.onclose = () => {
      this.socket = null;
      if (this.manualClose || !this.accessToken) {
        this.setConnState("offline");
        return;
      }
      this.setConnState("reconnecting");
      const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempts);
      this.reconnectAttempts += 1;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
    socket.onerror = () => {
      socket.close();
    };
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
