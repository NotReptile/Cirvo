import { applyOutputDevice, getOutputVolume } from "../../call/voiceSettings";
import { bindEvent } from "../dom";
import { describeError } from "../errors";
import { t } from "../i18n";
import { icon } from "../icons";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type { Channel, PendingUpload, ScreenShareQualityKey } from "../types";
import { escapeHtml } from "../util/html";
import { callIconButton, describePeer } from "./callView";
import { channelPrefix } from "./channelView";
import { isDeafened } from "./loaders";
import { renderAvatar } from "./shell";
import { refreshSpeakingIndicators } from "./speaking";

// Селект качества демонстрации экрана (рядом с кнопкой «Поделиться
// экраном»). Применяется при следующем toggleScreenShare; если уже
// шарим — applyScreenShareQuality переприменяет cap на лету.
export function renderScreenQualitySelect(): string {
  const cur = uiContext.state.screenShareQuality;
  const opts = (
    Object.keys(uiContext.SCREEN_SHARE_PRESETS) as ScreenShareQualityKey[]
  )
    .map(
      (k) =>
        `<option value="${k}"${k === cur ? " selected" : ""}>${k}</option>`,
    )
    .join("");
  return `<select class="screen-quality-select ghost" aria-label="${t("voice.quality")}">${opts}</select>`;
}

