import { getAppearance } from "../appearance";
import { icon } from "../icons";
import { uiContext } from "../state";
import type { AuditDescription, AuditEntry } from "../types";
import { shortId } from "../util/format";
import { escapeHtml } from "../util/html";
import { dmsByPeer, friendsById, membersById } from "./indexes";
import { isDeafened } from "./loaders";
import { getUserColor, renderAvatar, resolvePeerAvatarMediaId } from "./shell";

// Both the stage and self strip read the same manager snapshot.
export function renderActiveCallAudioControls(): string {
  const snap = uiContext.state.callSnapshot;
  if (!snap || snap.state !== "active") return "";
  const deafened = isDeafened();
  return `
    ${callIconButton("call-mute", snap.muted ? "mic-off" : "mic", snap.muted ? "Включить микрофон" : "Заглушить", snap.muted ? "danger" : "", false, snap.muted)}
    ${callIconButton("call-deafen", deafened ? "headphones-off" : "headphones", deafened ? "Включить звук" : "Заглушить всё", deafened ? "danger" : "", false, deafened)}
  `;
}

export function renderCallOverlay(): string {
  const snap = uiContext.state.callSnapshot;
  if (!snap) return "";
  const peerName = describePeer(snap.peerUserId);
  const avatarHtml = renderAvatar({
    avatarMediaId: resolvePeerAvatarMediaId(snap.peerUserId),
    fallbackText: peerName,
    sizePx: 36,
    className: "call-bar-avatar-pic",
  });
  const duration = snap.startedAt
    ? formatDuration(Date.now() - snap.startedAt)
    : "";

  // Incoming/outgoing/connecting/ended — компактная карточка справа снизу.
  // Active — full-width bar вдоль нижней грани с tiles над ним.
  if (snap.state === "active") {
    return `
      <div class="call-video-overlay" role="dialog">
        <div class="call-video-stack">
          <div class="call-video-tile remote">
            <video data-call-remote="1" autoplay playsinline></video>
          </div>
          <div class="call-video-tile self">
            <video data-call-self="1" autoplay playsinline muted></video>
          </div>
        </div>
      </div>
      <div class="call-bar" role="region" aria-label="активный звонок">
        <div class="call-bar-info">
          ${avatarHtml}
          <div class="call-bar-name">
            <button class="call-bar-title ghost" data-profile-user="${escapeHtml(snap.peerUserId)}">${escapeHtml(peerName)}</button>
            <div class="call-bar-meta">
              <span class="call-bar-timer" id="call-timer">${escapeHtml(duration)}</span>
              ${snap.via ? `<span class="call-via ${snap.via}" data-tooltip="${snap.via === "relay" ? "Медиа идёт через TURN-релей (оба участника за NAT) — возможна чуть большая задержка" : "Прямое p2p-соединение"}">${snap.via === "relay" ? "через релей" : "напрямую"}</span>` : ""}
            </div>
          </div>
        </div>
        <div class="call-bar-actions">
          ${renderActiveCallAudioControls()}
          ${callIconButton("call-camera", snap.cameraOn ? "camera-off" : "camera", snap.cameraOn ? "Выключить камеру" : "Включить камеру", snap.cameraOn ? "active" : "", snap.screenSharing, snap.cameraOn)}
          ${callIconButton("call-screen", snap.screenSharing ? "screen-off" : "screen", snap.screenSharing ? "Прекратить демо" : "Поделиться экраном", snap.screenSharing ? "active" : "", false, snap.screenSharing)}
          ${callIconButton("call-hangup", "phone-off", "Завершить", "hangup")}
        </div>
      </div>
    `;
  }

  let title = "";
  let extra = "";
  let footer = "";
  switch (snap.state) {
    case "incoming":
      title = `Входящий звонок`;
      extra = `от <b>${escapeHtml(peerName)}</b>`;
      footer = `
        <button class="call-accept" id="call-accept">${icon("phone-incoming")} Принять</button>
        <button class="call-reject" id="call-reject">${icon("phone-off")} Отклонить</button>
      `;
      break;
    case "outgoing":
      title = `Звоним…`;
      extra = escapeHtml(peerName);
      footer = `<button class="call-reject" id="call-hangup">${icon("phone-off")} Отменить</button>`;
      break;
    case "connecting":
      title = `Подключение…`;
      extra = escapeHtml(peerName);
      footer = `<button class="call-reject" id="call-hangup">${icon("phone-off")} Завершить</button>`;
      break;
    case "ended":
      title = `Звонок завершён`;
      extra = snap.endedReason ? escapeHtml(snap.endedReason) : "";
      footer = "";
      break;
  }
  return `
    <div class="call-overlay" role="dialog">
      <div class="call-card">
        <div class="call-card-body">
          ${avatarHtml}
          <div>
            <div class="call-status">${escapeHtml(title)}</div>
            <div class="call-card-extra">${extra}</div>
          </div>
        </div>
        ${footer ? `<div class="call-footer">${footer}</div>` : ""}
      </div>
    </div>
  `;
}

export function callIconButton(
  id: string,
  iconName: Parameters<typeof icon>[0],
  title: string,
  mod = "",
  disabled = false,
  pressed?: boolean,
): string {
  const identity = id.startsWith("voice-")
    ? `data-voice-action="${id.slice(6)}"`
    : id === "call-mute" || id === "call-deafen"
      ? `data-call-action="${id.slice(5)}"`
      : `id="${id}"`;
  return `<button ${identity} class="call-icon-btn ${mod}" data-tooltip="${escapeHtml(title)}" aria-label="${escapeHtml(title)}" ${pressed === undefined ? "" : `aria-pressed="${pressed}"`} ${disabled ? "disabled" : ""}>${icon(iconName, { size: 20 })}</button>`;
}

