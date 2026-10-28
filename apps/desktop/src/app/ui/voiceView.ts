import { participantVolumes } from "../../call/participantVolumes";
import { remoteAudioRouter, type RemoteAudioSlot } from "../../call/remoteAudio";
import { applyOutputDevice, getOutputDeviceId, getOutputVolume } from "../../call/voiceSettings";
import { bindEvent } from "../dom";
import { describeError } from "../errors";
import { t } from "../i18n";
import { icon } from "../icons";
import { queueRender, requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type { Channel, PendingUpload, ScreenShareQualityKey } from "../types";
import { escapeHtml } from "../util/html";
import { authorColorStyle, callIconButton, describePeer } from "./callView";
import { channelPrefix } from "./channelView";
import { isDeafened } from "./loaders";
import { renderAvatar, resolvePeerAvatarMediaId } from "./shell";
import { resolveUserPresence } from "../presence";
import { refreshSpeakingIndicators } from "./speaking";
import {
  applyFullscreenState,
  getFullscreenSession,
  getPinnedSession,
  installFullscreenController,
  planStreamLayout,
  pruneLayoutState,
  toggleTileFullscreen,
  togglePinnedSession,
} from "./voiceLayout";

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

export function renderActiveVoiceAudioControls(): string {
  const voice = uiContext.state.voiceSnapshot;
  if (!voice?.channelId) return "";
  const busy = voice.state === "joining" || voice.state === "leaving";
  const deafened = isDeafened();
  return `
    ${callIconButton("voice-mute", voice.muted ? "mic-off" : "mic", voice.muted ? t("voice.unmute") : t("voice.mute"), voice.muted ? "danger" : "", busy, voice.muted)}
    ${callIconButton("voice-deafen", deafened ? "headphones-off" : "headphones", deafened ? t("voice.undeafen") : t("voice.deafen"), deafened ? "danger" : "", busy, deafened)}
  `;
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
  const isSharing = (p: (typeof participants)[number]): boolean =>
    selfSessionId !== null && p.sessionId === selfSessionId
      ? screenOn
      : !!p.screenSharing;
  pruneLayoutState(
    participants.filter(isSharing).map((p) => p.sessionId),
    participants.map((p) => p.sessionId),
  );
  const pinnedId = getPinnedSession();
  const fullscreenId = getFullscreenSession();
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
    const presence = resolveUserPresence(p.userId, member);
    const selfProfile = p.userId === uiContext.state.me?.id ? uiContext.state.me : null;
    const avatarMediaId = resolvePeerAvatarMediaId(p.userId);
    const cls = `voice-tile${isSelf ? " self" : ""}${sharing ? " sharing" : ""}${hasVideo ? " has-video" : ""}${extraClass ? " " + extraClass : ""}${fullscreenId === p.sessionId ? " fullscreen" : ""}${pinnedId === p.sessionId ? " pinned" : ""}`;
    const pinLabel = pinnedId === p.sessionId ? "Открепить" : "Закрепить";
    const tileButtons = sharing
      ? `<div class="voice-tile-tools">
          <button class="voice-tile-tool ghost" data-voice-pin="${escapeHtml(p.sessionId)}" aria-pressed="${pinnedId === p.sessionId}" data-tooltip="${pinLabel}" aria-label="${pinLabel}">${icon("pin", { size: 16 })}</button>
          <button class="voice-tile-tool ghost" data-voice-fs="${escapeHtml(p.sessionId)}" data-tooltip="На весь экран" aria-label="На весь экран">${icon("maximize", { size: 16 })}</button>
        </div>`
      : "";
    return `<div class="${cls}" data-voice-tile="${escapeHtml(p.sessionId)}" data-voice-user="${escapeHtml(p.userId)}">
      <video class="voice-tile-video" ${tag} autoplay playsinline ${isSelf ? "muted" : ""}></video>
      <div class="voice-tile-placeholder">
        <button class="voice-tile-avatar-button ghost" data-profile-user="${escapeHtml(p.userId)}" aria-label="${escapeHtml(name)}">${renderAvatar({
          avatarMediaId,
          fallbackText: name,
          sizePx: 88,
          decoration: selfProfile?.avatarDecoration ?? member?.avatarDecoration,
        })}</button>
        ${presence.customStatus ? `<span class="voice-tile-custom-status">${escapeHtml(presence.customStatus)}</span>` : ""}
      </div>
      <div class="voice-tile-overlay">
        <span class="voice-dot"></span>
        <button class="voice-name ghost" data-profile-user="${escapeHtml(p.userId)}"${authorColorStyle(p.userId)}>${escapeHtml(name)}${isSelf ? ` ${t("voice.you")}` : ""}</button>
        ${isSelf && voice?.muted ? icon("mic-off", { size: 14 }) : ""}
        ${sharing ? `<span class="voice-tile-live">${t("voice.live")}</span>` : ""}
      </div>
      ${tileButtons}
    </div>`;
  };


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

  // Раскладка: 1 стрим — крупно; закреплённый — крупно + полоса миниатюр;
  // 2+ стрима — сетка равных плиток (см. voiceLayout.ts).
  const plan = planStreamLayout(
    participants.map((p) => ({ sessionId: p.sessionId, sharing: isSharing(p) })),
  );
  const byId = (sid: string) => participants.find((p) => p.sessionId === sid)!;
  const stripOf = (exclude: string[]) =>
    participants
      .filter((p) => !exclude.includes(p.sessionId))
      .map((p) => renderTile(p))
      .join("");
  let tiles: string;
  if (plan.mode === "single" || plan.mode === "pinned") {
    tiles = `<div class="voice-tiles screen-layout">
        <div class="voice-primary">${renderTile(byId(plan.primary), "primary")}</div>
        <div class="voice-strip-tiles">${stripOf([plan.primary])}</div>
      </div>`;
  } else if (plan.mode === "multi") {
    const rows = Math.ceil(plan.streams.length / plan.columns);
    const rest = stripOf(plan.streams);
    tiles = `<div class="voice-tiles screen-layout multi">
        <div class="voice-stream-grid" style="--stream-cols:${plan.columns};--stream-rows:${rows}">${plan.streams
          .map((sid) => renderTile(byId(sid), "stream"))
          .join("")}</div>
        ${rest ? `<div class="voice-strip-tiles">${rest}</div>` : ""}
      </div>`;
  } else {
    tiles = `<div class="voice-tiles" style="--voice-columns:${Math.max(1, Math.min(participants.length, 3))};--voice-columns-small:${Math.max(1, Math.min(participants.length, 2))}">${participants.map((p) => renderTile(p)).join("")}</div>`;
  }

  const actions = joined
    ? `
      ${renderActiveVoiceAudioControls()}
      ${callIconButton("voice-camera", cameraOn ? "camera-off" : "camera", cameraOn ? t("voice.cam.off") : t("voice.cam.on"), cameraOn ? "active" : "", screenOn, !!cameraOn)}
      ${callIconButton("voice-screen", screenOn ? "screen-off" : "screen", screenOn ? t("voice.screen.stop") : t("voice.screen.start"), screenOn ? "active" : "", false, !!screenOn)}
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
    <div class="voice-room${fullscreenId && participants.some((p) => p.sessionId === fullscreenId) ? " tile-fs" : ""}">
      <button class="voice-fs-exit ghost" data-voice-fs-exit aria-label="Выйти из полного экрана" data-tooltip="Выйти из полного экрана (Esc)">${icon("minimize", { size: 18 })}<span>Выйти</span></button>
      <div class="voice-room-body">
        ${tiles}
        ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
      </div>
      <div class="voice-room-actions">${actions}</div>
    </div>
  `;
}