export function renderVoiceChannelView(channel: Channel): string {
  const voice = uiContext.state.voiceSnapshot;
  const joined = voice?.channelId === channel.id;
  const busyOther = voice && !joined ? voice.channelId : null;
  const participants = joined
    ? voice!.participants
    : uiContext.state.voicePeek?.channelId === channel.id
      ? uiContext.state.voicePeek.participants
      : [];
  const selfSessionId = joined ? voice!.selfSessionId : null;
  const joining = voice?.state === "joining";
  const leaving = voice?.state === "leaving";
  const muted = joined && voice!.muted;
  const cameraOn = joined && voice!.cameraOn;
  const screenOn = joined && voice!.screenSharing;
  const error = voice?.error ?? null;

  // tiles: один на каждого участника. Для своих — local stream через
  // data-voice-self; для чужих — remote stream через data-voice-peer.
  // srcObject цепляется после render() в attachVoiceVideoStreams().
  //
  // Screenshare-layout: если кто-то делится экраном (self или peer),
  // его tile становится primary (большой, сверху), остальные —
  // в горизонтальной полосе под ним. peer.screenSharing приходит
  // через `voice.state` (отдельный сигналинг, см. PeerStatePayload).
  const renderTile = (
    p: (typeof participants)[number],
    extraClass = "",
  ): string => {
    const name = p.displayName?.trim() || p.username || p.userId.slice(0, 8);
    const isSelf = selfSessionId !== null && p.sessionId === selfSessionId;
    const tag = isSelf
      ? `data-voice-self="1"`
      : `data-voice-peer="${escapeHtml(p.sessionId)}"`;
    const sharing = isSelf ? screenOn : !!p.screenSharing;
    // Без видео <video> — чёрный прямоугольник; рисуем Discord-like заглушку
    // с аватаром. Speaking-кольцо вешает CSS по .voice-tile.speaking
    // (speakingLoop). Аватар берём из members: VoiceParticipant несёт только
    // имя, avatarMediaId у него нет.
    const hasVideo = isSelf
      ? cameraOn || screenOn
      : !!p.cameraOn || !!p.screenSharing;
    const member = uiContext.state.members.find((m) => m.userId === p.userId);
    const avatarMediaId =
      p.userId === uiContext.state.me?.id
        ? uiContext.state.me?.avatarMediaId
        : member?.avatarMediaId;
    const cls = `voice-tile${isSelf ? " self" : ""}${sharing ? " sharing" : ""}${hasVideo ? " has-video" : ""}${extraClass ? " " + extraClass : ""}`;
    return `<div class="${cls}">
      <video class="voice-tile-video" ${tag} autoplay playsinline ${isSelf ? "muted" : ""}></video>
      <div class="voice-tile-placeholder">
        ${renderAvatar({
          avatarMediaId,
          fallbackText: name,
          sizePx: 72,
          decoration: member?.avatarDecoration,
        })}
      </div>
      <div class="voice-tile-overlay">
        <span class="voice-dot"></span>
        <span class="voice-name">${escapeHtml(name)}${isSelf ? ` ${t("voice.you")}` : ""}</span>
        ${sharing ? `<span class="voice-tile-live">${t("voice.live")}</span>` : ""}
      </div>
    </div>`;
  };

  const sharer = participants.find((p) => {
    const isSelf = selfSessionId !== null && p.sessionId === selfSessionId;
    return isSelf ? screenOn : !!p.screenSharing;
  });

  // K.4: пустой voice-канал — Discord-style hero-view с большим именем
  // канала, подзаголовком и primary-кнопкой по центру. Когда есть
  // участники (joined или просто peek с активными) — обычный voice-tiles
  // layout.
  // Wave 8: архивный voice — join спрятан (бэк в любом случае вернёт 403).
  const isArchived = !!channel.archivedAt;
  const header = `
    <header class="channel-header">
      <div class="channel-header-title">
        <h2>${channelPrefix(channel)}<span class="channel-header-name">${escapeHtml(channel.name)}</span></h2>
        ${isArchived ? `<span class="channel-archived-badge">${t("chat.header.archived")}</span>` : ""}
        ${channel.topic ? `<span class="channel-header-sep">·</span><span class="channel-header-topic">${escapeHtml(channel.topic)}</span>` : ""}
      </div>
    </header>
  `;

  if (participants.length === 0 && !joined) {
    const subtitle = isArchived
      ? t("chat.composer.archived")
      : busyOther
        ? t("voice.busy")
        : t("voice.hero.none");
    return `
      ${header}
      <div class="voice-hero">
        <div class="voice-hero-card">
          <h1 class="voice-hero-title">${escapeHtml(channel.name)}</h1>
          <div class="voice-hero-subtitle">${escapeHtml(subtitle)}</div>
          ${
            isArchived
              ? ""
              : `<button id="voice-join" class="voice-hero-cta primary" data-channel-id="${channel.id}" ${joining || busyOther ? "disabled" : ""}>
            ${icon("phone-outgoing", { size: 16 })}
            <span>${joining ? t("voice.joining") : t("voice.hero.join")}</span>
          </button>`
          }
          ${error ? `<div class="voice-hero-error">${escapeHtml(error)}</div>` : ""}
        </div>
      </div>
    `;
  }

  const tiles = sharer
    ? `<div class="voice-tiles screen-layout">
        <div class="voice-primary">${renderTile(sharer, "primary")}</div>
        <div class="voice-strip-tiles">${participants
          .filter((p) => p.sessionId !== sharer.sessionId)
          .map((p) => renderTile(p))
          .join("")}</div>
      </div>`
    : `<div class="voice-tiles">${participants.map((p) => renderTile(p)).join("")}</div>`;

  const actions = joined
    ? `
      ${callIconButton("voice-mute", muted ? "mic-off" : "mic", muted ? t("voice.unmute") : t("voice.mute"), muted ? "danger" : "")}
      ${callIconButton("voice-deafen", isDeafened() ? "headphones-off" : "headphones", isDeafened() ? t("voice.undeafen") : t("voice.deafen"), isDeafened() ? "danger" : "")}
      ${callIconButton("voice-camera", cameraOn ? "camera-off" : "camera", cameraOn ? t("voice.cam.off") : t("voice.cam.on"), "", screenOn)}
      ${callIconButton("voice-screen", screenOn ? "screen-off" : "screen", screenOn ? t("voice.screen.stop") : t("voice.screen.start"), screenOn ? "active" : "")}
      ${renderScreenQualitySelect()}
      <span class="voice-actions-sep"></span>
      ${callIconButton("voice-leave", "log-out", leaving ? t("voice.leaving") : t("voice.leave"), "hangup", leaving)}
    `
    : `
      <button id="voice-join" class="primary" data-channel-id="${channel.id}" ${joining || busyOther ? "disabled" : ""}>
        ${icon("phone-outgoing", { size: 16 })} ${joining ? t("voice.joining") : t("voice.join")}
      </button>
      ${busyOther ? `<div class="muted">${t("voice.busy")}</div>` : ""}
    `;

  return `
    ${header}
    <div class="voice-room">
      <div class="voice-room-body">
        <h3>${t("voice.now")}</h3>
        ${tiles}
        ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
      </div>
      <div class="voice-room-actions">${actions}</div>
    </div>
  `;
}

