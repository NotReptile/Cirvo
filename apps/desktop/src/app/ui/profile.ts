import { icon } from "../icons";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import { resolveUserPresence, presenceRevision, applyPresenceSnapshot } from "../presence";
import type { ProfileWidget, UserProfileData } from "../types";
import { escapeHtml } from "../util/html";
import { badgeHtml, nameGradientStyle, parseGradient } from "./callView";
import { renderBody } from "./messageView";
import { renderBellButton } from "./channelView";
import { presenceDotClass, presenceLabel, renderAvatar } from "./shell";

// Компактный профиль возле участника, автора сообщения или своей панели.
// Собственный профиль использует me; чужой — свежие данные и presence cache.
export function renderUserProfilePopup(): string {
  const userId = uiContext.state.userProfileTarget;
  if (!userId) return "";
  const member = uiContext.state.members.find((m) => m.userId === userId);
  const dm = uiContext.state.dms.find((d) => d.peer.userId === userId);
  const isSelf = userId === uiContext.state.me?.id;
  // I.6: source-of-truth для расширенных полей — state.userProfileData
  // (тянется лениво при openUserProfile) либо state.me для self.
  const extras = isSelf ? uiContext.state.me : uiContext.state.userProfileData;
  const identity = extras ?? member ?? dm?.peer;
  const name = identity?.displayName || identity?.username || member?.displayName || dm?.peer.displayName || "Пользователь";
  const username = identity?.username || member?.username || dm?.peer.username || "";
  const avatarMediaId = identity?.avatarMediaId;
  const presence = resolveUserPresence(userId, extras ?? member ?? dm?.peer);
  const presenceMode = presence.mode;
  const customStatus = presence.customStatus;
  const role = member?.role;
  const bio = extras?.bio;
  const bannerMediaId = extras?.bannerMediaId;
  const bannerColor = extras?.bannerColor;
  const inCall = uiContext.state.callSnapshot !== null;
  // Wave 7: стиль профиля. member-данные — fallback для self/без-GET кейсов.
  const profileTheme = extras?.profileTheme ?? member?.profileTheme;
  const nameGradient = extras?.nameGradient ?? member?.nameGradient;
  const badgeEmoji = extras?.badgeEmoji ?? member?.badgeEmoji;
  const badgeLabel = extras?.badgeLabel ?? member?.badgeLabel;
  const avatarDecoration = extras?.avatarDecoration ?? member?.avatarDecoration;
  const profileEffect = extras?.profileEffect ?? member?.profileEffect;
  const theme = parseGradient(profileTheme);
  const bannerStyle = bannerMediaId
    ? ""
    : bannerColor
      ? `background: ${escapeHtml(bannerColor)};`
      : theme
        ? `background: linear-gradient(135deg, ${theme[0]}, ${theme[1]});`
        : "";
  const bannerAttrs = bannerMediaId
    ? ` data-banner-media="${escapeHtml(bannerMediaId)}"`
    : "";
  const cardStyle = theme
    ? ` style="background: linear-gradient(180deg, ${theme[0]}22, ${theme[1]}22);"`
    : "";
  // I.16: анимированный оверлей поверх баннера. Известные id → div с
  // CSS-анимацией, прочее игнорим.
  const effectOverlay =
    profileEffect &&
    uiContext.PROFILE_EFFECTS.some((e) => e.id === profileEffect)
      ? `<div class="profile-effect profile-effect-${profileEffect}" aria-hidden="true"></div>`
      : "";
  return `
    <div class="modal-backdrop user-profile-backdrop" data-modal-close>
      <div class="modal user-profile-popup" role="dialog" aria-label="Профиль ${escapeHtml(name)}">
        <div class="user-profile-banner" style="${bannerStyle}"${bannerAttrs}>${effectOverlay}</div>
        <button class="user-profile-close" data-modal-close data-tooltip="Закрыть">✕</button>
        <div class="user-profile-avatar-row">
          <div class="user-profile-avatar-wrap">
            ${renderAvatar({ avatarMediaId, fallbackText: name, sizePx: 80, className: "user-profile-avatar", decoration: avatarDecoration })}
            ${presenceMode ? `<span class="user-profile-dot ${presenceDotClass(presenceMode)}"></span>` : ""}
          </div>
        </div>
        <div class="user-profile-card"${cardStyle}>
          <div class="user-profile-name"><span${nameGradientStyle(nameGradient)}>${escapeHtml(name)}</span>${badgeHtml(badgeEmoji, badgeLabel)}</div>
          ${username ? `<div class="user-profile-username">@${escapeHtml(username)}</div>` : ""}
          ${isSelf ? `<button id="open-status" class="ghost user-profile-presence" aria-haspopup="menu"><span class="presence-dot ${presenceDotClass(presenceMode)}"></span>${presenceLabel(presenceMode)} <span aria-hidden="true">▾</span></button>` : `<div class="user-profile-presence"><span class="presence-dot ${presenceDotClass(presenceMode)}"></span>${presenceLabel(presenceMode)}</div>`}
          ${customStatus ? `<div class="user-profile-status">${escapeHtml(customStatus)}</div>` : ""}
          ${role ? `<div class="user-profile-role"><span class="role-badge role-${escapeHtml(role)}">${escapeHtml(({ owner: "Владелец", admin: "Администратор", moderator: "Модератор", member: "Участник" } as Record<string, string>)[role] ?? role)}</span></div>` : ""}
          ${bio ? `<div class="user-profile-bio">${renderBody(bio)}</div>` : ""}
          ${renderProfileWidgets()}
          ${
            isSelf
              ? `<button class="primary" data-self-profile-edit>${icon("pencil")} Редактировать профиль</button>
                ${uiContext.state.voiceSnapshot?.channelId || uiContext.state.callSnapshot?.state === "active" ? `<div class="user-profile-utilities">${renderBellButton()}${uiContext.state.me?.isRoot ? `<button id="open-admin" class="ghost" aria-label="Админ-панель">${icon("shield")} Админ-панель</button>` : ""}</div>` : ""}`
              : `<div class="user-profile-actions">
                  <button class="primary user-profile-dm" data-user-id="${escapeHtml(userId)}">${icon("reply")} Сообщение</button>
                  ${!inCall ? `<button class="ghost user-profile-call" data-user-id="${escapeHtml(userId)}">${icon("phone")} Позвонить</button>` : ""}
                </div>
                ${renderProfileFriendActions(userId)}
                <div class="user-profile-note">
                  <label for="user-note-input">Заметка (видна только вам)</label>
                  <textarea id="user-note-input" data-note-user="${escapeHtml(userId)}" maxlength="2000" rows="2" placeholder="Например: познакомились на сервере X"></textarea>
                </div>`
          }
        </div>
      </div>
    </div>
  `;
}

