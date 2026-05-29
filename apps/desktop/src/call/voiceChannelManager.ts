import type { HttpClient } from "../network/httpClient";
import type { RealtimeClient, RealtimeEvent } from "../realtime/realtimeClient";
import { buildAudioConstraints, buildVideoConstraints } from "./voiceSettings";
import { acquireScreenShareStream, releaseScreenAudio } from "./screenSharePicker";

// Voice-канал. Multi-peer mesh поверх отдельного `voice.*` сигналинга
// (не `call.*` — иначе 1-к-1 CallManager подхватывает mesh-offer как
// входящий звонок и показывает уведомление с UUID). Каждый участник
// держит свою RTCPeerConnection с каждым другим.
//
// При входе: POST /voice/join, для каждого из текущих участников шлём
// voice.offer (мы — caller для них). Когда новый человек заходит —
// он шлёт нам offer, мы отвечаем answer. На выходе закрываем все PC
// + шлём voice.hangup каждому.
//
// Предел ~5 (константа сервера). Выше уйдём на SFU (F.2).

export interface VoiceParticipant {
  userId: string;
  sessionId: string;
  username: string;
  displayName?: string;
  joinedAt: string;
  // Транслируется через `voice.state` (peer сообщает, что у него
  // активна демонстрация экрана). Receiver не может вывести это из
  // MediaStreamTrack — нужен отдельный сигналинг.
  screenSharing?: boolean;
  cameraOn?: boolean;
}

export type VoiceState = "idle" | "joining" | "active" | "leaving";

// Пресет качества screenshare'а: разрешение, FPS и cap по битрейту.
// Передаётся в toggleScreenShare() — без него браузер сам выбирает
// (обычно 720p15, а WebRTC режет битрейт до ~1-2 Mbps → картинка
// «сыпется»). После replace/addTrack применяем `setParameters` с
// `maxBitrate`/`maxFramerate` к video sender'у каждого peer'а.
export interface ScreenShareQuality {
  width: number;
  height: number;
  frameRate: number;
  maxBitrate: number;
}

export interface VoiceSnapshot {
  channelId: string | null;
  participants: VoiceParticipant[];
  selfSessionId: string | null;
  muted: boolean;
  cameraOn: boolean;
  screenSharing: boolean;
  state: VoiceState;
  error: string | null;
}

interface JoinResponse {
  channelId: string;
  self: VoiceParticipant;
  others: VoiceParticipant[];
}

interface IceServersResponse {
  iceServers: RTCIceServer[];
}

interface RelayPayload {
  call_id: string;
  from_user_id?: string;
  from_session_id?: string;
  target_user_id?: string;
  target_session_id?: string;
  channel_id?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  reason?: string;
  state?: PeerStatePayload;
}

interface PeerStatePayload {
  screen_sharing?: boolean;
  camera_on?: boolean;
}

interface VoiceEventPayload {
  channelId: string;
  userId: string;
  sessionId: string;
  username?: string;
  displayName?: string;
  joinedAt?: string;
}

type Listener = (snap: VoiceSnapshot) => void;

interface PeerEntry {
  pc: RTCPeerConnection;
  callId: string;
  remoteStream: MediaStream;
  remoteAudio: HTMLAudioElement;
  pendingCandidates: RTCIceCandidateInit[];
  // Perfect-negotiation flag — пока true, входящий offer мы игнорируем
  // (collision detected). Когда наш собственный offer отослан,
  // сбрасываем во ВРЕМЯ setRemoteDescription(answer).
  makingOffer: boolean;
  // Polite-side: только caller (тот, кто создаёт peer первым через
  // dialPeer()) считается impolite — он не уступает в коллизии.
  // Receiver (peer создан в handleOffer) — polite, в коллизии откатывает
  // свой offer. Это снимает race-condition при двустороннем
  // одновременном renegotiate (например, если оба разом включают камеру).
  polite: boolean;
}