// Persistent strip: когда юзер в voice-канале, в sidebar снизу видим
// «в #X» с участниками и быстрыми контролами — даже когда смотрим
// другой канал. Discord-like.
export function renderVoiceStrip(): string {
  const voice = uiContext.state.voiceSnapshot;
  if (!voice || !voice.channelId) return "";
  const channel = uiContext.state.channels.find(
    (c) => c.id === voice.channelId,
  );
  const channelName = channel?.name ?? voice.channelId.slice(0, 8);
  const muted = voice.muted;
  const cameraOn = voice.cameraOn;
  const screenOn = voice.screenSharing;
  const leaving = voice.state === "leaving";

  const participants = voice.participants
    .map((p) => {
      const name = p.displayName?.trim() || p.username || p.userId.slice(0, 8);
      const isSelf = p.sessionId === voice.selfSessionId;
      return `<li class="voice-strip-participant${isSelf ? " self" : ""}">
        <span class="voice-dot"></span>
        <span>${escapeHtml(name)}${isSelf ? ` ${t("voice.you")}` : ""}</span>
      </li>`;
    })
    .join("");

  return `
    <div class="voice-strip">
      <div class="voice-strip-header" data-voice-jump="${voice.channelId}">
        ${icon("users", { size: 14 })}
        <span class="voice-strip-channel">${escapeHtml(channelName)}</span>
      </div>
      <ul class="voice-strip-list">${participants}</ul>
      <div class="voice-strip-actions">
        ${callIconButton("voice-mute", muted ? "mic-off" : "mic", muted ? t("voice.unmute") : t("voice.mute"), muted ? "danger" : "")}
        ${callIconButton("voice-deafen", isDeafened() ? "headphones-off" : "headphones", isDeafened() ? t("voice.undeafen") : t("voice.deafen"), isDeafened() ? "danger" : "")}
        ${callIconButton("voice-camera", cameraOn ? "camera-off" : "camera", cameraOn ? t("voice.cam.off") : t("voice.cam.on"), "", screenOn)}
        ${callIconButton("voice-screen", screenOn ? "screen-off" : "screen", screenOn ? t("voice.screen.stop") : t("voice.screen.start"), screenOn ? "active" : "")}
        ${callIconButton("voice-leave", "log-out", leaving ? t("voice.leaving") : t("voice.leave"), "hangup", leaving)}
      </div>
    </div>
  `;
}