export function describeAuditEntry(e: AuditEntry): AuditDescription {
  const info = uiContext.AUDIT_ACTION_INFO[e.action];
  const actor = e.actorId ? describePeer(e.actorId) : "система";

  let target = "";
  switch (e.targetType) {
    case "user": {
      target = describePeer(e.targetId);
      break;
    }
    case "channel":
    case "channel_member": {
      const ch = uiContext.state.channels.find((c) => c.id === e.targetId);
      target = ch ? `#${ch.name}` : `канал ${shortId(e.targetId)}`;
      break;
    }
    case "workspace": {
      const ws = uiContext.state.workspaces.find((w) => w.id === e.targetId);
      target = ws ? ws.name : `воркспейс ${shortId(e.targetId)}`;
      break;
    }
    case "message":
      target = `сообщение ${shortId(e.targetId)}`;
      break;
    case "invite":
      target = `инвайт ${shortId(e.targetId)}`;
      break;
    case "server_settings":
    case "server":
      target = "";
      break;
    default:
      target = `${e.targetType} ${shortId(e.targetId)}`;
  }

  if (info) {
    return { icon: info.icon, actor, verb: info.ru, target, raw: false };
  }
  return { icon: "•", actor, verb: e.action, target, raw: true };
}

// Wave 7: "#rrggbb,#rrggbb" → пара цветов либо null (битый/пустой формат).
export function parseGradient(
  raw: string | undefined | null,
): [string, string] | null {
  if (!raw) return null;
  const m = /^(#[0-9a-fA-F]{6}),(#[0-9a-fA-F]{6})$/.exec(raw.trim());
  return m ? [m[1], m[2]] : null;
}

// Wave 7 (I.18): inline-style градиентного текста для имени. Пусто если
// градиент не задан.
export function nameGradientStyle(raw: string | undefined | null): string {
  const g = parseGradient(raw);
  if (!g) return "";
  return ` style="background:linear-gradient(90deg,${g[0]},${g[1]});-webkit-background-clip:text;background-clip:text;color:transparent;"`;
}

// Wave 7 (I.19): эмодзи-бейдж после имени, label — в tooltip.
export function badgeHtml(emoji?: string, label?: string): string {
  if (!emoji) return "";
  return `<span class="profile-badge"${label ? ` data-tooltip="${escapeHtml(label)}"` : ""}>${escapeHtml(emoji)}</span>`;
}

// Возвращает inline-style для имени участника: градиент профиля (I.18,
// высший приоритет — это личная кастомизация), иначе role-цвет
// (union-резолвер по всем ролям юзера, см. getUserColor / Wave 5).
// Иначе пустая строка — наследует дефолтный --text.
export function authorColorStyle(userId: string): string {
  if (uiContext.state.me?.id === userId) {
    const selfGradient = nameGradientStyle(uiContext.state.me.nameGradient);
    if (selfGradient) return selfGradient;
  }
  const m = membersById().get(userId);
  if (!m) return "";
  const grad = nameGradientStyle(m.nameGradient);
  if (grad) return grad;
  // I.5: цвета ролей можно выключить в Settings → Внешний вид.
  if (!getAppearance().roleColors) return "";
  const color = getUserColor(userId, m.role);
  return color ? ` style="color:${color};"` : "";
}

// Бейдж участника по userId (для чата/сайдбара).
export function authorBadge(userId: string): string {
  const m = membersById().get(userId);
  return m ? badgeHtml(m.badgeEmoji, m.badgeLabel) : "";
}

export function describePeer(userId: string | null): string {
  if (!userId) return "—";
  // Сам пользователь — в DM author всегда либо я, либо peer; без
  // этой ветки своё имя в DM показывалось бы как uuid (state.members
  // workspace-scoped и в DM-режиме может быть пустым).
  if (uiContext.state.me && userId === uiContext.state.me.id) {
    return (
      uiContext.state.me.displayName ||
      uiContext.state.me.username ||
      userId.slice(0, 8)
    );
  }
  const member = membersById().get(userId);
  if (member) return member.displayName || member.username;
  // DM-peer'ы лежат в state.dms — отдельный источник от workspace-членов.
  const dm = dmsByPeer().get(userId);
  if (dm) return dm.peer.displayName || dm.peer.username;
  // Wave 3: друзья — третий источник (friend-экран вне workspace-контекста).
  const fr = friendsById().get(userId);
  if (fr) return fr.displayName || fr.username;
  return userId.slice(0, 8);
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function syncCallTimer(): void {
  if (uiContext.callTimerInterval) {
    clearInterval(uiContext.callTimerInterval);
    uiContext.callTimerInterval = null;
  }
  const snap = uiContext.state.callSnapshot;
  if (!snap || snap.state !== "active" || !snap.startedAt) return;
  const startedAt = snap.startedAt;
  const tick = () => {
    const el = uiContext.rootEl.querySelector<HTMLElement>("#call-timer");
    if (!el) {
      if (uiContext.callTimerInterval) {
        clearInterval(uiContext.callTimerInterval);
        uiContext.callTimerInterval = null;
      }
      return;
    }
    el.textContent = formatDuration(Date.now() - startedAt);
  };
  tick();
  uiContext.callTimerInterval = setInterval(tick, 1000);
}
