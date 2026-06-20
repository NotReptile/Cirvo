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

interface SfuSessionOptions {
  // Абсолютный ws(s)://… адрес SFU-сигналинга (из /api/v1/ice-servers).
  // Допускается и относительный путь (начинается с "/") — тогда хост
  // берётся из window.location.
  wsUrl: string;
  accessToken: string;
  channelId: string;
  iceServers: RTCIceServer[];
  // Дёргается при любом изменении набора remote-треков — менеджер
  // транслирует это в emit() для UI-ререндера.
  onRemoteChange: () => void;
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

  // ICE, пришедшие до setRemoteDescription соответствующего PC.
  private pubPendingIce: RTCIceCandidateInit[] = [];
  private subPendingIce: RTCIceCandidateInit[] = [];

  // remote-медиа по sessionId паблишера + скрытые <audio> для воспроизведения.
  private remotes = new Map<string, MediaStream>();
  private audioEls = new Map<string, HTMLAudioElement>();

  constructor(private readonly opts: SfuSessionOptions) {}

  // start открывает сокет, поднимает оба PC и публикует локальные треки.
  // Резолвится, когда pub-PC отправил первый offer (медиа потечёт после
  // ICE/DTLS — ждать коннекта тут не нужно, UI покажет участника сразу).
  async start(localStream: MediaStream): Promise<void> {
    await this.openSocket();
    if (this.closed) return;

    const config: RTCConfiguration = { iceServers: this.opts.iceServers };
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

    for (const track of localStream.getTracks()) {
      pub.addTrack(track, localStream);
    }
    // Если negotiationneeded по какой-то причине не выстрелил (тайминги
    // некоторых webview) — гарантируем первый offer явно.
    await this.renegotiatePub();
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
  }

  // ---- internals -----------------------------------------------------------

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      let base = this.opts.wsUrl;
      if (base.startsWith("/")) {
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        base = `${proto}//${window.location.host}${base}`;
      }
      const sep = base.includes("?") ? "&" : "?";
      const url =
        `${base}${sep}access_token=${encodeURIComponent(this.opts.accessToken)}` +
        `&channel_id=${encodeURIComponent(this.opts.channelId)}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("sfu socket error"));
      ws.onclose = () => {
        // Закрытие после старта = потеря сигналинга; медиа без него
        // деградирует. Менеджер заметит по отсутствию участников/таймауту.
        if (!this.closed) this.opts.onRemoteChange();
      };
      ws.onmessage = (ev) => {
        void this.handleMessage(ev.data);
      };
    });
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