// Wave 7 (I.13): иконка виджета-ссылки по домену. Эмодзи вместо SVG —
// тот же «без ассетов» подход, что у звуков и рамок.
export function widgetIcon(rawURL: string): string {
  let host = "";
  try {
    host = new URL(rawURL).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "🔗";
  }
  if (host === "github.com" || host.endsWith(".github.io")) return "🐙";
  if (host === "twitch.tv" || host.endsWith(".twitch.tv")) return "📺";
  if (host.includes("steamcommunity") || host.includes("steampowered"))
    return "🎮";
  if (host === "youtube.com" || host === "youtu.be") return "▶️";
  if (host === "t.me" || host === "telegram.org") return "✈️";
  if (host === "discord.gg" || host === "discord.com") return "👾";
  return "🔗";
}

// Блок виджетов в profile-popup. null = ещё грузится (не показываем),
// пустой массив = виджетов нет.
export function renderProfileWidgets(): string {
  const widgets = uiContext.state.userProfileWidgets;
  if (!widgets || widgets.length === 0) return "";
  return `
    <div class="user-profile-widgets">
      ${widgets
        .map(
          (w) => `
        <a class="profile-widget" href="${escapeHtml(w.url)}" target="_blank" rel="noopener noreferrer nofollow" data-tooltip="${escapeHtml(w.url)}">
          <span class="profile-widget-icon">${widgetIcon(w.url)}</span>
          <span class="profile-widget-label">${escapeHtml(w.label)}</span>
        </a>
      `,
        )
        .join("")}
    </div>
  `;
}

