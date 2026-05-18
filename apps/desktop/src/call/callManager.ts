import type { HttpClient } from "../network/httpClient";
import type { RealtimeClient, RealtimeEvent } from "../realtime/realtimeClient";

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
  startedAt: number | null;
  endedReason: string | null;
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

type Listener = (snapshot: CallSnapshot) => void;

const IDLE_SNAPSHOT: CallSnapshot = {
  state: "idle",
  callId: null,
  peerUserId: null,
  peerSessionId: null,
  channelId: null,
  muted: false,
  startedAt: null,
  endedReason: null
};

export class CallManager {
  private snapshot: CallSnapshot = { ...IDLE_SNAPSHOT };
  private listeners = new Set<Listener>();
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private iceServers: RTCIceServer[] | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private unsubscribeRealtime: (() => void) | null = null;

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
    const callId = randomId();
    await this.ensureIceServers();
    await this.acquireLocalStream();
    this.createPeerConnection();

    this.update({
      state: "outgoing",
      callId,
      peerUserId: targetUserId,
      peerSessionId: null,
      channelId: channelId ?? null,
      muted: false,
      startedAt: null,
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
    if (!this.localStream) return this.snapshot.muted;
    const next = !this.snapshot.muted;
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = !next;
    }
    this.update({ muted: next });
    return next;
  }

  // ---------- internals -----------------------------------------------------

  private async ensureIceServers(): Promise<void> {
    if (this.iceServers) return;
    try {
      const resp = await this.http.get<IceServersResponse>("/api/v1/ice-servers");
      this.iceServers = resp.iceServers ?? [];
    } catch {
      this.iceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];
    }
  }

  private async acquireLocalStream(): Promise<void> {
    if (this.localStream) return;
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
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
        this.update({ state: "active", startedAt: Date.now() });
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this.teardown(`peer_${pc.connectionState}`);
      }
    };

    this.pc = pc;
    this.attachLocalTracks();
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
    await this.ensureIceServers();
    this.createPeerConnection();
    this.update({
      state: "incoming",
      callId: p.call_id,
      peerUserId: p.from_user_id ?? null,
      peerSessionId: p.from_session_id ?? null,
      channelId: p.channel_id ?? null,
      muted: false,
      startedAt: null,
      endedReason: null
    });
  }

  private async handleOffer(p: RelayPayload): Promise<void> {
    if (!this.pc || !p.sdp || p.call_id !== this.snapshot.callId) return;
    await this.pc.setRemoteDescription(p.sdp);
    await this.drainPendingCandidates();
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
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        /* ignore */
      }
      this.pc = null;
    }
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.stop();
      }
      this.localStream = null;
    }
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