// После render() цепляем MediaStream'ы в <video data-voice-*> /
// <video data-call-*> элементы. Через innerHTML srcObject не
// сериализуется — нужно ставить программно.
export function attachVoiceVideoStreams(): void {
  const voiceLocal = uiContext.voiceMgr.getLocalStream();
  // I.2: global output-volume и output-device применяются к каждому
  // <video> с remote-стримом. Per-peer volume (state.voiceVolumes)
  // умножается сверху — позволяет точечно приглушить шумного соседа.
  const globalOut = getOutputVolume();
  for (const el of uiContext.rootEl.querySelectorAll<HTMLVideoElement>(
    "video[data-voice-self]",
  )) {
    if (el.srcObject !== voiceLocal) el.srcObject = voiceLocal;
  }
  for (const el of uiContext.rootEl.querySelectorAll<HTMLVideoElement>(
    "video[data-voice-peer]",
  )) {
    const sid = el.dataset.voicePeer;
    if (!sid) continue;
    const stream = uiContext.voiceMgr.getRemoteStream(sid);
    if (el.srcObject !== stream) el.srcObject = stream;
    el.volume = Math.min(
      1,
      (uiContext.state.voiceVolumes[sid] ?? 1) * globalOut,
    );
    void applyOutputDevice(el);
    // Подстраховка аватар-заглушки: сигналинг cameraOn (voice.state) может
    // отстать от реального видеотрека — верим живому стриму.
    if (stream?.getVideoTracks().some((t) => t.readyState === "live")) {
      el.closest(".voice-tile")?.classList.add("has-video");
    }
  }
  const callLocal = uiContext.callMgr.getLocalStream();
  const callRemote = uiContext.callMgr.getRemoteStream();
  const overlay = uiContext.rootEl.querySelector<HTMLElement>(
    ".call-video-overlay",
  );
  if (overlay) {
    overlay.hidden = ![callLocal, callRemote].some((stream) =>
      stream?.getVideoTracks().some((track) => track.readyState === "live"),
    );
  }
  for (const el of uiContext.rootEl.querySelectorAll<HTMLVideoElement>(
    "video[data-call-self]",
  )) {
    if (el.srcObject !== callLocal) el.srcObject = callLocal;
  }
  for (const el of uiContext.rootEl.querySelectorAll<HTMLVideoElement>(
    "video[data-call-remote]",
  )) {
    if (el.srcObject !== callRemote) el.srcObject = callRemote;
    el.volume = Math.min(
      1,
      (uiContext.state.voiceVolumes["call-remote"] ?? 1) * globalOut,
    );
    void applyOutputDevice(el);
  }
  // Speaking-indicator: создаём/обновляем analyser-узлы для всех участников
  // (включая себя), drop'аем для тех, кого больше нет в DOM.
  refreshSpeakingIndicators(voiceLocal, callRemote);
  attachVoiceTileFullscreen();
}

// Двойной клик на voice-tile разворачивает его поверх voice-room (через
// position:fixed inset:24px), повторный клик возвращает в сетку. Один tile
// в fullscreen за раз: при разворачивании снимаем класс с остальных.
export function attachVoiceTileFullscreen(): void {
  const tiles =
    uiContext.rootEl.querySelectorAll<HTMLDivElement>(".voice-tile");
  for (const tile of Array.from(tiles)) {
    if ((tile as HTMLElement & { _fsAttached?: boolean })._fsAttached) continue;
    (tile as HTMLElement & { _fsAttached?: boolean })._fsAttached = true;
    bindEvent(
      tile,
      "dblclick",
      () => {
        const wasFs = tile.classList.contains("fullscreen");
        for (const other of Array.from(tiles))
          other.classList.remove("fullscreen");
        if (!wasFs) tile.classList.add("fullscreen");
      },
      "bind-217942",
    );
    // ПКМ на чужом тайле открывает volume-popup. На своём (self) и без
    // данных peer'а — игнор.
    bindEvent(
      tile,
      "contextmenu",
      (ev) => {
        if (tile.classList.contains("self")) return;
        const video = tile.querySelector<HTMLVideoElement>(
          "video[data-voice-peer]",
        );
        const sid = video?.dataset.voicePeer;
        if (!sid) return;
        ev.preventDefault();
        const p = uiContext.state.voiceSnapshot?.participants.find(
          (x) => x.sessionId === sid,
        );
        const label = p
          ? p.displayName || p.username || sid.slice(0, 8)
          : "Участник";
        const x = Math.min(ev.clientX, window.innerWidth - 280);
        const y = Math.min(ev.clientY, window.innerHeight - 200);
        uiContext.state.voiceVolumeMenu = { key: sid, label, x, y };
        render();
      },
      "bind-218292",
    );
  }
  // Аналогично для 1-к-1 tile'а (call-video-tile с data-call-remote).
  const callTiles =
    uiContext.rootEl.querySelectorAll<HTMLDivElement>(".call-video-tile");
  for (const tile of Array.from(callTiles)) {
    if ((tile as HTMLElement & { _fsAttached?: boolean })._fsAttached) continue;
    (tile as HTMLElement & { _fsAttached?: boolean })._fsAttached = true;
    const video = tile.querySelector<HTMLVideoElement>(
      "video[data-call-remote]",
    );
    if (!video) continue;
    bindEvent(
      tile,
      "contextmenu",
      (ev) => {
        ev.preventDefault();
        const peerName = uiContext.state.callSnapshot
          ? describePeer(uiContext.state.callSnapshot.peerUserId)
          : "Собеседник";
        const x = Math.min(ev.clientX, window.innerWidth - 280);
        const y = Math.min(ev.clientY, window.innerHeight - 200);
        uiContext.state.voiceVolumeMenu = {
          key: "call-remote",
          label: peerName,
          x,
          y,
        };
        render();
      },
      "bind-219418",
    );
  }
}