// Wave 3: кнопки дружбы/блока в profile-popup, по текущему статусу пары.
export function renderProfileFriendActions(userId: string): string {
  const rel = uiContext.state.friends.find((f) => f.userId === userId);
  const status = rel?.status;
  const friendBtn =
    status === "accepted"
      ? `<button class="ghost" data-friend-remove-confirm="${userId}">✓ В друзьях</button>`
      : status === "pending_out"
        ? `<button class="ghost" data-friend-remove="${userId}">Заявка отправлена ✕</button>`
        : status === "pending_in"
          ? `<button class="primary" data-friend-accept="${userId}">Принять заявку</button>`
          : status === "blocked"
            ? ""
            : `<button class="ghost" data-friend-add="${userId}">Добавить в друзья</button>`;
  const blockBtn =
    status === "blocked"
      ? `<button class="ghost" data-friend-unblock="${userId}">Разблокировать</button>`
      : `<button class="ghost danger" data-friend-block="${userId}">Заблокировать</button>`;
  return `<div class="user-profile-actions user-profile-friend-actions">${friendBtn}${blockBtn}</div>`;
}

let profileRequest = 0;
let profileOpener: HTMLElement | null = null;
let profileOpenerSelector: string | null = null;
let profileWasOpen = false;

function currentProfileOpener(): HTMLElement | null {
  if (profileOpener?.isConnected) return profileOpener;
  return profileOpenerSelector ? uiContext.rootEl.querySelector<HTMLElement>(profileOpenerSelector) : null;
}

export function polishProfilePopover(): void {
  const popup = uiContext.rootEl.querySelector<HTMLElement>(".user-profile-popup");
  if (!popup) {
    if (profileWasOpen && uiContext.state.modal === null) currentProfileOpener()?.focus({ preventScroll: true });
    profileWasOpen = false;
    return;
  }
  profileWasOpen = true;
  const opener = currentProfileOpener();
  const anchor = opener ? opener.getBoundingClientRect() : uiContext.state.userProfileAnchor;
  const rect = popup.getBoundingClientRect();
  const margin = 8;
  let x = (window.innerWidth - rect.width) / 2;
  let y = (window.innerHeight - rect.height) / 2;
  if (anchor) {
    x = anchor.x + anchor.width + margin;
    if (x + rect.width > window.innerWidth - margin) x = anchor.x - rect.width - margin;
    if (x < margin) x = anchor.x;
    y = anchor.y;
    if (y + rect.height > window.innerHeight - margin) y = anchor.y - rect.height - margin;
  }
  popup.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin))}px`;
  popup.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))}px`;
  if (!popup.dataset.focusInitialized) {
    popup.dataset.focusInitialized = "true";
    popup.querySelector<HTMLElement>(".user-profile-close")?.focus();
  }
}

window.addEventListener("resize", polishProfilePopover);