// Presence changes only touch text, leaving active video elements and streams intact.
export function updateVoicePresence(): void {
  for (const tile of uiContext.rootEl.querySelectorAll<HTMLElement>(".voice-tile[data-voice-user]")) {
    const userId = tile.dataset.voiceUser;
    const placeholder = tile.querySelector<HTMLElement>(".voice-tile-placeholder");
    if (!userId || !placeholder) continue;
    const member = uiContext.state.members.find((m) => m.userId === userId);
    const status = resolveUserPresence(userId, member).customStatus;
    let line = placeholder.querySelector<HTMLElement>(".voice-tile-custom-status");
    if (!status) {
      line?.remove();
      continue;
    }
    if (!line) {
      line = document.createElement("span");
      line.className = "voice-tile-custom-status";
      placeholder.append(line);
    }
    if (line.textContent !== status) line.textContent = status;
  }
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
  const leaving = voice.state === "leaving";
  const status = voice.state === "joining"
    ? t("voice.joining") : voice.state === "media-reconnecting"
      ? t("voice.reconnecting") : leaving ? t("voice.leaving") : t("voice.connected");

  return `
    <div class="voice-strip">
      <button class="voice-strip-header ghost" data-voice-jump="${escapeHtml(voice.channelId)}">
        <span class="voice-strip-status">${icon("channel-voice", { size: 16 })}<span>${escapeHtml(status)}</span></span>
        <span class="voice-strip-channel">${escapeHtml(channelName)}</span>
      </button>
      ${callIconButton("voice-leave", "phone-off", leaving ? t("voice.leaving") : t("voice.leave"), "", leaving)}
    </div>
  `;
}

