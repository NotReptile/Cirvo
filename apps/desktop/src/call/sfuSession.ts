// F.2: клиентская сторона SFU. Снимает mesh-потолок (~5): вместо N-1
// peer-connection'ов клиент держит ровно два PC с сервером —
// publisher (шлём свой звук/видео) и subscriber (получаем форвард-треки
// остальных). Сигналинг — отдельный WebSocket /sfu/ws (не realtime-relay:
// SFU сам сторона переговоров).
//
// Roster (список участников, флаги экран/камера) по-прежнему живёт в
// voiceChannelManager — он ведёт его из realtime-событий voice.joined/
// left/state. SfuSession отвечает ТОЛЬКО за медиа-плоскость и отдаёт
// remote-стримы, ключ — sessionId паблишера (сервер кладёт его в msid
// форвард-трека, браузер группирует по stream.id).
//
// Разделение на pub/sub PC исключает glare: на pub-PC offer'ит только
// клиент, на sub-PC — только сервер. Perfect-negotiation не нужен.

import type { ScreenShareQuality } from "./voiceChannelManager";
import { resolveSfuWsUrl } from "./sfuUrl";

interface SfuSessionOptions {
  // Абсолютный ws(s)://… адрес SFU-сигналинга (из /api/v1/media/config).
  // Допускается и относительный путь (начинается с "/") — тогда он строится
  // от serverUrl.
  wsUrl: string;
  // Адрес сервера Cirvo (HttpClient.baseUrl); пусто в dev-режиме через прокси.
  serverUrl: string;
  getAccessToken: () => string | null;
  getTicket?: () => Promise<string | null>;
  channelId: string;
  iceServers: RTCIceServer[];
  refreshIceServers?: () => Promise<RTCIceServer[]>;
  // Дёргается при любом изменении набора remote-треков — менеджер
  // транслирует это в emit() для UI-ререндера.
  onRemoteChange: () => void;
  onStateChange?: (state: "connected" | "reconnecting", error?: string) => void;
}

interface SignalEnvelope {
  event: string;
  payload?: unknown;
}

interface SDPPayload {
  type: string;
  sdp: string;
}

interface ICEPayload {
  candidate: RTCIceCandidateInit | null;
}

export class SfuSession {
  private ws: WebSocket | null = null;
  private pub: RTCPeerConnection | null = null;
  private sub: RTCPeerConnection | null = null;
  private closed = false;
  private pubMakingOffer = false;
  private localStream: MediaStream | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private reconnecting = false;
  private hasStarted = false;
  private resetting = false;
  private iceServers: RTCIceServer[];

  // ICE, пришедшие до setRemoteDescription соответствующего PC.
  private pubPendingIce: RTCIceCandidateInit[] = [];
  private subPendingIce: RTCIceCandidateInit[] = [];

  // remote-медиа по sessionId паблишера + скрытые <audio> для воспроизведения.
  private remotes = new Map<string, MediaStream>();
  private audioEls = new Map<string, HTMLAudioElement>();

  constructor(private readonly opts: SfuSessionOptions) {
    this.iceServers = opts.iceServers;
  }

  // start открывает сокет, поднимает оба PC и публикует локальные треки.
  // Резолвится, когда pub-PC отправил первый offer (медиа потечёт после
  // ICE/DTLS — ждать коннекта тут не нужно, UI покажет участника сразу).
  async start(localStream: MediaStream): Promise<void> {
    this.localStream = localStream;
    await this.connectTransport(localStream);
    this.hasStarted = true;
    this.opts.onStateChange?.("connected");
  }

