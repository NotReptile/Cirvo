import { expect, it, vi } from "vitest";
import { VoiceChannelManager } from "./voiceChannelManager";

it("mesh initial/renegotiated offers, ICE, answer, state and leave retain channel context", async () => {
  class Peer {
    signalingState = "stable";
    localDescription = { type: "answer", sdp: "QA" };
    onicecandidate: any;
    getSenders() { return []; }
    async setRemoteDescription() {}
    async setLocalDescription() {}
    close() {}
  }
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("MediaStream", class { getTracks() { return []; } });
  vi.stubGlobal("document", { body: { appendChild() {} }, createElement() { return { dataset: {}, style: {}, remove() {} }; } });
  const send = vi.fn();
  const post = vi.fn(async () => ({}));
  const manager = new VoiceChannelManager({ post } as any, { send, subscribe: () => () => {} } as any);
  const internal = manager as any;
  internal.snapshot = { ...manager.getSnapshot(), state: "active", channelId: "voice-channel", participants: [] };
  try {
    await internal.dialPeer({ userId: "peer-user", sessionId: "peer-session" });
    const peer = internal.peers.get("peer-session");
    await peer.pc.onnegotiationneeded();
    expect(send.mock.calls.filter(([event]) => event === "voice.offer")).toHaveLength(2);
    peer.pc.onicecandidate({ candidate: { toJSON: () => ({ candidate: "QA" }) } });
    await internal.handleOffer({ call_id: "mesh-call", from_session_id: "peer-session", sdp: { type: "offer", sdp: "QA" } });
    await manager.leave();
    for (const event of ["voice.offer", "voice.ice", "voice.answer", "voice.state", "voice.hangup"]) {
      expect(send).toHaveBeenCalledWith(event, expect.objectContaining({ channel_id: "voice-channel", target_session_id: "peer-session" }));
    }
    expect(post).toHaveBeenCalledWith("/api/v1/channels/voice-channel/voice/leave", {});
  } finally { vi.unstubAllGlobals(); }
});