// После render() цепляем MediaStream'ы в <video data-voice-*> /
// <video data-call-*> элементы. Через innerHTML srcObject не
// сериализуется — нужно ставить программно.
export function attachVoiceVideoStreams(): void {
  const voiceLocal = uiContext.voiceMgr.getLocalStream();
  // I.2: общая громкость вывода и устройство применяются к роутеру звука.
  // Локальные громкости участника (голос и звук демонстрации, по userId)
  // задаются слотами ниже.
  const globalOut = getOutputVolume();
  for (const el of uiContext.rootEl.querySelectorAll<HTMLVideoElement>(
    "video[data-voice-self]",
  )) {
    if (el.srcObject !== voiceLocal) el.srcObject = voiceLocal;
    el.closest(".voice-tile")?.classList.toggle("has-video", !!voiceLocal?.getVideoTracks().some((track) => track.readyState === "live"));
  }
  // <video> удалённого участника показывает только картинку: звук идёт
  // через remoteAudioRouter, иначе он играл бы дважды.
  for (const el of uiContext.rootEl.querySelectorAll<HTMLVideoElement>(
    "video[data-voice-peer]",
  )) {
    const sid = el.dataset.voicePeer;
    if (!sid) continue;
    const stream = uiContext.voiceMgr.getRemoteStream(sid);
    if (el.srcObject !== stream) el.srcObject = stream;
    el.muted = true;
    // Подстраховка аватар-заглушки: сигналинг cameraOn (voice.state) может
    // отстать от реального видеотрека — верим живому стриму.
    el.closest(".voice-tile")?.classList.toggle("has-video", !!stream?.getVideoTracks().some((track) => track.readyState === "live"));
  }
  syncRemoteAudio(globalOut);
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
    el.muted = isDeafened();
    el.volume = Math.min(
      1,
      (uiContext.state.voiceVolumes["call-remote"] ?? 1) * globalOut,
    );
    void applyOutputDevice(el).catch((err) => {
      uiContext.state.status = describeError(err);
      queueRender("status");
    });
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
  installFullscreenController();
  applyFullscreenState();
  const tiles =
    uiContext.rootEl.querySelectorAll<HTMLDivElement>(".voice-tile");
  for (const tile of Array.from(tiles)) {
    if ((tile as HTMLElement & { _fsAttached?: boolean })._fsAttached) continue;
    (tile as HTMLElement & { _fsAttached?: boolean })._fsAttached = true;
    bindEvent(
      tile,
      "dblclick",
      (ev) => {
        // Двойной клик по кнопкам плитки не должен разворачивать её.
        if ((ev.target as HTMLElement).closest("button, select")) return;
        const sid = tile.dataset.voiceTile;
        if (sid) toggleTileFullscreen(sid);
      },
      "bind-217942",
    );
    for (const btn of Array.from(
      tile.querySelectorAll<HTMLButtonElement>("[data-voice-pin]"),
    )) {
      bindEvent(
        btn,
        "click",
        (ev) => {
          ev.stopPropagation();
          const sid = btn.dataset.voicePin;
          if (!sid) return;
          togglePinnedSession(sid);
          render();
        },
        "bind-voice-pin",
      );
    }
    for (const btn of Array.from(
      tile.querySelectorAll<HTMLButtonElement>("[data-voice-fs]"),
    )) {
      bindEvent(
        btn,
        "click",
        (ev) => {
          ev.stopPropagation();
          const sid = btn.dataset.voiceFs;
          if (sid) toggleTileFullscreen(sid);
        },
        "bind-voice-fs",
      );
    }
  }
  for (const btn of Array.from(
    uiContext.rootEl.querySelectorAll<HTMLButtonElement>("[data-voice-fs-exit]"),
  )) {
    bindEvent(
      btn,
      "click",
      () => {
        const sid = getFullscreenSession();
        if (sid) toggleTileFullscreen(sid);
      },
      "bind-voice-fs-exit",
    );
  }
}

// Звук удалённых участников голосового канала: отдельные узлы для голоса и
// для звука демонстрации (см. remoteAudio.ts). Громкости берутся из
// participantVolumes по userId, поэтому переживают пересборку DOM.
function syncRemoteAudio(globalOut: number): void {
  const snapshot = uiContext.state.voiceSnapshot;
  const slots: RemoteAudioSlot[] = [];
  for (const p of snapshot?.participants ?? []) {
    if (snapshot && p.sessionId === snapshot.selfSessionId) continue;
    const tracks = uiContext.voiceMgr.getRemoteAudioTracks(p.sessionId);
    if (tracks.voice) {
      slots.push({
        id: `voice:${p.sessionId}`,
        track: tracks.voice,
        volume: participantVolumes.get(p.userId, "voice"),
      });
    }
    if (tracks.screen) {
      slots.push({
        id: `screen:${p.sessionId}`,
        track: tracks.screen,
        volume: participantVolumes.get(p.userId, "screen"),
      });
    }
  }
  remoteAudioRouter.setOutput({
    volume: globalOut,
    deafened: isDeafened(),
    sinkId: getOutputDeviceId() ?? "",
  });
  remoteAudioRouter.sync(slots);
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