  private async connectTransport(localStream: MediaStream): Promise<void> {
    await this.openSocket();
    if (this.closed) return;

    const config: RTCConfiguration = { iceServers: this.iceServers };
    const pub = new RTCPeerConnection(config);
    const sub = new RTCPeerConnection(config);
    this.pub = pub;
    this.sub = sub;

    pub.onicecandidate = (evt) => {
      if (evt.candidate) this.send("pub.ice", { candidate: evt.candidate.toJSON() });
    };
    sub.onicecandidate = (evt) => {
      if (evt.candidate) this.send("sub.ice", { candidate: evt.candidate.toJSON() });
    };

    // Клиент — единственный offerer на pub-PC. addTrack/removeTrack
    // (камера/экран) триггерят negotiationneeded → новый offer.
    pub.onnegotiationneeded = () => {
      void this.renegotiatePub();
    };

    sub.ontrack = (evt) => this.handleRemoteTrack(evt);

    // Серверный datachannel (sub-PC) — нам не нужен, но без обработчика
    // браузер всё равно его примет; событие игнорируем.
    sub.ondatachannel = () => {};

    const handleState = (pc: RTCPeerConnection) => {
      const state = pc.connectionState;
      if (state === "connected") {
        if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
        return;
      }
      if (state === "failed" || state === "closed") {
        this.scheduleReconnect(`peer connection ${state}`);
      } else if (state === "disconnected" && !this.disconnectTimer) {
        this.disconnectTimer = setTimeout(() => {
          this.disconnectTimer = null;
          if (pc.connectionState === "disconnected") this.scheduleReconnect("peer connection disconnected");
        }, 5_000);
      }
    };
    pub.onconnectionstatechange = () => handleState(pub);
    sub.onconnectionstatechange = () => handleState(sub);

    for (const track of localStream.getTracks()) {
      pub.addTrack(track, localStream);
    }
    // Если negotiationneeded по какой-то причине не выстрелил (тайминги
    // некоторых webview) — гарантируем первый offer явно.
    await this.renegotiatePub();
    await this.waitForConnected(pub, sub);
  }

