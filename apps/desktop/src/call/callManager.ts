import type { HttpClient } from "../network/httpClient";
import type { RealtimeClient, RealtimeEvent } from "../realtime/realtimeClient";
import { buildAudioConstraints, buildVideoConstraints } from "./voiceSettings";
import { acquireScreenShareStream, releaseScreenAudio } from "./screenSharePicker";
import { wrapMicStream, type MicPipeline } from "./denoiser";
import { wrapCameraTrack, type CameraPipeline } from "./videoEffects";
import { MEDIA_CONFIG_UNAVAILABLE } from "./mediaConfig";

export type CallState =
  | "idle"
  | "outgoing"
  | "incoming"
  | "connecting"
  | "active"
  | "ended";

export interface CallSnapshot {
  state: CallState;
  callId: string | null;
  peerUserId: string | null;
  peerSessionId: string | null;
  channelId: string | null;
  muted: boolean;
  cameraOn: boolean;
  screenSharing: boolean;
  startedAt: number | null;
  endedReason: string | null;
  // Wave 0: путь медиа после ICE-коннекта. "relay" = трафик через TURN
  // (оба за NAT), "direct" = p2p (host/srflx). null = ещё не определён.
  via: "relay" | "direct" | null;
}

interface IceServersResponse {
  iceServers: RTCIceServer[];
}

interface CallRecord {
  id: string;
  kind: string;
  initiatorId: string;
  peerId?: string;
  channelId?: string;
  startedAt: string;
  endedAt?: string;
  reason?: string;
  durationMs?: number;
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
}

type Listener = (snapshot: CallSnapshot) => void;

const IDLE_SNAPSHOT: CallSnapshot = {
  state: "idle",
  callId: null,
  peerUserId: null,
  peerSessionId: null,
  channelId: null,
  muted: false,
  cameraOn: false,
  screenSharing: false,
  startedAt: null,
  endedReason: null,
  via: null
};

