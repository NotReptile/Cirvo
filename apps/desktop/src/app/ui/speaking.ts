import { uiContext } from "../state";
import { speakingState } from "./speakingState";

// эмпирически: тишина ~3-6, разговор 20+

export function ensureSpeakingContext(): AudioContext | null {
  if (speakingState.speakingCtx) return speakingState.speakingCtx;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    speakingState.speakingCtx = new Ctor();
    return speakingState.speakingCtx;
  } catch {
    return null;
  }
}

export function refreshSpeakingIndicators(
  voiceLocal: MediaStream | null,
  callRemote: MediaStream | null,
): void {
  // Map<key, stream> — key используется и для DOM-селектора, и для
  // удаления нод, когда участник ушёл.
  const targets = new Map<string, MediaStream>();
  if (voiceLocal) targets.set("self", voiceLocal);
  for (const p of uiContext.state.voiceSnapshot?.participants ?? []) {
    if (
      uiContext.state.voiceSnapshot &&
      p.sessionId === uiContext.state.voiceSnapshot.selfSessionId
    )
      continue;
    const stream = uiContext.voiceMgr.getRemoteStream(p.sessionId);
    if (stream) targets.set(`peer:${p.sessionId}`, stream);
  }
  if (callRemote) targets.set("call-remote", callRemote);

  // AudioContext без user-gesture блокируется браузером ("autoplay
  // policy"). Создаём только когда реально есть стрим для анализа —
  // в этот момент юзер уже точно в звонке/voice-канале, т.е. был клик.
  if (targets.size === 0 && speakingState.speakingNodes.size === 0) return;
  const ctx = ensureSpeakingContext();
  if (!ctx) return;
  // Если контекст в suspended — пробуем разбудить (после user-gesture
  // это разрешено, иначе тихо упадём в catch и попробуем позже).
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }

  // Создаём недостающие.
  for (const [key, stream] of targets) {
    if (speakingState.speakingNodes.has(key)) continue;
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) continue;
    try {
      const source = ctx.createMediaStreamSource(
        new MediaStream([audioTracks[0]]),
      );
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      speakingState.speakingNodes.set(key, {
        source,
        analyser,
        buffer: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
        isSpeaking: false,
      });
    } catch {
      // createMediaStreamSource может бросить, если track уже закрыт
      // (например, peer leave прямо в момент refresh). Игнорируем — на
      // следующем refresh подберём свежий stream.
    }
  }
  // Удаляем ушедших.
  for (const [key, node] of speakingState.speakingNodes) {
    if (!targets.has(key)) {
      try {
        node.source.disconnect();
      } catch {}
      try {
        node.analyser.disconnect();
      } catch {}
      speakingState.speakingNodes.delete(key);
    }
  }
  if (
    speakingState.speakingNodes.size > 0 &&
    speakingState.speakingRaf === null
  ) {
    speakingState.speakingRaf = requestAnimationFrame(speakingLoop);
  } else if (
    speakingState.speakingNodes.size === 0 &&
    speakingState.speakingRaf !== null
  ) {
    cancelAnimationFrame(speakingState.speakingRaf);
    speakingState.speakingRaf = null;
  }
}

export function speakingLoop(): void {
  for (const [key, node] of speakingState.speakingNodes) {
    node.analyser.getByteFrequencyData(node.buffer);
    let sum = 0;
    for (let i = 0; i < node.buffer.length; i++) sum += node.buffer[i];
    const avg = sum / node.buffer.length;
    const speaking = avg > uiContext.SPEAKING_THRESHOLD;
    if (speaking === node.isSpeaking) continue;
    node.isSpeaking = speaking;
    const selector =
      key === "self"
        ? ".voice-tile.self"
        : key.startsWith("peer:")
          ? `.voice-tile [data-voice-peer="${CSS.escape(key.slice(5))}"]`
          : `.call-video-tile`;
    const el = uiContext.rootEl.querySelector<HTMLElement>(selector);
    const tile = el?.closest<HTMLElement>(".voice-tile, .call-video-tile");
    if (tile) tile.classList.toggle("speaking", speaking);
  }
  speakingState.speakingRaf =
    speakingState.speakingNodes.size > 0
      ? requestAnimationFrame(speakingLoop)
      : null;
}