  private waitForConnected(pub: RTCPeerConnection, sub: RTCPeerConnection): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (this.closed) {
          clearInterval(timer);
          reject(new Error("sfu session closed"));
          return;
        }
        if (pub.connectionState === "connected" && sub.connectionState === "connected") {
          clearInterval(timer);
          resolve();
          return;
        }
        if (["failed", "closed"].includes(pub.connectionState) || ["failed", "closed"].includes(sub.connectionState) || Date.now() - started >= 15_000) {
          clearInterval(timer);
          reject(new Error("sfu media connection timeout"));
        }
      }, 100);
    });
  }

  getRemoteStream(sessionId: string): MediaStream | null {
    return this.remotes.get(sessionId) ?? null;
  }

  // dropRemote вызывается менеджером по realtime-событию voice.left —
  // авторитетный сигнал, что участник ушёл (надёжнее, чем track.onended).
  dropRemote(sessionId: string): void {
    this.remotes.delete(sessionId);
    const el = this.audioEls.get(sessionId);
    if (el) {
      el.srcObject = null;
      el.remove();
      this.audioEls.delete(sessionId);
    }
  }

  // ---- медиа-операции (зеркало действий менеджера над mesh-peers) -----------

  addTrack(track: MediaStreamTrack, stream: MediaStream): void {
    this.pub?.addTrack(track, stream);
  }

  removeVideoSenders(): void {
    if (!this.pub) return;
    for (const sender of this.pub.getSenders()) {
      if (sender.track && sender.track.kind === "video") {
        try {
          this.pub.removeTrack(sender);
        } catch {
          /* ignore */
        }
      }
    }
  }

  removeTrackByRef(track: MediaStreamTrack): void {
    if (!this.pub) return;
    for (const sender of this.pub.getSenders()) {
      if (sender.track === track) {
        try {
          this.pub.removeTrack(sender);
        } catch {
          /* ignore */
        }
        return;
      }
    }
  }

  // replaceOrAddVideo: если уже есть video-sender (камера/экран сменяют
  // друг друга на одном «слоте») — replaceTrack без renegotiation; иначе
  // addTrack (renegotiation через negotiationneeded).
  async replaceOrAddVideo(track: MediaStreamTrack, stream: MediaStream, preferReplace: boolean): Promise<void> {
    if (!this.pub) return;
    if (preferReplace) {
      const sender = this.pub.getSenders().find((s) => s.track?.kind === "video");
      if (sender) {
        try {
          await sender.replaceTrack(track);
        } catch {
          /* ignore */
        }
        return;
      }
    }
    this.pub.addTrack(track, stream);
  }

  async applyVideoEncoding(quality: ScreenShareQuality): Promise<void> {
    if (!this.pub) return;
    const sender = this.pub.getSenders().find((s) => s.track?.kind === "video");
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = quality.maxBitrate;
      params.encodings[0].maxFramerate = quality.frameRate;
      await sender.setParameters(params);
    } catch {
      /* ignore — браузер может не поддерживать поле */
    }
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.reconnectTimer = null;
    this.disconnectTimer = null;
    this.closeTransport();
    this.localStream = null;
  }

  private closeTransport(): void {
    this.resetting = true;
    for (const el of this.audioEls.values()) {
      el.srcObject = null;
      el.remove();
    }
    this.audioEls.clear();
    this.remotes.clear();
    if (this.pub) {
      try {
        this.pub.close();
      } catch {
        /* ignore */
      }
      this.pub = null;
    }
    if (this.sub) {
      try {
        this.sub.close();
      } catch {
        /* ignore */
      }
      this.sub = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.pubPendingIce = [];
    this.subPendingIce = [];
    this.pubMakingOffer = false;
    this.resetting = false;
  }

  // ---- internals -----------------------------------------------------------

  private async openSocket(): Promise<void> {
    const ticket = await this.opts.getTicket?.();
    if (!ticket) throw new Error("Не удалось получить разрешение на подключение к голосу");
    if (this.closed) return;
    return new Promise((resolve, reject) => {
      const url = new URL(resolveSfuWsUrl(this.opts.wsUrl, this.opts.serverUrl));
      url.searchParams.delete("access_token");
      url.searchParams.set("ticket", ticket);
      url.searchParams.set("channel_id", this.opts.channelId);
      const ws = new WebSocket(url.toString());
      this.ws = ws;
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(new Error("sfu socket timeout"));
      }, 10_000);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error("sfu socket error"));
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error("sfu socket closed before ready"));
          return;
        }
        if (this.hasStarted && !this.closed && !this.resetting) this.scheduleReconnect("sfu signaling closed");
      };
      ws.onmessage = (ev) => {
        void this.handleMessage(ev.data);
      };
    });
  }

  private scheduleReconnect(reason: string): void {
    if (this.closed || this.reconnecting || this.reconnectTimer || !this.localStream) return;
    this.reconnecting = true;
    this.opts.onStateChange?.("reconnecting", reason);
    this.closeTransport();
    this.opts.onRemoteChange();
    const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const stream = this.localStream;
      if (!stream || this.closed) return;
      void (async () => {
        if (this.opts.refreshIceServers) {
          try {
            this.iceServers = await this.opts.refreshIceServers();
          } catch {
            // Existing credentials may still be valid; try them once more.
          }
        }
        await this.connectTransport(stream);
      })()
        .then(() => {
          this.reconnectAttempts = 0;
          this.reconnecting = false;
          this.opts.onStateChange?.("connected");
        })
        .catch((err) => {
          this.reconnecting = false;
          this.scheduleReconnect(err instanceof Error ? err.message : "sfu reconnect failed");
        });
    }, delay);
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (typeof data !== "string") return;
    let env: SignalEnvelope;
    try {
      env = JSON.parse(data) as SignalEnvelope;
    } catch {
      return;
    }
    switch (env.event) {
      case "pub.answer":
        await this.onPubAnswer(env.payload as SDPPayload);
        break;
      case "sub.offer":
        await this.onSubOffer(env.payload as SDPPayload);
        break;
      case "pub.ice":
        await this.onIce(this.pub, (env.payload as ICEPayload)?.candidate, this.pubPendingIce);
        break;
      case "sub.ice":
        await this.onIce(this.sub, (env.payload as ICEPayload)?.candidate, this.subPendingIce);
        break;
    }
  }

  private async renegotiatePub(): Promise<void> {
    const pub = this.pub;
    if (!pub || this.closed) return;
    // Пере-offer только из stable — иначе уже идут переговоры, браузер
    // дёрнет negotiationneeded повторно по их завершении.
    if (this.pubMakingOffer || pub.signalingState !== "stable") return;
    try {
      this.pubMakingOffer = true;
      const offer = await pub.createOffer();
      await pub.setLocalDescription(offer);
      if (pub.localDescription) {
        this.send("pub.offer", { type: "offer", sdp: pub.localDescription.sdp });
      }
    } catch {
      /* ignore — PC мог закрыться */
    } finally {
      this.pubMakingOffer = false;
    }
  }

  private async onPubAnswer(payload: SDPPayload): Promise<void> {
    if (!this.pub || !payload?.sdp) return;
    try {
      await this.pub.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      await this.drain(this.pub, this.pubPendingIce);
    } catch {
      /* ignore */
    }
  }

  private async onSubOffer(payload: SDPPayload): Promise<void> {
    if (!this.sub || !payload?.sdp) return;
    try {
      await this.sub.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      await this.drain(this.sub, this.subPendingIce);
      const answer = await this.sub.createAnswer();
      await this.sub.setLocalDescription(answer);
      if (this.sub.localDescription) {
        this.send("sub.answer", { type: "answer", sdp: this.sub.localDescription.sdp });
      }
    } catch {
      /* ignore */
    }
  }

  private async onIce(
    pc: RTCPeerConnection | null,
    candidate: RTCIceCandidateInit | null | undefined,
    pending: RTCIceCandidateInit[]
  ): Promise<void> {
    if (!pc || !candidate) return;
    if (!pc.remoteDescription) {
      pending.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      /* ignore */
    }
  }

  private async drain(pc: RTCPeerConnection, pending: RTCIceCandidateInit[]): Promise<void> {
    const items = pending.splice(0, pending.length);
    for (const c of items) {
      try {
        await pc.addIceCandidate(c);
      } catch {
        /* ignore */
      }
    }
  }

  private handleRemoteTrack(evt: RTCTrackEvent): void {
    // streamID форвард-трека = sessionId паблишера (сервер ставит его
    // в msid). Без stream'а трек не сопоставить участнику — пропускаем.
    const sessionId = evt.streams[0]?.id;
    if (!sessionId) return;

    let rs = this.remotes.get(sessionId);
    if (!rs) {
      rs = new MediaStream();
      this.remotes.set(sessionId, rs);
      this.attachAudio(sessionId, rs);
    }
    if (!rs.getTracks().some((t) => t.id === evt.track.id)) {
      rs.addTrack(evt.track);
    }
    // Сервер при unpublish'е (паблишер выключил камеру/экран) убирает
    // трек через renegotiation → трек переходит в ended.
    evt.track.onended = () => {
      const stream = this.remotes.get(sessionId);
      if (stream) stream.removeTrack(evt.track);
      this.opts.onRemoteChange();
    };
    this.opts.onRemoteChange();
  }

  private attachAudio(sessionId: string, stream: MediaStream): void {
    const el = document.createElement("audio");
    el.autoplay = true;
    el.dataset.sfuPeer = sessionId;
    el.style.display = "none";
    el.srcObject = stream;
    document.body.appendChild(el);
    this.audioEls.set(sessionId, el);
  }

  private send(event: string, payload: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event, payload }));
    }
  }
}