export class CallManager {
  private snapshot: CallSnapshot = { ...IDLE_SNAPSHOT };
  private listeners = new Set<Listener>();
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  // N.4: pipeline RuCord-шумодава. Владеет raw mic-стримом и AudioContext'ом;
  // localStream выше — это pipeline.stream (для off/browser он же raw).
  private micPipeline: MicPipeline | null = null;
  // Wave 9: pipeline эффекта камеры (размытие фона). Владеет raw-track'ом;
  // cameraTrack ниже — это pipeline.track (для effect=none он же raw).
  private cameraPipeline: CameraPipeline | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  // K.5(c): системный звук screen-share. Отдельный sender от mic'а.
  private screenAudioTrack: MediaStreamTrack | null = null;
  // PTT-гейт (см. voiceChannelManager): отделён от snapshot.muted.
  private pttGateOpen = true;
  private remoteStream: MediaStream | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private iceServers: RTCIceServer[] | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private unsubscribeRealtime: (() => void) | null = null;
  // initiator пишет запись в БД (POST /calls) и завершает её (POST /calls/{id}/end).
  // receiver не пишет — он узнаёт исход через `call.ended` realtime-эвент.
  private isInitiator = false;

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }
  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  constructor(
    private readonly http: HttpClient,
    private readonly realtime: RealtimeClient
  ) {
    this.unsubscribeRealtime = realtime.subscribe((event) => this.onRealtimeEvent(event));
  }

  dispose(): void {
    if (this.unsubscribeRealtime) {
      this.unsubscribeRealtime();
      this.unsubscribeRealtime = null;
    }
    this.teardown("disposed");
  }

  getSnapshot(): CallSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  // ---------- outgoing ------------------------------------------------------

  async placeCall(targetUserId: string, channelId?: string): Promise<void> {
    if (this.snapshot.state !== "idle" && this.snapshot.state !== "ended") {
      throw new Error("call already in progress");
    }
    // Настройки соединения нужны до записи в БД: иначе при сбое останется
    // звонок, который никто не закроет.
    await this.ensureIceServers();
    // Сначала создаём запись в БД — её id служит call_id во ВСЕЙ
    // signaling-цепочке. Раньше клиент сам генерировал randomId() и
    // звонок не оставлял следа в истории; теперь у каждого звонка
    // server-side row, который и закрывается в teardown.
    let record: CallRecord;
    try {
      record = await this.http.post<CallRecord>("/api/v1/calls", {
        kind: "one_to_one",
        peerUserId: targetUserId,
        channelId: channelId ?? undefined
      });
    } catch (err) {
      throw err instanceof Error ? err : new Error("could not start call");
    }
    const callId = record.id;
    this.isInitiator = true;

    await this.acquireLocalStream();
    this.createPeerConnection();

    this.update({
      state: "outgoing",
      callId,
      peerUserId: targetUserId,
      peerSessionId: null,
      channelId: channelId ?? null,
      muted: false,
      // startedAt из БД — единый источник; UI не пляшет от Date.now() оппонента.
      startedAt: Date.parse(record.startedAt) || null,
      endedReason: null
    });

    const offer = await this.pc!.createOffer({ offerToReceiveAudio: true });
    await this.pc!.setLocalDescription(offer);

    this.realtime.send("call.invite", {
      call_id: callId,
      target_user_id: targetUserId,
      channel_id: channelId ?? ""
    });
    this.realtime.send("call.offer", {
      call_id: callId,
      target_user_id: targetUserId,
      sdp: offer
    });
  }

  // ---------- incoming ------------------------------------------------------

  async acceptIncoming(): Promise<void> {
    if (this.snapshot.state !== "incoming" || !this.pc || !this.snapshot.callId) {
      return;
    }
    await this.acquireLocalStream();
    this.attachLocalTracks();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    this.realtime.send("call.answer", {
      call_id: this.snapshot.callId,
      target_user_id: this.snapshot.peerUserId,
      target_session_id: this.snapshot.peerSessionId,
      sdp: answer
    });
    this.update({ state: "connecting" });
  }

  rejectIncoming(): void {
    if (this.snapshot.state !== "incoming") return;
    this.sendHangup("rejected");
    this.teardown("rejected");
  }

  // ---------- common --------------------------------------------------------

  hangup(): void {
    if (this.snapshot.state === "idle" || this.snapshot.state === "ended") return;
    this.sendHangup("hangup");
    this.teardown("hangup");
  }

  toggleMute(): boolean {
    return this.setMute(!this.snapshot.muted);
  }

  // Явный mute пользователя. Реальное состояние трека — комбинация mute
  // и PTT-гейта (см. applyAudioEnabled).
  setMute(muted: boolean): boolean {
    if (this.snapshot.muted === muted) return muted;
    this.update({ muted });
    this.applyAudioEnabled();
    return muted;
  }

  isMuted(): boolean {
    return this.snapshot.muted;
  }

  // PTT-гейт. НЕ трогает snapshot.muted — микрофон визуально «включён».
  setPttGate(open: boolean): void {
    if (this.pttGateOpen === open) return;
    this.pttGateOpen = open;
    this.applyAudioEnabled();
  }

  // Мик-трек активен только если не замьючен И PTT-гейт открыт. Системный
  // звук screen-share (screenAudioTrack) не гейтим.
  private applyAudioEnabled(): void {
    if (!this.localStream) return;
    const enabled = !this.snapshot.muted && this.pttGateOpen;
    for (const track of this.localStream.getAudioTracks()) {
      if (track === this.screenAudioTrack) continue;
      track.enabled = enabled;
    }
  }

  isActive(): boolean {
    return this.snapshot.state === "active";
  }

  async toggleCamera(): Promise<boolean> {
    if (!this.pc || !this.localStream || this.snapshot.state !== "active") {
      return this.snapshot.cameraOn;
    }
    // Камера и screen-share делят один video sender — нельзя одновременно.
    if (this.screenTrack) return false;
    if (!this.cameraTrack) {
      let videoStream: MediaStream;
      try {
        videoStream = await navigator.mediaDevices.getUserMedia({ video: buildVideoConstraints() });
      } catch {
        return false;
      }
      const rawTrack = videoStream.getVideoTracks()[0];
      if (!rawTrack) return false;
      // Wave 9: эффект камеры (размытие фона); для effect=none прозрачный.
      this.cameraPipeline = await wrapCameraTrack(rawTrack);
      const track = this.cameraPipeline.track;
      this.cameraTrack = track;
      this.localStream.addTrack(track);
      try {
        this.pc.addTrack(track, this.localStream);
      } catch {
        /* ignore */
      }
      await this.renegotiate();
      this.update({ cameraOn: true });
      return true;
    }
    const track = this.cameraTrack;
    this.cameraTrack = null;
    this.localStream.removeTrack(track);
    track.stop();
    // Wave 9: dispose гасит raw-track камеры и цикл сегментации.
    if (this.cameraPipeline) {
      this.cameraPipeline.dispose();
      this.cameraPipeline = null;
    }
    for (const sender of this.pc.getSenders()) {
      if (sender.track && sender.track.kind === "video") {
        try {
          this.pc.removeTrack(sender);
        } catch {
          /* ignore */
        }
      }
    }
    await this.renegotiate();
    this.update({ cameraOn: false });
    return false;
  }

  // Демо экрана 1-к-1. См. VoiceChannelManager.toggleScreenShare —
  // та же стратегия: screen замещает камеру, обратно не возвращаемся.
  async toggleScreenShare(): Promise<boolean> {
    if (!this.pc || !this.localStream || this.snapshot.state !== "active") {
      return this.snapshot.screenSharing;
    }
    if (!this.screenTrack) {
      let displayStream: MediaStream;
      try {
        // K.5/K.9: своя capture-pipeline через Tauri, если доступна.
        const result = await acquireScreenShareStream();
        displayStream = result.stream;
      } catch {
        return false;
      }
      const track = displayStream.getVideoTracks()[0];
      if (!track) return false;
      this.screenTrack = track;
      const audioTrack = displayStream.getAudioTracks()[0] ?? null;
      this.screenAudioTrack = audioTrack;
      track.onended = () => {
        if (this.screenTrack === track) {
          void this.toggleScreenShare();
        }
      };
      let hadCamera = false;
      if (this.cameraTrack) {
        hadCamera = true;
        const cam = this.cameraTrack;
        this.cameraTrack = null;
        this.localStream.removeTrack(cam);
        cam.stop();
        // Wave 9: screen замещает камеру — pipeline эффекта больше не нужен.
        if (this.cameraPipeline) {
          this.cameraPipeline.dispose();
          this.cameraPipeline = null;
        }
      }
      this.localStream.addTrack(track);
      if (hadCamera) {
        const sender = this.pc.getSenders().find((s) => s.track?.kind === "video");
        if (sender) {
          try {
            await sender.replaceTrack(track);
          } catch {
            /* ignore */
          }
        }
      } else {
        try {
          this.pc.addTrack(track, this.localStream);
        } catch {
          /* ignore */
        }
        await this.renegotiate();
      }
      if (audioTrack) {
        this.localStream.addTrack(audioTrack);
        try { this.pc.addTrack(audioTrack, this.localStream); } catch { /* ignore */ }
        await this.renegotiate();
      }
      this.update({ screenSharing: true, cameraOn: false });
      return true;
    }
    const track = this.screenTrack;
    this.screenTrack = null;
    track.onended = null;
    this.localStream.removeTrack(track);
    track.stop();
    const screenAudio = this.screenAudioTrack;
    this.screenAudioTrack = null;
    if (screenAudio) {
      this.localStream.removeTrack(screenAudio);
      try { screenAudio.stop(); } catch { /* ignore */ }
    }
    for (const sender of this.pc.getSenders()) {
      if (sender.track && sender.track.kind === "video") {
        try {
          this.pc.removeTrack(sender);
        } catch {
          /* ignore */
        }
      }
      if (screenAudio && sender.track === screenAudio) {
        try { this.pc.removeTrack(sender); } catch { /* ignore */ }
      }
    }
    void releaseScreenAudio();
    await this.renegotiate();
    this.update({ screenSharing: false });
    return false;
  }

  private async renegotiate(): Promise<void> {
    if (!this.pc || !this.snapshot.callId || !this.snapshot.peerSessionId) return;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.realtime.send("call.offer", {
        call_id: this.snapshot.callId,
        target_user_id: this.snapshot.peerUserId,
        target_session_id: this.snapshot.peerSessionId,
        sdp: offer
      });
    } catch {
      /* ignore — peer мог закрыться */
    }
  }

  // ---------- internals -----------------------------------------------------

  private async ensureIceServers(): Promise<void> {
    if (this.iceServers) return;
    // Адреса STUN/TURN выдаёт только свой сервер. Публичных запасных
    // серверов нет: без настроек звонок не начинается, а повторная попытка
    // снова запросит конфигурацию.
    try {
      const resp = await this.http.get<IceServersResponse>("/api/v1/media/config");
      this.iceServers = resp.iceServers ?? [];
    } catch {
      throw new Error(MEDIA_CONFIG_UNAVAILABLE);
    }
  }

  private async acquireLocalStream(): Promise<void> {
    if (this.localStream) return;
    // I.2: constraints из voiceSettings (deviceId + ec/agc/ns).
    const raw = await navigator.mediaDevices.getUserMedia({
      audio: buildAudioConstraints(),
      video: false
    });
    // N.4: rucord-режимы оборачивают микрофон в RNNoise-worklet; для
    // off/browser pipeline прозрачный. При ошибке — fallback на raw внутри.
    this.micPipeline = await wrapMicStream(raw);
    this.localStream = this.micPipeline.stream;
  }

  private createPeerConnection(): void {
    if (this.pc) return;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers ?? [] });

    pc.onicecandidate = (event) => {
      if (!event.candidate || !this.snapshot.callId) return;
      this.realtime.send("call.ice", {
        call_id: this.snapshot.callId,
        target_user_id: this.snapshot.peerUserId,
        target_session_id: this.snapshot.peerSessionId,
        candidate: event.candidate.toJSON()
      });
    };

    pc.ontrack = (event) => {
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream();
        this.attachRemoteAudio();
      }
      for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
        if (!this.remoteStream.getTracks().some((t) => t.id === track.id)) {
          this.remoteStream.addTrack(track);
        }
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        if (this.snapshot.state !== "active") {
          // startedAt уже мог быть выставлен из БД (для initiator) либо
          // прийти в handleAnswer (для receiver). Сохраняем — иначе
          // длительность звонка у пиров разъедется.
          this.update({
            state: "active",
            startedAt: this.snapshot.startedAt ?? Date.now()
          });
        }
        // После коннекта (и после ICE-restart'ов) — определяем путь медиа.
        void this.detectConnectionVia();
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this.teardown(`peer_${pc.connectionState}`);
      }
    };

    this.pc = pc;
    this.attachLocalTracks();
  }

  // Wave 0: смотрим выбранную ICE-кандидат-пару в getStats() — если хоть одна
  // сторона relay, медиа идёт через TURN. Показывается в call-bar: помогает
  // понять «слышно, но лагает» (relay = лишний hop через сервер) и подтвердить,
  // что TURN вообще задействован у пары за NAT.
  private async detectConnectionVia(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      let selectedPairId: string | null = null;
      const pairs: RTCIceCandidatePairStats[] = [];
      stats.forEach((s) => {
        if (s.type === "transport") {
          const t = s as RTCTransportStats;
          if (t.selectedCandidatePairId) selectedPairId = t.selectedCandidatePairId;
        } else if (s.type === "candidate-pair") {
          pairs.push(s as RTCIceCandidatePairStats);
        }
      });
      // Chromium даёт selectedCandidatePairId на transport; Firefox — флаг
      // selected на самой паре; fallback — nominated+succeeded.
      const pair =
        (selectedPairId ? pairs.find((p) => p.id === selectedPairId) : undefined) ??
        pairs.find((p) => (p as unknown as { selected?: boolean }).selected && p.state === "succeeded") ??
        pairs.find((p) => p.nominated && p.state === "succeeded");
      if (!pair?.localCandidateId) return;
      const local = stats.get(pair.localCandidateId) as { candidateType?: string } | undefined;
      const remote = pair.remoteCandidateId
        ? (stats.get(pair.remoteCandidateId) as { candidateType?: string } | undefined)
        : undefined;
      const via = local?.candidateType === "relay" || remote?.candidateType === "relay" ? "relay" : "direct";
      if (this.snapshot.via !== via) this.update({ via });
    } catch {
      /* stats недоступны — индикатор просто не покажется */
    }
  }

  private attachLocalTracks(): void {
    if (!this.pc || !this.localStream) return;
    const senders = this.pc.getSenders();
    for (const track of this.localStream.getTracks()) {
      if (!senders.some((s) => s.track?.id === track.id)) {
        this.pc.addTrack(track, this.localStream);
      }
    }
  }

  private attachRemoteAudio(): void {
    if (!this.remoteStream) return;
    if (!this.remoteAudio) {
      this.remoteAudio = document.createElement("audio");
      this.remoteAudio.autoplay = true;
      this.remoteAudio.style.display = "none";
      document.body.appendChild(this.remoteAudio);
    }
    this.remoteAudio.srcObject = this.remoteStream;
  }

  private async onRealtimeEvent(event: RealtimeEvent): Promise<void> {
    if (!event.event.startsWith("call.")) return;

    // call.ended приходит от сервера (через realtimebus) когда запись в
    // calls закрыта /calls/{id}/end. Полезен для receiver'а — он сам не
    // POST'ит, но из call.ended берёт финальный reason/durationMs.
    if (event.event === "call.ended") {
      const rec = event.payload as CallRecord | undefined;
      if (!rec || !rec.id || rec.id !== this.snapshot.callId) return;
      if (this.snapshot.state === "idle" || this.snapshot.state === "ended") return;
      this.teardown(rec.reason || "remote_ended");
      return;
    }

    const payload = event.payload as RelayPayload | undefined;
    if (!payload || !payload.call_id) return;

    switch (event.event) {
      case "call.invite":
        await this.handleInvite(payload);
        break;
      case "call.offer":
        await this.handleOffer(payload);
        break;
      case "call.answer":
        await this.handleAnswer(payload);
        break;
      case "call.ice":
        await this.handleIce(payload);
        break;
      case "call.hangup":
        this.handleHangup(payload);
        break;
    }
  }

  private async handleInvite(p: RelayPayload): Promise<void> {
    if (this.snapshot.state !== "idle" && this.snapshot.state !== "ended") {
      // занят — отвечаем hangup busy
      this.realtime.send("call.hangup", {
        call_id: p.call_id,
        target_user_id: p.from_user_id,
        target_session_id: p.from_session_id,
        reason: "busy"
      });
      return;
    }
    try {
      await this.ensureIceServers();
    } catch {
      // Без настроек соединения принять звонок нельзя: говорим об этом
      // вызывающему, чтобы он не ждал ответа.
      this.realtime.send("call.hangup", {
        call_id: p.call_id,
        target_user_id: p.from_user_id,
        target_session_id: p.from_session_id,
        reason: "unavailable"
      });
      return;
    }
    this.createPeerConnection();
    this.isInitiator = false;
    // Synchronously start showing incoming. startedAt пытаемся подтянуть
    // с сервера (initiator уже создал запись) — это нужно для синхронной
    // длительности в финальном UI. Если запрос упал — не критично,
    // оставим null и UI покажет 00:00 на старте active.
    this.update({
      state: "incoming",
      callId: p.call_id,
      peerUserId: p.from_user_id ?? null,
      peerSessionId: p.from_session_id ?? null,
      channelId: p.channel_id ?? null,
      muted: false,
      cameraOn: false,
      screenSharing: false,
      startedAt: null,
      endedReason: null
    });
    try {
      const rec = await this.http.get<CallRecord>(`/api/v1/calls/${p.call_id}`);
      if (this.snapshot.callId === p.call_id) {
        this.update({ startedAt: Date.parse(rec.startedAt) || null });
      }
    } catch {
      /* ignore */
    }
  }

  private async handleOffer(p: RelayPayload): Promise<void> {
    if (!this.pc || !p.sdp || p.call_id !== this.snapshot.callId) return;
    await this.pc.setRemoteDescription(p.sdp);
    await this.drainPendingCandidates();
    // Renegotiation — повторный offer уже на установленном соединении
    // (например, оппонент включил камеру). Отвечаем answer'ом
    // автоматически, без UI-подтверждения.
    if (this.snapshot.state === "active") {
      try {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.realtime.send("call.answer", {
          call_id: p.call_id,
          target_user_id: p.from_user_id ?? this.snapshot.peerUserId,
          target_session_id: p.from_session_id ?? this.snapshot.peerSessionId,
          sdp: answer
        });
      } catch {
        /* peer мог закрыться */
      }
    }
  }

  private async handleAnswer(p: RelayPayload): Promise<void> {
    if (!this.pc || !p.sdp || p.call_id !== this.snapshot.callId) return;
    await this.pc.setRemoteDescription(p.sdp);
    if (p.from_session_id && !this.snapshot.peerSessionId) {
      this.update({ peerSessionId: p.from_session_id, state: "connecting" });
    } else {
      this.update({ state: "connecting" });
    }
    await this.drainPendingCandidates();
  }

  private async handleIce(p: RelayPayload): Promise<void> {
    if (!p.candidate || p.call_id !== this.snapshot.callId) return;
    if (!this.pc || !this.pc.remoteDescription) {
      this.pendingCandidates.push(p.candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(p.candidate);
    } catch {
      /* ignore */
    }
  }

  private handleHangup(p: RelayPayload): void {
    if (p.call_id !== this.snapshot.callId) return;
    this.teardown(p.reason || "remote_hangup");
  }

  private async drainPendingCandidates(): Promise<void> {
    if (!this.pc) return;
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const c of pending) {
      try {
        await this.pc.addIceCandidate(c);
      } catch {
        /* ignore */
      }
    }
  }

  private sendHangup(reason: string): void {
    if (!this.snapshot.callId || !this.snapshot.peerUserId) return;
    this.realtime.send("call.hangup", {
      call_id: this.snapshot.callId,
      target_user_id: this.snapshot.peerUserId,
      target_session_id: this.snapshot.peerSessionId,
      reason
    });
  }

  private teardown(reason: string): void {
    // Закрыть БД-запись (только initiator). Сбрасываем флаг до POST,
    // чтобы повторный teardown не дублировал запрос.
    if (this.isInitiator && this.snapshot.callId) {
      const callId = this.snapshot.callId;
      this.isInitiator = false;
      void this.http
        .post(`/api/v1/calls/${callId}/end`, { reason })
        .catch(() => {
          /* idempotent на сервере; сетевая ошибка — не критично */
        });
    } else {
      this.isInitiator = false;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        /* ignore */
      }
      this.pc = null;
    }
    // N.4: dispose pipeline'а до stop'а localStream — гасит raw mic-треки
    // и AudioContext (для rucord-режимов в localStream только обработанный
    // track, сырой без dispose оставил бы mic-индикатор висеть).
    if (this.micPipeline) {
      this.micPipeline.dispose();
      this.micPipeline = null;
    }
    // Wave 9: аналогично для камеры — dispose гасит raw video-track.
    if (this.cameraPipeline) {
      this.cameraPipeline.dispose();
      this.cameraPipeline = null;
    }
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.stop();
      }
      this.localStream = null;
    }
    if (this.screenTrack) this.screenTrack.onended = null;
    this.cameraTrack = null;
    this.screenTrack = null;
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }
    this.remoteStream = null;
    this.pendingCandidates = [];

    if (this.snapshot.state === "idle") return;
    this.update({
      state: "ended",
      endedReason: reason
    });
    // через секунду возвращаемся в idle, чтобы UI успел показать причину
    setTimeout(() => {
      if (this.snapshot.state === "ended") {
        this.snapshot = { ...IDLE_SNAPSHOT };
        this.emit();
      }
    }, 1500);
  }

  private update(patch: Partial<CallSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `call-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