export async function uploadFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  const slotsLeft =
    uiContext.MAX_ATTACHMENTS - uiContext.state.pendingUploads.length;
  if (slotsLeft <= 0) {
    uiContext.state.status = `Достигнут лимит вложений (${uiContext.MAX_ATTACHMENTS}).`;
    render();
    return;
  }
  let truncated = false;
  if (files.length > slotsLeft) {
    files = files.slice(0, slotsLeft);
    truncated = true;
  }
  uiContext.state.uploadInFlight = true;
  render();
  const results = await Promise.allSettled(
    files.map((f) =>
      uiContext.httpClient.uploadFile<PendingUpload>("/api/v1/uploads", f),
    ),
  );
  const uploaded: PendingUpload[] = [];
  let firstError: unknown = null;
  for (const r of results) {
    if (r.status === "fulfilled") uploaded.push(r.value);
    else if (firstError === null) firstError = r.reason;
  }
  if (uploaded.length > 0) {
    uiContext.state.pendingUploads = [
      ...uiContext.state.pendingUploads,
      ...uploaded,
    ];
  }
  if (firstError) {
    uiContext.state.status = describeError(firstError);
  } else if (truncated) {
    uiContext.state.status = `Часть файлов отброшена — лимит ${uiContext.MAX_ATTACHMENTS} вложений.`;
  }
  uiContext.state.uploadInFlight = false;
  render();
}

export function attachDropZoneHandlers(): void {
  const content = uiContext.rootEl.querySelector<HTMLElement>("main.content");
  const zone = uiContext.rootEl.querySelector<HTMLDivElement>("#drop-zone");
  if (!content || !zone) return;
  let depth = 0;
  const show = () => {
    zone.hidden = false;
  };
  const hide = () => {
    depth = 0;
    zone.hidden = true;
  };
  bindEvent(
    content,
    "dragenter",
    (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      show();
    },
    "bind-225686",
  );
  bindEvent(
    content,
    "dragover",
    (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    },
    "bind-225820",
  );
  bindEvent(
    content,
    "dragleave",
    (e) => {
      if (!hasFiles(e)) return;
      depth--;
      if (depth <= 0) hide();
    },
    "bind-225988",
  );
  bindEvent(
    content,
    "drop",
    async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      hide();
      const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
      if (files.length > 0) await uploadFiles(files);
    },
    "bind-226114",
  );
}

export function hasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "Files") return true;
  }
  return false;
}