export function openUserProfile(userId: string, anchor?: HTMLElement): void {
  const request = ++profileRequest;
  const current = () => request === profileRequest && uiContext.state.modal === "userProfile" && uiContext.state.userProfileTarget === userId;
  profileOpener = anchor ?? null;
  profileOpenerSelector = null;
  if (anchor?.id) profileOpenerSelector = `#${CSS.escape(anchor.id)}`;
  else if (anchor?.dataset.memberUser) profileOpenerSelector = `[data-member-user="${CSS.escape(anchor.dataset.memberUser)}"]`;
  else if (anchor?.dataset.friendProfile) profileOpenerSelector = `[data-friend-profile="${CSS.escape(anchor.dataset.friendProfile)}"]`;
  else if (anchor?.dataset.profileUser) {
    const message = anchor.closest<HTMLElement>(".message[data-id]");
    const tile = anchor.closest<HTMLElement>("[data-voice-tile]");
    const parent = message ? `.message[data-id="${CSS.escape(message.dataset.id!)}"] ` : tile ? `[data-voice-tile="${CSS.escape(tile.dataset.voiceTile!)}"] ` : "";
    const kind = anchor.classList.contains("profile-name-button") ? ".profile-name-button" : anchor.classList.contains("profile-avatar-button") ? ".profile-avatar-button" : "";
    profileOpenerSelector = `${parent}[data-profile-user="${CSS.escape(anchor.dataset.profileUser)}"]${kind}`;
  }
  if (profileOpener) profileOpener.focus();
  const rect = anchor?.getBoundingClientRect();
  uiContext.state.userProfileAnchor = rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  uiContext.state.userProfileTarget = userId;
  uiContext.state.userProfileData = null;
  uiContext.state.userProfileWidgets = null;
  uiContext.state.modal = "userProfile";
  // Wave 7 (I.13): виджеты грузим для любого профиля, включая свой.
  void (async () => {
    try {
      const data = await uiContext.httpClient.get<{ items: ProfileWidget[] }>(
        `/api/v1/users/${userId}/widgets`,
      );
      if (current()) {
        uiContext.state.userProfileWidgets = data.items ?? [];
        render();
      }
    } catch {
      /* нет виджетов / сеть — блок просто не покажется */
    }
  })();
  // I.6(c): если юзер уже в state.members и у нас есть extended-поля
  // (bio/banner) — используем их сразу, popup открывается мгновенно.
  // GET всё равно дёргаем — данные могли устареть; но первичный рендер
  // не пустой.
  const cached = uiContext.state.members.find((m) => m.userId === userId);
  if (
    cached &&
    (cached.bio !== undefined ||
      cached.bannerColor !== undefined ||
      cached.bannerMediaId !== undefined)
  ) {
    uiContext.state.userProfileData = {
      id: cached.userId,
      username: cached.username,
      displayName: cached.displayName,
      avatarMediaId: cached.avatarMediaId,
      bio: cached.bio,
      bannerColor: cached.bannerColor,
      bannerMediaId: cached.bannerMediaId,
      presenceMode: cached.presenceMode,
      customStatus: cached.customStatus,
      profileTheme: cached.profileTheme,
      nameGradient: cached.nameGradient,
      badgeEmoji: cached.badgeEmoji,
      badgeLabel: cached.badgeLabel,
      avatarDecoration: cached.avatarDecoration,
      profileEffect: cached.profileEffect,
    } as UserProfileData;
  }
  render();
  if (userId !== uiContext.state.me?.id) {
    const started = presenceRevision();
    void (async () => {
      try {
        const data = await uiContext.httpClient.get<UserProfileData>(
          `/api/v1/users/${userId}`,
        );
        if (current()) {
          uiContext.state.userProfileData = applyPresenceSnapshot(userId, data, started);
          render();
        }
      } catch {
        /* 404/network — оставляем что было из кеша */
      }
    })();
  }
}

// H.10: модалка настроек воркспейса. Табы:
//   - Обзор: name (PATCH), slug (readonly), иконка (PUT/DELETE /avatar)
//   - Welcome: select text-канала (PUT /welcome-channel)
//   - Роли: shortcut к существующей workspaceRoles-модалке
//   - Удалить: danger-zone, только owner; typed-confirm + DELETE
export function openWorkspaceSettings(workspaceId: string): void {
  const ws = uiContext.state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  uiContext.state.workspaceSettings = {
    workspaceId,
    tab: "overview",
    draftName: ws.name,
    saving: false,
    error: null,
    deleteTyped: "",
    welcomeSaving: false,
  };
  uiContext.state.modal = "workspaceSettings";
  render();
}
