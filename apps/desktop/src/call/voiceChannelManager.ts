import type { HttpClient } from "../network/httpClient";
import type { RealtimeClient, RealtimeEvent } from "../realtime/realtimeClient";

// Voice-канал. Multi-peer mesh поверх существующего call.* сигналинга:
// каждый участник держит свою RTCPeerConnection с каждым другим.
// При входе: POST /voice/join, для каждого из текущих участников шлём
// call.invite + call.offer (мы — caller для них). Когда новый человек
// заходит — он шлёт нам offer, мы отвечаем answer. На выходе закрываем
// все PC + шлём call.hangup каждому.
//
// Предел ~5 (констанит сервер). Выше уйдём на SFU (F.2).

export interface VoiceParticipant {
  userId: string;
  sessionId: string;
  username: string;
  displayName?: string;
  joinedAt: string;
}

export type VoiceState = "idle" | "joining" | "active" | "leaving";

export interface VoiceSnapshot {
  channelId: string | null;
  participants: VoiceParticipant[];
  selfSessionId: string | null;
  muted: boolean;
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
}

const IDLE: VoiceSnapshot = {
  channelId: null,
  participants: [],
  selfSessionId: null,
  muted: false,
  state: "idle",
  error: null
};

export class VoiceChannelManager {
  private snapshot: VoiceSnapshot = { ...IDLE };
  private listeners = new Set<Listener>();
  private localStream: MediaStream | null = null;
  private iceServers: RTCIceServer[] | null = null;
  private peers = new Map<string, PeerEntry>(); // key = peer sessionId
  private unsubscribe: (() => void) | null = null;

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
        this.realtime.send("call.hangup", {
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
    if (!this.localStream) return this.snapshot.muted;
    const next = !this.snapshot.muted;
    for (const t of this.localStream.getAudioTracks()) {
      t.enabled = !next;
    }
    this.update({ muted: next });
    return next;
  }

  // ---- internals -----------------------------------------------------------

  private async dialPeer(other: VoiceParticipant): Promise<void> {
    const callId = randomId();
    const peer = this.createPeer(other.sessionId, callId);
    this.peers.set(other.sessionId, peer);

    const offer = await peer.pc.createOffer({ offerToReceiveAudio: true });
    await peer.pc.setLocalDescription(offer);

    this.realtime.send("call.invite", {
      call_id: callId,
      target_session_id: other.sessionId,
      target_user_id: other.userId,
      channel_id: this.snapshot.channelId ?? ""
    });
    this.realtime.send("call.offer", {
      call_id: callId,
      target_session_id: other.sessionId,
      target_user_id: other.userId,
      sdp: offer
    });
  }

  private createPeer(peerSessionId: string, callId: string): PeerEntry {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers ?? [] });
    const remoteStream = new MediaStream();
    const remoteAudio = document.createElement("audio");
    remoteAudio.autoplay = true;
    remoteAudio.dataset.voicePeer = peerSessionId;
    remoteAudio.style.display = "none";
    remoteAudio.srcObject = remoteStream;
    document.body.appendChild(remoteAudio);

    pc.ontrack = (evt) => {
      for (const track of evt.streams[0]?.getTracks() ?? [evt.track]) {
        if (!remoteStream.getTracks().some((x) => x.id === track.id)) {
          remoteStream.addTrack(track);
        }
      }
    };
    pc.onicecandidate = (evt) => {
      if (!evt.candidate) return;
      this.realtime.send("call.ice", {
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
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) {
        pc.addTrack(t, this.localStream);
      }
    }
    return { pc, callId, remoteStream, remoteAudio, pendingCandidates: [] };
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
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
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
    if (!event.event.startsWith("call.")) return;
    if (this.snapshot.state !== "active") return;
    const p = event.payload as RelayPayload | undefined;
    if (!p || !p.call_id || !p.from_session_id) return;
    // Принимаем только трафик от участников этого же voice-канала, чтобы
    // не пересечься с 1-to-1 звонком (его обрабатывает CallManager).
    const known = this.snapshot.participants.some((x) => x.sessionId === p.from_session_id);
    if (!known) return;

    switch (event.event) {
      case "call.offer":
        await this.handleOffer(p);
        break;
      case "call.answer":
        await this.handleAnswer(p);
        break;
      case "call.ice":
        await this.handleIce(p);
        break;
      case "call.hangup":
        this.destroyPeer(p.from_session_id);
        break;
    }
  }

  private handleVoiceJoined(p: VoiceEventPayload | undefined): void {
    if (!p || p.channelId !== this.snapshot.channelId) return;
    if (p.sessionId === this.snapshot.selfSessionId) return;
    if (this.snapshot.participants.some((x) => x.sessionId === p.sessionId)) return;
    const next: VoiceParticipant = {
      userId: p.userId,
      sessionId: p.sessionId,
      username: p.username ?? "",
      displayName: p.displayName,
      joinedAt: p.joinedAt ?? new Date().toISOString()
    };
    this.update({ participants: [...this.snapshot.participants, next] });
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
      peer = this.createPeer(p.from_session_id, p.call_id);
      this.peers.set(p.from_session_id, peer);
    }
    await peer.pc.setRemoteDescription(p.sdp);
    await this.drainPending(peer);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    this.realtime.send("call.answer", {
      call_id: p.call_id,
      target_session_id: p.from_session_id,
      sdp: answer
    });
  }

  private async handleAnswer(p: RelayPayload): Promise<void> {
    if (!p.sdp || !p.from_session_id) return;
    const peer = this.peers.get(p.from_session_id);
    if (!peer) return;
    if (peer.pc.signalingState === "stable") return;
    await peer.pc.setRemoteDescription(p.sdp);
    await this.drainPending(peer);
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