const IDLE: VoiceSnapshot = {
  channelId: null,
  participants: [],
  selfSessionId: null,
  muted: false,
  cameraOn: false,
  screenSharing: false,
  state: "idle",
  error: null
};

export class VoiceChannelManager {
  private snapshot: VoiceSnapshot = { ...IDLE };
  private listeners = new Set<Listener>();
  private localStream: MediaStream | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  // K.5(c): системный аудио-track screen-share'а. Отдельный sender от mic'а.
  private screenAudioTrack: MediaStreamTrack | null = null;
  // PTT-гейт: false = звук временно перекрыт (клавиша push-to-talk не зажата).
  // Отделён от snapshot.muted — в PTT-режиме микрофон визуально «включён»
  // (Discord-стиль), а передача гейтится этим флагом.
  private pttGateOpen = true;
  private iceServers: RTCIceServer[] | null = null;
  private peers = new Map<string, PeerEntry>(); // key = peer sessionId
  private unsubscribe: (() => void) | null = null;

  // Streams для UI: локальное превью + remote-stream по sessionId.
  // Возвращаем объекты-ссылки, чтобы UI после render() мог attach их
  // в созданные <video> элементы через .srcObject.
  getLocalStream(): MediaStream | null {
    return this.localStream;
  }
  getRemoteStream(sessionId: string): MediaStream | null {
    return this.peers.get(sessionId)?.remoteStream ?? null;
  }

