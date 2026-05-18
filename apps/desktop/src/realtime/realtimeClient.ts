export interface RealtimeEvent {
  event: string;
  workspaceId?: string;
  channelId?: string;
  payload: unknown;
}

type Listener = (event: RealtimeEvent) => void;

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private accessToken: string | null = null;
  private reconnectAttempts = 0;
  private manualClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly endpoint: string) {}

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
    const url = `${this.endpoint}?access_token=${encodeURIComponent(this.accessToken)}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectAttempts = 0;
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
      if (this.manualClose || !this.accessToken) return;
      const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempts);
      this.reconnectAttempts += 1;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
    socket.onerror = () => {
      socket.close();
    };
  }

  reconnect(): void {
    if (!this.accessToken) return;
    this.manualClose = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      const sock = this.socket;
      this.socket = null;
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    }
    this.reconnectAttempts = 0;
    this.connect();
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
  }
}