  constructor(
    private readonly http: HttpClient,
    private readonly realtime: RealtimeClient
  ) {
    this.unsubscribe = realtime.subscribe((e) => {
      void this.onEvent(e);
    });
  }

  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    void this.leave();
  }

  getSnapshot(): VoiceSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  async join(channelId: string): Promise<void> {
    if (this.snapshot.state === "joining") return;
    if (this.snapshot.state !== "idle") {
      await this.leave();
    }
    this.update({ state: "joining", channelId, participants: [], error: null });
    try {
      await this.ensureIceServers();
      await this.acquireLocalStream();
      const resp = await this.http.post<JoinResponse>(
        `/api/v1/channels/${channelId}/voice/join`,
        {}
      );
      const others = resp.others ?? [];
      this.update({
        state: "active",
        channelId,
        selfSessionId: resp.self.sessionId,
        participants: [resp.self, ...others]
      });
      // Mы — caller для всех, кто уже был в канале.
      for (const other of others) {
        await this.dialPeer(other);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "join failed";
      this.tearDownLocal();
      this.snapshot = { ...IDLE, error: message };
      this.emit();
      throw err;
    }
  }

  async leave(): Promise<void> {
    const channelId = this.snapshot.channelId;
    if (!channelId || this.snapshot.state === "idle") return;
    this.update({ state: "leaving" });
    for (const [sid, peer] of this.peers) {
      try {
        this.realtime.send("voice.hangup", {
          call_id: peer.callId,
          target_session_id: sid,
          reason: "voice_leave"
        });
      } catch {
        /* ignore */
      }
      this.destroyPeer(sid);
    }
    this.peers.clear();
    this.tearDownLocal();
    try {
      await this.http.post(`/api/v1/channels/${channelId}/voice/leave`, {});
    } catch {
      /* idempotent: сервер ответит 204 даже если запись уже удалена */
    }
    this.snapshot = { ...IDLE };
    this.emit();
  }

  toggleMute(): boolean {
    return this.setMute(!this.snapshot.muted);
  }

  // Явный mute пользователя. idempotent. Реальное состояние трека —
  // комбинация mute и PTT-гейта (см. applyAudioEnabled).
  setMute(muted: boolean): boolean {
    if (this.snapshot.muted === muted) return muted;
    this.update({ muted });
    this.applyAudioEnabled();
    return muted;
  }

  isMuted(): boolean {
    return this.snapshot.muted;
  }

  // PTT-гейт. НЕ трогает snapshot.muted — микрофон визуально остаётся
  // «включённым». На keydown PTT → open=true, на keyup → open=false.
  setPttGate(open: boolean): void {
    if (this.pttGateOpen === open) return;
    this.pttGateOpen = open;
    this.applyAudioEnabled();
  }

  // Микрофонный трек активен только если пользователь не замьютил И PTT-гейт
  // открыт. Системный звук (screenAudioTrack) не гейтим — он не должен
  // пропадать при mute/PTT микрофона.
  private applyAudioEnabled(): void {
    if (!this.localStream) return;
    const enabled = !this.snapshot.muted && this.pttGateOpen;
    for (const t of this.localStream.getAudioTracks()) {
      if (t === this.screenAudioTrack) continue;
      t.enabled = enabled;
    }
  }

  isActive(): boolean {
    return !!this.snapshot.channelId;
  }

  // toggleCamera включает/выключает локальную камеру. При включении —
  // getUserMedia({video:true}), добавляет track в localStream и через
  // pc.addTrack во ВСЕ активные peer-connection'ы. Это триггерит
  // onnegotiationneeded → авто-renegotiate (perfect negotiation).
  // При выключении — track.stop() + removeTrack у каждого sender'а,
  // тоже renegotiation. Возвращает новое состояние.
  async toggleCamera(): Promise<boolean> {
    if (this.snapshot.state !== "active") return false;
    // Камера и screen-share делят один video sender per peer — нельзя
    // одновременно. UI обычно блокирует кнопку «камера», но защита
    // дублируется здесь на случай гонки.
    if (this.screenTrack) return false;
    if (!this.cameraTrack) {
      let videoStream: MediaStream;
      try {
        videoStream = await navigator.mediaDevices.getUserMedia({ video: buildVideoConstraints() });
      } catch (err) {
        const message = err instanceof Error ? err.message : "camera access denied";
        this.update({ error: message });
        return false;
      }
      const track = videoStream.getVideoTracks()[0];
      if (!track) return false;
      this.cameraTrack = track;
      if (this.localStream) {
        this.localStream.addTrack(track);
      }
      // Для уже подключённых peer'ов: addTrack триггерит negotiation.
      // У свеже-создаваемых через createPeer трек попадёт сразу через
      // tracks-перебор в localStream.
      for (const peer of this.peers.values()) {
        try {
          peer.pc.addTrack(track, this.localStream!);
        } catch {
          /* ignore — peer закрывается */
        }
      }
      this.update({ cameraOn: true, error: null });
      this.broadcastState();
      return true;
    }
    const track = this.cameraTrack;
    this.cameraTrack = null;
    if (this.localStream) {
      this.localStream.removeTrack(track);
    }
    track.stop();
    // Если параллельно идёт screen-share — он держит свой video sender,
    // его не трогаем. Иначе убираем video sender'ы.
    if (!this.screenTrack) {
      for (const peer of this.peers.values()) {
        for (const sender of peer.pc.getSenders()) {
          if (sender.track && sender.track.kind === "video") {
            try {
              peer.pc.removeTrack(sender);
            } catch {
              /* ignore */
            }
          }
        }
      }
    } else {
      // Если camera была replaced screen'ом — sender держит screen'овский
      // трек, ничего делать не надо. cameraOn=false уже корректно.
    }
    this.update({ cameraOn: false });
    this.broadcastState();
    return false;
  }

  // Демо экрана. Замещает камеру (один video sender per peer): если
  // камера была — выключаем её и кладём screen track вместо. Когда
  // screenshare останавливается — video sender убирается полностью;
  // камеру можно включить заново отдельной кнопкой. Слушаем
  // track.onended, чтобы авто-выключиться когда юзер нажал «Stop
  // sharing» в системной панели браузера.
  async toggleScreenShare(quality?: ScreenShareQuality): Promise<boolean> {
    if (this.snapshot.state !== "active") return false;
    if (!this.screenTrack) {
      let displayStream: MediaStream;
      let acquireFromTauri = false;
      try {
        // K.5/K.9: своя capture-pipeline через Tauri, если доступна
        // (показывает Discord-like picker, убирает браузерную плашку
        // «сайт делает демонстрацию»). Fallback на getDisplayMedia —
        // браузерный picker. Подробнее в screenSharePicker.ts.
        const result = await acquireScreenShareStream(quality);
        displayStream = result.stream;
        acquireFromTauri = result.fromTauri;
      } catch (err) {
        const message = err instanceof Error ? err.message : "screen share denied";
        this.update({ error: message });
        return false;
      }
      void acquireFromTauri; // флаг доступен для будущей логики stop (сейчас track.stop достаточно)
      const track = displayStream.getVideoTracks()[0];
      if (!track) return false;
      this.screenTrack = track;
      // K.5(c): подцепляем системный audio-track (если acquireScreenShareStream
      // вернул hasSystemAudio). Отдельный sender — не конфликтует с mic'ом.
      const audioTrack = displayStream.getAudioTracks()[0] ?? null;
      this.screenAudioTrack = audioTrack;
      track.onended = () => {
        // юзер нажал «Stop sharing» в браузере — выключаемся.
        if (this.screenTrack === track) {
          void this.toggleScreenShare();
        }
      };
      // Если камера была включена — гасим её, screen занимает её
      // место. Иначе — добавляем как новый track.
      let hadCamera = false;
      if (this.cameraTrack) {
        hadCamera = true;
        const cam = this.cameraTrack;
        this.cameraTrack = null;
        if (this.localStream) this.localStream.removeTrack(cam);
        cam.stop();
      }
      if (this.localStream) {
        this.localStream.addTrack(track);
      }
      for (const peer of this.peers.values()) {
        if (hadCamera) {
          const sender = peer.pc.getSenders().find((s) => s.track?.kind === "video");
          if (sender) {
            try {
              await sender.replaceTrack(track);
            } catch {
              /* ignore */
            }
            continue;
          }
        }
        try {
          peer.pc.addTrack(track, this.localStream!);
        } catch {
          /* ignore */
        }
      }
      if (audioTrack) {
        if (this.localStream) this.localStream.addTrack(audioTrack);
        for (const peer of this.peers.values()) {
          try { peer.pc.addTrack(audioTrack, this.localStream!); } catch { /* ignore */ }
        }
      }
      // Поднимаем cap по битрейту/FPS на video sender'е. По умолчанию
      // WebRTC держит ~1-2 Mbps — для статичного экрана норм, для
      // динамики/игр мало. setParameters async, ошибки в каждом peer'е
      // игнорим — peer может уже быть закрыт.
      if (quality) {
        await this.applyScreenShareEncoding(quality);
      }
      this.update({ screenSharing: true, cameraOn: false, error: null });
      this.broadcastState();
      return true;
    }
    // off
    const track = this.screenTrack;
    this.screenTrack = null;
    track.onended = null;
    if (this.localStream) this.localStream.removeTrack(track);
    track.stop();
    // K.5(c): убираем screen-audio sender (но НЕ mic sender — он остаётся).
    // Различаем по сохранённому screenAudioTrack — mic-sender держит другой.
    const screenAudio = this.screenAudioTrack;
    this.screenAudioTrack = null;
    if (screenAudio) {
      if (this.localStream) this.localStream.removeTrack(screenAudio);
      try { screenAudio.stop(); } catch { /* ignore */ }
    }
    for (const peer of this.peers.values()) {
      for (const sender of peer.pc.getSenders()) {
        if (sender.track && sender.track.kind === "video") {
          try {
            peer.pc.removeTrack(sender);
          } catch {
            /* ignore */
          }
        }
        if (screenAudio && sender.track === screenAudio) {
          try { peer.pc.removeTrack(sender); } catch { /* ignore */ }
        }
      }
    }
    // cpal-stream и WASAPI-loopback закрываем явно — track.stop() сам по
    // себе не дёрнет Rust-side, потому что MediaStreamTrackGenerator не
    // имеет внешней wire-up'ки с cpal.
    void releaseScreenAudio();
    this.update({ screenSharing: false });
    this.broadcastState();
    return false;
  }

  // ---- internals -----------------------------------------------------------

  private async dialPeer(other: VoiceParticipant): Promise<void> {
    const callId = randomId();
    // Caller — impolite (polite=false). Он не уступает в коллизии.
    const peer = this.createPeer(other.sessionId, callId, /*polite*/ false);
    this.peers.set(other.sessionId, peer);
    // onnegotiationneeded на свежесозданном PC после synchronous addTrack
    // не всегда стреляет надёжно (зависит от браузера/таймингов) — особенно
    // при re-join, когда создаётся новый PC поверх свежеуничтоженного.
    // Явно триггерим initial offer через setLocalDescription() без аргумента
    // (в современных браузерах он сам собирает корректный offer/answer на
    // основе текущего state). Последующие renegotiate'ы (camera/screen
    // toggle) уже обрабатывает onnegotiationneeded.
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription();
      if (peer.pc.localDescription) {
        this.realtime.send("voice.offer", {
          call_id: callId,
          target_session_id: other.sessionId,
          target_user_id: other.userId,
          channel_id: this.snapshot.channelId ?? "",
          sdp: peer.pc.localDescription
        });
      }
    } catch {
      /* ignore — peer мог уже быть закрыт race'ом */
    } finally {
      peer.makingOffer = false;
    }
    // После offer'а сообщаем своё текущее состояние (screen/camera).
    // Receiver может уже знать через прошлый broadcast, но мы только
    // что подружились — гарантируем первый снимок.
    this.sendStateTo(other.sessionId);
  }

  private createPeer(peerSessionId: string, callId: string, polite: boolean): PeerEntry {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers ?? [] });
    const remoteStream = new MediaStream();
    const remoteAudio = document.createElement("audio");
    remoteAudio.autoplay = true;
    remoteAudio.dataset.voicePeer = peerSessionId;
    remoteAudio.style.display = "none";
    remoteAudio.srcObject = remoteStream;
    document.body.appendChild(remoteAudio);

    const entry: PeerEntry = {
      pc,
      callId,
      remoteStream,
      remoteAudio,
      pendingCandidates: [],
      makingOffer: false,
      polite
    };

    pc.ontrack = (evt) => {
      for (const track of evt.streams[0]?.getTracks() ?? [evt.track]) {
        if (!remoteStream.getTracks().some((x) => x.id === track.id)) {
          remoteStream.addTrack(track);
        }
      }
      // Когда remote добавляет/убирает video — UI должен переотрисовать
      // tile, поэтому форсим snapshot-emit (даже если данные те же).
      this.emit();
    };
    pc.onicecandidate = (evt) => {
      if (!evt.candidate) return;
      this.realtime.send("voice.ice", {
        call_id: callId,
        target_session_id: peerSessionId,
        candidate: evt.candidate.toJSON()
      });
    };
    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected" ||
        pc.connectionState === "closed"
      ) {
        this.destroyPeer(peerSessionId);
      }
    };
    // Perfect-negotiation: каждое изменение треков (addTrack/removeTrack
    // на нашей стороне) триггерит negotiationneeded — мы создаём offer
    // и шлём. handleOffer на той стороне умеет принимать пере-offer.
    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        if (!pc.localDescription) return;
        this.realtime.send("voice.offer", {
          call_id: callId,
          target_session_id: peerSessionId,
          channel_id: this.snapshot.channelId ?? "",
          sdp: pc.localDescription
        });
      } catch {
        /* renegotiate ошибка — игнорим, peer может закрыться */
      } finally {
        entry.makingOffer = false;
      }
    };

    if (this.localStream) {
      for (const t of this.localStream.getTracks()) {
        pc.addTrack(t, this.localStream);
      }
    }
    return entry;
  }

  private destroyPeer(sessionId: string): void {
    const peer = this.peers.get(sessionId);
    if (!peer) return;
    try {
      peer.pc.close();
    } catch {
      /* ignore */
    }
    peer.remoteAudio.srcObject = null;
    peer.remoteAudio.remove();
    this.peers.delete(sessionId);
  }

  private tearDownLocal(): void {
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) t.stop();
      this.localStream = null;
    }
    if (this.screenTrack) {
      this.screenTrack.onended = null;
    }
    if (this.screenAudioTrack) {
      void releaseScreenAudio();
    }
    this.cameraTrack = null;
    this.screenTrack = null;
    this.screenAudioTrack = null;
  }

  private async ensureIceServers(): Promise<void> {
    if (this.iceServers) return;
    try {
      const r = await this.http.get<IceServersResponse>("/api/v1/ice-servers");
      this.iceServers = r.iceServers ?? [];
    } catch {
      this.iceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];
    }
  }

  private async acquireLocalStream(): Promise<void> {
    if (this.localStream) return;
    // I.2: constraints из voiceSettings. По умолчанию ec/agc/ns включены
    // (нативный WebRTC-стек Chromium — NS3/AEC3/AGC2, бесплатно). Юзер
    // может выключить флаги в Settings → Голос и видео → Расширенные.
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: buildAudioConstraints(),
      video: false
    });
  }

  private async onEvent(event: RealtimeEvent): Promise<void> {
    if (event.event === "voice.joined") {
      this.handleVoiceJoined(event.payload as VoiceEventPayload | undefined);
      return;
    }
    if (event.event === "voice.left") {
      this.handleVoiceLeft(event.payload as VoiceEventPayload | undefined);
      return;
    }
    if (!event.event.startsWith("voice.")) return;
    if (this.snapshot.state !== "active") return;
    const p = event.payload as RelayPayload | undefined;
    if (!p || !p.call_id || !p.from_session_id) return;
    // Принимаем только трафик от участников этого же voice-канала.
    const known = this.snapshot.participants.some((x) => x.sessionId === p.from_session_id);
    if (!known) return;

    switch (event.event) {
      case "voice.offer":
        await this.handleOffer(p);
        break;
      case "voice.answer":
        await this.handleAnswer(p);
        break;
      case "voice.ice":
        await this.handleIce(p);
        break;
      case "voice.hangup":
        this.destroyPeer(p.from_session_id);
        break;
      case "voice.state":
        this.handleState(p);
        break;
    }
  }

  // Применить cap на video sender'ах ВРУЧНУЮ (без переоткрытия
   // displayStream'а). Если screenshare сейчас не активен — no-op.
  async applyScreenShareQuality(quality: ScreenShareQuality): Promise<void> {
    if (!this.screenTrack) return;
    await this.applyScreenShareEncoding(quality);
  }

  private async applyScreenShareEncoding(quality: ScreenShareQuality): Promise<void> {
    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find((s) => s.track?.kind === "video");
      if (!sender) continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = quality.maxBitrate;
        params.encodings[0].maxFramerate = quality.frameRate;
        await sender.setParameters(params);
      } catch {
        /* ignore — peer мог закрыться, либо браузер не поддерживает поле */
      }
    }
  }

  private handleState(p: RelayPayload): void {
    if (!p.from_session_id || !p.state) return;
    const sid = p.from_session_id;
    const next = this.snapshot.participants.map((x) =>
      x.sessionId === sid
        ? {
            ...x,
            screenSharing: !!p.state!.screen_sharing,
            cameraOn: !!p.state!.camera_on
          }
        : x
    );
    this.update({ participants: next });
  }

  private sendStateTo(sessionId: string): void {
    try {
      this.realtime.send("voice.state", {
        call_id: this.peers.get(sessionId)?.callId ?? "state",
        target_session_id: sessionId,
        state: {
          screen_sharing: this.snapshot.screenSharing,
          camera_on: this.snapshot.cameraOn
        }
      });
    } catch {
      /* ignore */
    }
  }

  private broadcastState(): void {
    for (const sid of this.peers.keys()) {
      this.sendStateTo(sid);
    }
  }

  private handleVoiceJoined(p: VoiceEventPayload | undefined): void {
    if (!p || p.channelId !== this.snapshot.channelId) return;
    if (p.sessionId === this.snapshot.selfSessionId) return;
    // Если этот session_id уже числится участником — это re-join
    // (например, юзер leave/join подряд, или мы пропустили voice.left
    // из-за race в шине). Уничтожаем устаревший peer и пересоздаём
    // запись — иначе новый offer от него прилетит и `known`-фильтр
    // ниже его пустит, но handleOffer попадёт в наш СТАРЫЙ peer
    // (signalingState!=stable, polite=false → ignoreOffer), и audio
    // не пойдёт.
    if (this.peers.has(p.sessionId)) {
      this.destroyPeer(p.sessionId);
    }
    const next: VoiceParticipant = {
      userId: p.userId,
      sessionId: p.sessionId,
      username: p.username ?? "",
      displayName: p.displayName,
      joinedAt: p.joinedAt ?? new Date().toISOString()
    };
    const without = this.snapshot.participants.filter((x) => x.sessionId !== p.sessionId);
    this.update({ participants: [...without, next] });
    // Новый участник сам сделает offer нам — ничего больше не делаем.
  }

  private handleVoiceLeft(p: VoiceEventPayload | undefined): void {
    if (!p || p.channelId !== this.snapshot.channelId) return;
    this.destroyPeer(p.sessionId);
    this.update({
      participants: this.snapshot.participants.filter((x) => x.sessionId !== p.sessionId)
    });
  }

  private async handleOffer(p: RelayPayload): Promise<void> {
    if (!p.sdp || !p.from_session_id) return;
    let peer = this.peers.get(p.from_session_id);
    if (!peer) {
      // Receiver — polite (уступает в коллизии).
      peer = this.createPeer(p.from_session_id, p.call_id, /*polite*/ true);
      this.peers.set(p.from_session_id, peer);
    }
    // Perfect negotiation: если мы уже шлём свой offer ИЛИ не в stable —
    // это коллизия. Polite сторона откатывает свой offer; impolite —
    // игнорит входящий.
    const offerCollision = peer.makingOffer || peer.pc.signalingState !== "stable";
    const ignoreOffer = !peer.polite && offerCollision;
    if (ignoreOffer) {
      return;
    }
    try {
      await peer.pc.setRemoteDescription(p.sdp);
      await this.drainPending(peer);
      await peer.pc.setLocalDescription();
      if (!peer.pc.localDescription) return;
      this.realtime.send("voice.answer", {
        call_id: p.call_id,
        target_session_id: p.from_session_id,
        sdp: peer.pc.localDescription
      });
    } catch {
      /* ignore — peer мог быть закрыт пока шла обработка */
    }
    // Симметрично dialPeer: после answer'а отправляем своё текущее
    // состояние caller'у, чтобы он знал про screen/camera.
    this.sendStateTo(p.from_session_id);
  }

  private async handleAnswer(p: RelayPayload): Promise<void> {
    if (!p.sdp || !p.from_session_id) return;
    const peer = this.peers.get(p.from_session_id);
    if (!peer) return;
    try {
      await peer.pc.setRemoteDescription(p.sdp);
      await this.drainPending(peer);
    } catch {
      /* ignore */
    }
  }

  private async handleIce(p: RelayPayload): Promise<void> {
    if (!p.candidate || !p.from_session_id) return;
    const peer = this.peers.get(p.from_session_id);
    if (!peer) return;
    if (!peer.pc.remoteDescription) {
      peer.pendingCandidates.push(p.candidate);
      return;
    }
    try {
      await peer.pc.addIceCandidate(p.candidate);
    } catch {
      /* ignore */
    }
  }

  private async drainPending(peer: PeerEntry): Promise<void> {
    const pending = peer.pendingCandidates;
    peer.pendingCandidates = [];
    for (const c of pending) {
      try {
        await peer.pc.addIceCandidate(c);
      } catch {
        /* ignore */
      }
    }
  }

  private update(patch: Partial<VoiceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l(this.snapshot);
  }
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `vc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
