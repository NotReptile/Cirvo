import { promptDialog } from "../dialogs";
import { describeError } from "../errors";
import { t } from "../i18n";
import { icon } from "../icons";
import {
  INVITE_TTL_OPTIONS,
  inviteExpiryLabel,
  isInviteExpired,
} from "../invites";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type {
  Channel,
  ChannelCategory,
  DMItem,
  FriendsTab,
  Invite,
  Workspace,
} from "../types";
import { formatTimeSmart } from "../util/format";
import { escapeHtml } from "../util/html";
import { slowModeRemainingSec } from "./composer";
import { loadDraft } from "./helpers";
import { isChannelMuted, renderPinsPopup } from "./loaders";
import { renderMessagesWithDivider } from "./messageList";
import {
  renderJumpToUnread,
  renderPendingUploads,
  renderReplyBar,
} from "./messageView";
import { presenceDotClass, renderAvatar } from "./shell";
import { renderVoiceChannelView } from "./voiceView";

export function renderEmpty(): string {
  if (uiContext.state.workspaces.length === 0) {
    return `
      <div class="empty">
        <p>У вас пока нет воркспейсов.</p>
        <p>Создайте новый слева или присоединитесь по коду инвайта.</p>
      </div>
    `;
  }
  return `<div class="empty"><p>Выберите канал</p></div>`;
}

// J.5: рендер sidebar'а каналов. Каналы группируются по `categoryId`;
// orphans (NULL category_id) идут в специальном блоке «Без категории» сверху,
// если они есть. Заголовок ws-уровневой «+» создаёт новую категорию.
export function renderChannelsBlock(): string {
  const ws = uiContext.state.workspaces.find(
    (w) => w.id === uiContext.state.selectedWorkspaceId,
  );
  const canManage = !!ws && ["owner", "admin"].includes(ws.role ?? "");
  const categories = [...uiContext.state.categories].sort(
    (a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt),
  );
  const channelsByCat = new Map<string | null, Channel[]>();
  // Wave 8: архивные каналы не участвуют в категориях — копятся в отдельный
  // сворачиваемый блок внизу sidebar'а.
  const archived: Channel[] = [];
  for (const ch of uiContext.state.channels) {
    // Wave 9: треды (посты форума) в sidebar не показываются — до них
    // добираются через форум-вью родительского канала.
    if (ch.kind === "thread") continue;
    if (ch.archivedAt) {
      archived.push(ch);
      continue;
    }
    const key = ch.categoryId ?? null;
    const list = channelsByCat.get(key) ?? [];
    list.push(ch);
    channelsByCat.set(key, list);
  }
  for (const list of channelsByCat.values()) {
    list.sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name),
    );
  }
  const orphanChannels = channelsByCat.get(null) ?? [];
  const orphanBlock =
    orphanChannels.length > 0
      ? renderChannelCategory(null, "Без категории", orphanChannels, canManage)
      : "";
  const catBlocks = categories
    .map((cat) =>
      renderChannelCategory(
        cat,
        cat.name,
        channelsByCat.get(cat.id) ?? [],
        canManage,
      ),
    )
    .join("");
  // J.5: «+ Категория» и «+ Канал»-orphan переехали в workspace-dropdown
  // под заголовком ch-panel — sidebar остаётся чистым.
  return `
    ${orphanBlock}
    ${catBlocks}
    ${renderArchivedBlock(archived, canManage)}
  `;
}

export function isArchiveCollapsed(): boolean {
  try {
    return localStorage.getItem(uiContext.ARCHIVE_COLLAPSED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function renderArchivedBlock(
  archived: Channel[],
  canManage: boolean,
): string {
  if (archived.length === 0) return "";
  archived.sort(
    (a, b) => a.position - b.position || a.name.localeCompare(b.name),
  );
  const collapsed = isArchiveCollapsed();
  const visible = collapsed
    ? archived.filter((c) => c.id === uiContext.state.selectedChannelId)
    : archived;
  const items = visible
    .map((ch) => {
      const cls = ch.id === uiContext.state.selectedChannelId ? "active" : "";
      const actions = canManage
        ? `<span class="channel-item-actions">
             <button class="ghost channel-item-settings" data-ch-settings="${ch.id}" data-tooltip="Настройки канала" aria-label="Настройки канала">${icon("settings")}</button>
           </span>`
        : "";
      return `
        <li class="${cls} archived" data-ch="${ch.id}">
          <span class="channel-prefix">${channelPrefix(ch)}</span>
          <span class="channel-name"${ch.nameColor ? ` style="color:${escapeHtml(ch.nameColor)}"` : ""}>${escapeHtml(ch.name)}</span>
          ${actions}
        </li>
      `;
    })
    .join("");
  return `
    <div class="section-title ch-category-title ${collapsed ? "collapsed" : ""}">
      <button class="ch-category-toggle" data-archive-collapse>
        <span class="ch-category-label">${t("sidebar.archive")} · ${archived.length}</span>
        <span class="ch-category-glyph">${collapsed ? "▸" : "▾"}</span>
      </button>
    </div>
    <ul class="channel-list channel-list-archived">${items}</ul>
  `;
}

export function renderChannelCategory(
  category: ChannelCategory | null,
  title: string,
  channels: Channel[],
  canManage: boolean,
): string {
  // J.6: свёрнутая категория показывает только заголовок + активный канал
  // (чтобы юзера не выкинуло из контекста).
  const catId = category?.id ?? null;
  const isCollapsed =
    catId !== null && uiContext.state.collapsedCategories.has(catId);
  const visibleChannels = isCollapsed
    ? channels.filter((c) => c.id === uiContext.state.selectedChannelId)
    : channels;
  // Для orphan-блока «+ канал» создаёт без категории; для категории — внутри неё.
  const createDataAttr = category
    ? `data-create-in-category="${escapeHtml(category.id)}"`
    : `data-create-orphan="1"`;
  const addBtn = canManage
    ? `<button class="ghost ch-category-add" ${createDataAttr} data-tooltip="Создать канал" aria-label="Создать канал">${icon("plus")}</button>`
    : "";
  // ⚙ для управления самой категорией (rename/delete) — только для реальных
  // (не orphan) категорий и canManage.
  const settingsBtn =
    canManage && category
      ? `<button class="ghost ch-category-settings" data-category-id="${escapeHtml(category.id)}" data-tooltip="Управление категорией" aria-label="Управление категорией">${icon("settings")}</button>`
      : "";
  const collapseAttr = category
    ? `data-category-collapse="${escapeHtml(category.id)}"`
    : "";
  const collapseGlyph = category ? (isCollapsed ? "▸" : "▾") : "";
  const items = visibleChannels
    .map((ch) => {
      const unread = uiContext.state.unread[ch.id] ?? 0;
      const muted = isChannelMuted(ch.id);
      const cls = [
        ch.id === uiContext.state.selectedChannelId ? "active" : "",
        unread > 0 ? "has-unread" : "",
        muted ? "muted" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const badge =
        unread > 0
          ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>`
          : "";
      const inlineList =
        ch.kind === "voice" ? renderVoiceInlineParticipants(ch.id) : "";
      const actions = canManage
        ? `<span class="channel-item-actions">
             <button class="ghost channel-item-settings" data-ch-settings="${ch.id}" data-tooltip="Настройки канала" aria-label="Настройки канала">${icon("settings")}</button>
           </span>`
        : "";
      return `
        <li class="${cls}" data-ch="${ch.id}" data-cat-id="${escapeHtml(catId ?? "")}"${canManage ? ' draggable="true"' : ""}>
          <span class="channel-prefix">${channelPrefix(ch)}</span>
          <span class="channel-name"${ch.nameColor ? ` style="color:${escapeHtml(ch.nameColor)}"` : ""}>${escapeHtml(ch.name)}</span>
          ${badge}
          ${actions}
        </li>
        ${inlineList}
      `;
    })
    .join("");
  // Заголовок: для категорий — кликабельный (toggle collapse), для orphan — статичный.
  // Glyph справа от названия (Discord-pattern), label прижат к левому краю и
  // обрезается ellipsis'ом если не влезает в одну строку.
  const titleEl = category
    ? `<button class="ch-category-toggle" ${collapseAttr}>
         <span class="ch-category-label">${escapeHtml(title)}</span>
         <span class="ch-category-glyph">${collapseGlyph}</span>
       </button>`
    : `<span class="ch-category-label">${escapeHtml(title)}</span>`;
  // J.5(a): категория drag-reorder. Только реальные категории (не orphan).
  const dragAttrs =
    category && canManage
      ? ` draggable="true" data-cat-drag="${escapeHtml(category.id)}"`
      : "";
  return `
    <div class="section-title ch-category-title ${isCollapsed ? "collapsed" : ""}"${dragAttrs}>
      ${titleEl}
      <span class="ch-category-actions">
        ${addBtn}
        ${settingsBtn}
      </span>
    </div>
    <ul class="channel-list">${items}</ul>
  `;
}

// Discord-style: участники voice-канала видны прямо в sidebar под названием.
// Источник: voiceSnapshot (если ты в этом канале) либо voicePeek (если канал
// выбран как «просмотр»). Для остальных каналов не показываем — для этого
// нужен периодический polling /voice/participants, отложено.
export function renderVoiceInlineParticipants(channelId: string): string {
  const voice = uiContext.state.voiceSnapshot;
  type P = {
    sessionId: string;
    userId: string;
    username?: string;
    displayName?: string;
    screenSharing?: boolean;
  };
  let participants: P[] = [];
  let selfSessionId: string | null = null;
  if (voice && voice.channelId === channelId) {
    participants = voice.participants;
    selfSessionId = voice.selfSessionId;
  } else if (uiContext.state.voicePeekAll[channelId]?.length) {
    participants = uiContext.state.voicePeekAll[channelId];
  } else if (uiContext.state.voicePeek?.channelId === channelId) {
    participants = uiContext.state.voicePeek.participants;
  }
  if (participants.length === 0) return "";
  const items = participants
    .map((p) => {
      const member = uiContext.state.members.find((m) => m.userId === p.userId);
      const avatarMediaId =
        p.userId === uiContext.state.me?.id
          ? uiContext.state.me?.avatarMediaId
          : member?.avatarMediaId;
      const name =
        p.displayName?.trim() ||
        p.username ||
        member?.displayName ||
        member?.username ||
        p.userId.slice(0, 8);
      const isSelf = selfSessionId !== null && p.sessionId === selfSessionId;
      const live = !!p.screenSharing || (isSelf && !!voice?.screenSharing);
      return `
        <li class="voice-inline-participant${isSelf ? " self" : ""}" data-voice-jump-user="${escapeHtml(p.userId)}">
          ${renderAvatar({ avatarMediaId, fallbackText: name, sizePx: 24 })}
          <span class="voice-inline-name">${escapeHtml(name)}</span>
          ${live ? `<span class="voice-inline-live">${t("voice.live")}</span>` : ""}
        </li>
      `;
    })
    .join("");
  return `<ul class="voice-inline-list">${items}</ul>`;
}

// G.8: список DM в ch-panel-body (заменяет renderChannelsBlock в dm-mode).
export function renderDMSidebarList(): string {
  if (uiContext.state.dmsLoading && uiContext.state.dms.length === 0) {
    return `<div class="ch-panel-empty">Загрузка…</div>`;
  }
  const items = [...uiContext.state.dms]
    .sort((a, b) => {
      const at = a.lastMessageAt ?? a.createdAt;
      const bt = b.lastMessageAt ?? b.createdAt;
      return bt.localeCompare(at);
    })
    .map((d) => {
      const active =
        d.channelId === uiContext.state.selectedChannelId ? " active" : "";
      const unread = d.unreadCount > 0 ? ` has-unread` : "";
      const muted = isChannelMuted(d.channelId) ? " muted" : "";
      const name = d.peer.displayName || d.peer.username;
      const badge =
        d.unreadCount > 0
          ? `<span class="unread-badge">${d.unreadCount > 99 ? "99+" : d.unreadCount}</span>`
          : "";
      const effMode =
        d.peer.presenceMode ?? (d.peer.online ? "online" : "offline");
      return `
        <li class="dm-item${active}${unread}${muted}" data-dm="${escapeHtml(d.channelId)}">
          <span class="dm-item-avatar">
            ${renderAvatar({
              avatarMediaId: d.peer.avatarMediaId,
              fallbackText: name,
              sizePx: 28,
            })}
            <span class="presence-dot ${presenceDotClass(effMode)}"></span>
          </span>
          <span class="dm-item-body">
            <span class="dm-item-name">${escapeHtml(name)}</span>
            ${d.peer.customStatus ? `<span class="dm-item-sub">${escapeHtml(d.peer.customStatus)}</span>` : ""}
          </span>
          ${badge}
          <button class="ghost dm-item-close" data-dm-close="${escapeHtml(d.channelId)}" data-tooltip="Скрыть из списка" aria-label="Скрыть">${icon("x", { size: 14 })}</button>
        </li>
      `;
    })
    .join("");
  return `
    <div class="section-title dm-list-title">
      <span>Прямые сообщения</span>
      <button id="dm-find-btn" class="ghost ch-category-add" data-tooltip="Найти или начать беседу" aria-label="Найти">${icon("plus")}</button>
    </div>
    ${
      uiContext.state.dms.length === 0
        ? `<div class="ch-panel-empty">Пока нет личных бесед. Нажми <strong>+</strong> или открой DM из профиля участника.</div>`
        : `<ul class="dm-list">${items}</ul>`
    }
  `;
}

// G.8: home-экран DM (когда в dm-mode, но никакой DM не выбран).
// Поле поиска по username + список DM в виде крупных карточек.
// Wave 3: секция «Друзья» в DM-home. Табы Все/В сети/Ожидание/Заблокированные,
// форма добавления по username, действия per-row.
export function renderFriendsSection(): string {
  const tab = uiContext.state.friendsTab;
  const accepted = uiContext.state.friends.filter(
    (f) => f.status === "accepted",
  );
  const pending = uiContext.state.friends.filter(
    (f) => f.status === "pending_in" || f.status === "pending_out",
  );
  const pendingIn = uiContext.state.friends.filter(
    (f) => f.status === "pending_in",
  );
  const blocked = uiContext.state.friends.filter((f) => f.status === "blocked");
  const list =
    tab === "all"
      ? accepted
      : tab === "online"
        ? accepted.filter((f) => f.online)
        : tab === "pending"
          ? pending
          : blocked;

  const tabBtn = (id: FriendsTab, label: string, count?: number) => `
    <button class="friends-tab${tab === id ? " active" : ""}" data-friends-tab="${id}">
      ${label}${count ? ` <span class="friends-tab-badge">${count}</span>` : ""}
    </button>`;

  const rows =
    list.length === 0
      ? `<div class="friends-empty">${
          tab === "pending"
            ? t("friends.empty.pending")
            : tab === "blocked"
              ? t("friends.empty.blocked")
              : tab === "online"
                ? t("friends.empty.online")
                : t("friends.empty.all")
        }</div>`
      : `<ul class="friends-list">${list
          .map((f) => {
            const name = f.displayName || f.username;
            const effMode = f.presenceMode ?? (f.online ? "online" : "offline");
            const sub =
              f.status === "pending_in"
                ? t("friends.sub.pending_in")
                : f.status === "pending_out"
                  ? t("friends.sub.pending_out")
                  : f.status === "blocked"
                    ? t("friends.sub.blocked")
                    : f.customStatus || "@" + f.username;
            const actions =
              f.status === "pending_in"
                ? `<button class="friends-act ok" data-friend-accept="${f.userId}" data-tooltip="${t("friends.accept")}">✓</button>
               <button class="friends-act danger" data-friend-remove="${f.userId}" data-tooltip="${t("friends.decline")}">✕</button>`
                : f.status === "pending_out"
                  ? `<button class="friends-act danger" data-friend-remove="${f.userId}" data-tooltip="${t("friends.cancel_request")}">✕</button>`
                  : f.status === "blocked"
                    ? `<button class="friends-act" data-friend-unblock="${f.userId}">${t("friends.unblock")}</button>`
                    : `<button class="friends-act" data-friend-msg="${f.userId}" data-tooltip="${t("friends.message")}">${icon("reply", { size: 16 })}</button>
                   <button class="friends-act danger" data-friend-remove-confirm="${f.userId}" data-tooltip="${t("friends.remove")}">✕</button>`;
            return `
          <li class="friends-row" data-friend-profile="${f.userId}">
            <span class="dm-home-avatar">
              ${renderAvatar({ avatarMediaId: f.avatarMediaId, fallbackText: name, sizePx: 36 })}
              ${f.status === "blocked" ? "" : `<span class="presence-dot ${presenceDotClass(effMode)}"></span>`}
            </span>
            <span class="friends-row-body">
              <span class="friends-row-name">${escapeHtml(name)}</span>
              <span class="friends-row-sub">${escapeHtml(sub)}</span>
            </span>
            <span class="friends-row-actions">${actions}</span>
          </li>`;
          })
          .join("")}</ul>`;

  return `
    <section class="friends-section">
      <form id="friend-add-form" class="dm-home-find">
        <input id="friend-add-input" name="username" placeholder="${t("friends.add_placeholder")}" autocomplete="off" maxlength="64" />
        <button type="submit">${t("friends.send_request")}</button>
      </form>
      ${uiContext.state.friendAddError ? `<div class="dm-home-error">${escapeHtml(uiContext.state.friendAddError)}</div>` : ""}
      ${uiContext.state.friendAddOk ? `<div class="friends-ok">${escapeHtml(uiContext.state.friendAddOk)}</div>` : ""}
      <div class="friends-tabs">
        ${tabBtn("all", t("friends.tab.all"))}
        ${tabBtn("online", t("members.online"))}
        ${tabBtn("pending", t("friends.tab.pending"), pendingIn.length)}
        ${tabBtn("blocked", t("friends.tab.blocked"))}
      </div>
      ${uiContext.state.friendsLoading && uiContext.state.friends.length === 0 ? `<div class="friends-empty">${t("common.loading")}</div>` : rows}
    </section>
  `;
}

export function renderDMHome(): string {
  const errBlock = uiContext.state.dmFindError
    ? `<div class="dm-home-error">${escapeHtml(uiContext.state.dmFindError)}</div>`
    : "";
  const sorted = [...uiContext.state.dms].sort((a, b) => {
    const at = a.lastMessageAt ?? a.createdAt;
    const bt = b.lastMessageAt ?? b.createdAt;
    return bt.localeCompare(at);
  });
  const cards =
    sorted.length === 0
      ? `<div class="dm-home-empty">${t("dm.home.empty")}</div>`
      : `<ul class="dm-home-list">
        ${sorted
          .map((d) => {
            const name = d.peer.displayName || d.peer.username;
            const effMode =
              d.peer.presenceMode ?? (d.peer.online ? "online" : "offline");
            return `
            <li class="dm-home-card" data-dm="${escapeHtml(d.channelId)}">
              <span class="dm-home-avatar">
                ${renderAvatar({ avatarMediaId: d.peer.avatarMediaId, fallbackText: name, sizePx: 48 })}
                <span class="presence-dot ${presenceDotClass(effMode)}"></span>
              </span>
              <span class="dm-home-card-body">
                <span class="dm-home-card-name">${escapeHtml(name)}</span>
                <span class="dm-home-card-sub">${d.peer.customStatus ? escapeHtml(d.peer.customStatus) : "@" + escapeHtml(d.peer.username)}</span>
              </span>
              ${d.unreadCount > 0 ? `<span class="unread-badge">${d.unreadCount > 99 ? "99+" : d.unreadCount}</span>` : ""}
            </li>
          `;
          })
          .join("")}
      </ul>`;
  return `
    <div class="dm-home">
      <header class="dm-home-header">
        <h2>${t("dm.home.title")}</h2>
        <form id="dm-find-form" class="dm-home-find">
          <input id="dm-find-input"
                 name="query"
                 placeholder="${t("dm.home.find_placeholder")}"
                 autocomplete="off"
                 maxlength="64"
                 value="${escapeHtml(uiContext.state.dmFindQuery)}" />
          <button type="submit" ${uiContext.state.dmOpening ? "disabled" : ""}>${uiContext.state.dmOpening ? "…" : t("dm.home.open")}</button>
        </form>
        ${errBlock}
      </header>
      ${renderFriendsSection()}
      <h3 class="dm-home-subtitle">${t("dm.home.conversations")}</h3>
      ${cards}
    </div>
  `;
}

// G.8: рендер DM-канала. Использует ту же машинерию (message-list +
// composer + reply-bar + mention-popup), что и обычный text-канал, но с
// собственным header'ом (peer avatar + name + online-dot, без settings).
// canSend всегда true — DM-канал всегда принимает сообщения.
export function renderDMChannelView(dm: DMItem): string {
  const name = dm.peer.displayName || dm.peer.username;
  const effMode =
    dm.peer.presenceMode ?? (dm.peer.online ? "online" : "offline");
  const sub = dm.peer.customStatus || "@" + dm.peer.username;
  return `
    <header class="channel-header dm-channel-header">
      <div class="dm-header-info">
        <span class="dm-header-avatar">
          ${renderAvatar({ avatarMediaId: dm.peer.avatarMediaId, fallbackText: name, sizePx: 36 })}
          <span class="presence-dot ${presenceDotClass(effMode)}"></span>
        </span>
        <div>
          <h2>${escapeHtml(name)}</h2>
          <div class="topic">${escapeHtml(sub)}</div>
        </div>
      </div>
      <div class="channel-header-actions">
        <button id="dm-call" class="ghost" data-user-id="${escapeHtml(dm.peer.userId)}" data-tooltip="${t("menu.call")}" aria-label="${t("menu.call")}">${icon("phone")}</button>
        <button id="open-pins" class="ghost${uiContext.state.pinsPopupOpen ? " active" : ""}" data-tooltip="${t("header.pins")}" aria-label="${t("header.pins")}">${icon("pin")}</button>
      </div>
      <div id="region-pins">${uiContext.state.pinsPopupOpen && uiContext.state.channelPinsChannelId === dm.channelId ? renderPinsPopup() : ""}</div>
    </header>
    <div id="drop-zone" class="drop-zone" hidden>
      <div class="drop-zone-inner">${t("chat.dropzone")}</div>
    </div>
    <div id="sticky-date" class="sticky-date" hidden></div>
    <div id="message-list" class="message-list">
      ${renderMessagesWithDivider()}
    </div>
    ${renderJumpToUnread()}
    ${uiContext.state.pendingUploads.length > 0 ? renderPendingUploads() : ""}
    ${renderReplyBar()}
    <div id="mention-popup" class="mention-popup" hidden></div>
    <div id="slash-popup" class="mention-popup" hidden></div>
    <div id="typing-line" class="typing-line"></div>
    <form id="send-form" class="send-form">
      <label class="attach-btn" data-tooltip="${t("chat.composer.attach", { max: uiContext.MAX_ATTACHMENTS })}">
        ${icon("paperclip")}
        <input type="file" id="attach-input" multiple hidden />
      </label>
      <input
        name="body"
        autocomplete="off"
        placeholder="${t("dm.composer.message_for", { name: escapeHtml(name) })}"
        value="${escapeHtml(loadDraft(dm.channelId))}"
      />
      <button type="button" id="composer-emoji" class="composer-emoji-btn" data-tooltip="${t("chat.composer.emoji")}">${icon("smile")}</button>
      <button type="submit">${uiContext.state.uploadInFlight ? "…" : "↑"}</button>
    </form>
  `;
}

// K.7: единый стиль иконок каналов. Возвращает безопасный HTML с SVG —
// `currentColor`, контролируется через `.channel-prefix` в CSS. Приватный
// канал перебивает kind — поверх base-иконки (text/voice) накладываем
// маленький lock-overlay, чтобы юзер видел и тип канала, и его приватность
// (раньше lock полностью замещал kind — путало). DM-каналы рендерятся
// отдельным компонентом, channelPrefix к ним не применяется.
export function channelPrefix(ch: Channel): string {
  const base =
    ch.kind === "voice"
      ? icon("channel-voice", { size: 16, className: "channel-icon" })
      : ch.kind === "forum"
        ? icon("channel-forum", { size: 16, className: "channel-icon" })
        : icon("channel-text", { size: 16, className: "channel-icon" });
  if (!ch.isPrivate) return base;
  // Lock-overlay 10x10 поверх правого нижнего угла base-иконки.
  return `<span class="channel-icon-stack">${base}<span class="channel-icon-lock">${icon("lock", { size: 10 })}</span></span>`;
}

export function renderBellButton(): string {
  const count = uiContext.state.notificationsUnread;
  const badge =
    count > 0
      ? `<span class="bell-badge">${count > 99 ? "99+" : count}</span>`
      : "";
  return `<button id="open-notifications" class="ghost bell-btn" data-tooltip="${t("modal.notifications")}" aria-label="${t("modal.notifications")}">${icon("bell")}${badge}</button>`;
}

// J.5: dropdown под ch-panel-header'ом. Discord-style меню для управления
// воркспейсом — Пригласить (открывает invites-модалку), Настройки сервера,
// Создать канал, Создать категорию. Все эти действия раньше лежали
// раздельно в sidebar; теперь сгруппированы по верхнему правому глифу.
export async function createCategoryFlow(wsId: string): Promise<void> {
  const raw = await promptDialog({
    title: "Новая категория",
    label: "Название",
    placeholder: "Игры, Музыка, ...",
  });
  const name = raw?.trim();
  if (!name) return;
  try {
    const cat = await uiContext.httpClient.post<ChannelCategory>(
      `/api/v1/workspaces/${wsId}/categories`,
      { name },
    );
    uiContext.state.categories = [...uiContext.state.categories, cat];
    render();
  } catch (err) {
    uiContext.state.status = describeError(err);
    render();
  }
}

export function renderWorkspaceHeaderMenu(
  ws: Workspace,
  canManage: boolean,
): string {
  const isOwnerOrAdmin = ["owner", "admin"].includes(ws.role ?? "");
  return `
    <div class="ws-menu" role="menu">
      ${canManage ? `<button class="ws-menu-item" data-ws-menu="invite">${icon("plus", { size: 14 })}<span>Пригласить</span></button>` : ""}
      ${isOwnerOrAdmin ? `<button class="ws-menu-item" data-ws-menu="settings">${icon("settings", { size: 14 })}<span>Настройки сервера</span></button>` : ""}
      ${canManage ? `<button class="ws-menu-item" data-ws-menu="create-channel">${icon("channel-text", { size: 14 })}<span>Создать канал</span></button>` : ""}
      ${canManage ? `<button class="ws-menu-item" data-ws-menu="create-category">${icon("plus", { size: 14 })}<span>Создать категорию</span></button>` : ""}
    </div>
  `;
}

export function renderInviteRow(i: Invite): string {
  const expiry = inviteExpiryLabel(i.expiresAt);
  return `
    <li data-invite="${i.id}"${isInviteExpired(i.expiresAt) ? ` class="invite-expired"` : ""}>
      <code class="invite-code">${escapeHtml(i.code)}</code>
      <span class="invite-meta">${i.usedCount}/${i.maxUses === 0 ? "∞" : i.maxUses}${expiry ? ` · ${escapeHtml(expiry)}` : ""}</span>
      <button class="ghost invite-copy" data-code="${escapeHtml(i.code)}" data-tooltip="Копировать код">⧉</button>
      <button class="ghost invite-revoke" data-invite="${i.id}" data-tooltip="Отозвать">✕</button>
    </li>
  `;
}

export function renderInviteTtlSelect(): string {
  return `<select name="ttl" aria-label="Срок действия">${INVITE_TTL_OPTIONS.map(
    (o) => `<option value="${o.value}">${o.label}</option>`,
  ).join("")}</select>`;
}

export function renderInvitesModal(): string {
  const ws = uiContext.state.workspaces.find(
    (w) => w.id === uiContext.state.selectedWorkspaceId,
  );
  // Отозванные не показываем, поэтому пустоту проверяем уже после фильтра:
  // иначе при одних отозванных инвайтах получался пустой список без подписи.
  const activeInvites = uiContext.state.invites.filter((i) => !i.revokedAt);
  const list = uiContext.state.invitesLoading
    ? `<div class="invites-empty">Загрузка…</div>`
    : activeInvites.length === 0
      ? `<div class="invites-empty">Активных инвайтов нет</div>`
      : `<ul class="invite-list">${activeInvites.map(renderInviteRow).join("")}</ul>`;
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal" role="dialog">
        <div class="modal-header">
          <h3>${t("modal.invites")} · ${escapeHtml(ws?.name ?? "")}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="modal-body">
          <form id="create-invite" class="inline-form">
            <input name="maxUses" type="number" min="0" max="10000" placeholder="макс. использований (0 = ∞)" />
            ${renderInviteTtlSelect()}
            <button type="submit" class="primary">Создать инвайт</button>
          </form>
          ${list}
        </div>
      </div>
    </div>
  `;
}

// J.3: per-channel NSFW-ack. Ключ хранится только локально — на новом
// клиенте/девайсе юзер увидит overlay снова, это «фичерное» поведение
// (Discord так же). Не реализуем server-side ack — он бы только нагружал API.
export function nsfwAckKey(channelId: string): string {
  return `rucord:nsfw-ack:${channelId}`;
}

export function hasNsfwAck(channelId: string): boolean {
  try {
    return localStorage.getItem(nsfwAckKey(channelId)) === "1";
  } catch {
    return false;
  }
}

export function setNsfwAck(channelId: string): void {
  try {
    localStorage.setItem(nsfwAckKey(channelId), "1");
  } catch {
    /* quota / disabled */
  }
}

// Wave 9: форум-вью — карточки постов (title, автор, превью, счётчик,
// последняя активность), сортировка по активности приходит с сервера.
// Клик по карточке открывает тред обычным selectChannel().
export function renderForumView(channel: Channel): string {
  const isArchived = !!channel.archivedAt;
  const cards = uiContext.state.forumPosts
    .map((p) => {
      const authorName = p.authorDisplayName || p.authorUsername || "";
      const avatar = renderAvatar({
        avatarMediaId: p.authorAvatarId || undefined,
        fallbackText: authorName || p.title,
        sizePx: 28,
      });
      const count = p.messageCount > 99 ? "99+" : String(p.messageCount);
      return `
        <div class="forum-post-card" data-ch-open="${p.id}">
          <div class="forum-post-title">${escapeHtml(p.title)}</div>
          ${p.preview ? `<div class="forum-post-preview">${escapeHtml(p.preview)}</div>` : ""}
          <div class="forum-post-meta">
            ${avatar}
            ${authorName ? `<span class="forum-post-author">${escapeHtml(authorName)}</span>` : ""}
            <span class="forum-post-count">${icon("reply", { size: 13 })} ${count}</span>
            <span class="forum-post-activity">${escapeHtml(formatTimeSmart(p.lastActivityAt))}</span>
          </div>
        </div>
      `;
    })
    .join("");
  // Плейсхолдер только когда карточек нет: refresh с keepCurrent оставляет
  // старые карточки на месте до прихода свежего списка.
  const emptyBlock =
    uiContext.state.forumPosts.length > 0
      ? ""
      : uiContext.state.forumPostsLoading
        ? `<div class="forum-empty">${t("forum.loading")}</div>`
        : `<div class="forum-empty">
           <div class="forum-empty-title">${t("forum.empty.title")}</div>
           <div class="forum-empty-sub">${t("forum.empty.sub")}</div>
         </div>`;
  return `
    <header class="channel-header">
      <div class="channel-header-title">
        <h2>${channelPrefix(channel)}<span class="channel-header-name">${escapeHtml(channel.name)}</span></h2>
        ${isArchived ? `<span class="channel-archived-badge">${t("chat.header.archived")}</span>` : ""}
        ${channel.topic ? `<span class="channel-header-sep">·</span><span class="channel-header-topic">${escapeHtml(channel.topic)}</span>` : ""}
      </div>
      <div class="channel-header-actions">
        ${isArchived ? "" : `<button id="forum-new-post" class="primary forum-new-post-btn">${icon("plus", { size: 14 })} ${t("forum.newPost")}</button>`}
      </div>
    </header>
    <div class="forum-post-list">
      ${cards}
      ${emptyBlock}
    </div>
  `;
}

export function renderChannelView(channel: Channel): string {
  if (channel.kind === "voice") {
    return renderVoiceChannelView(channel);
  }
  // Wave 9: форум — список постов вместо message-стрима.
  if (channel.kind === "forum") {
    return renderForumView(channel);
  }
  // J.3: NSFW gate — показываем overlay до явного подтверждения.
  // DM-каналы исключаем (там нет per-channel настройки).
  if (channel.kind === "text" && channel.isNsfw && !hasNsfwAck(channel.id)) {
    return `
      <div class="nsfw-gate">
        <div class="nsfw-gate-card">
          <h2>Канал помечен 18+</h2>
          <p>
            Канал <strong>#${escapeHtml(channel.name)}</strong> может содержать материалы,
            подходящие только для взрослых. Если тебе ещё нет 18 или ты не хочешь видеть
            такой контент — закрой канал.
          </p>
          <div class="nsfw-gate-actions">
            <button id="nsfw-decline" class="ghost">Назад</button>
            <button id="nsfw-accept" class="primary" data-channel-id="${channel.id}">Мне исполнилось 18, продолжить</button>
          </div>
        </div>
      </div>
    `;
  }
  // Wave 8: архивный канал — read-only (бэк отдаст 403 на POST в любом случае).
  const isArchived = !!channel.archivedAt;
  // Wave 9: в тредах (постах форума) композер работает как в тексте.
  const canSend =
    (channel.kind === "text" || channel.kind === "thread") && !isArchived;
  const ws = uiContext.state.workspaces.find(
    (w) => w.id === channel.workspaceId,
  );
  const canModerate =
    !!ws && ["owner", "admin", "moderator"].includes(ws.role ?? "");
  // Wave 9/10: breadcrumb для треда — стрелка назад к родителю (форум или
  // text-канал для тредов на сообщениях).
  const parentForum =
    channel.kind === "thread" && channel.parentChannelId
      ? uiContext.state.channels.find((c) => c.id === channel.parentChannelId)
      : undefined;
  const backLabel =
    parentForum?.kind === "forum" ? t("forum.back") : t("thread.back");
  const breadcrumb = parentForum
    ? `<button class="ghost thread-back" data-ch-open="${parentForum.id}" data-tooltip="${backLabel}" aria-label="${backLabel}">${icon("reply", { size: 16 })}</button>
       <span class="thread-parent" data-ch-open="${parentForum.id}">${channelPrefix(parentForum)} ${escapeHtml(parentForum.name)}</span>
       <span class="channel-header-sep">›</span>`
    : "";
  // J.1 + J.4: тема канала переехала на ту же строку, что и имя
  // (`# название · тема` с разделителем-точкой); ⚙ настроек канала
  // из header удалён — теперь на самом канале в sidebar при hover (J.2).
  // Порядок action-кнопок: 🔍 поиск → 📜 журнал → 👥 участники (rightmost).
  return `
    <header class="channel-header">
      <div class="channel-header-title">
        ${breadcrumb}
        <h2>${channelPrefix(channel)}<span class="channel-header-name">${escapeHtml(channel.name)}</span></h2>
        ${isArchived ? `<span class="channel-archived-badge">${t("chat.header.archived")}</span>` : ""}
        ${channel.topic ? `<span class="channel-header-sep">·</span><span class="channel-header-topic">${escapeHtml(channel.topic)}</span>` : ""}
      </div>
      <div class="channel-header-actions">
        <button id="open-pins" class="ghost${uiContext.state.pinsPopupOpen ? " active" : ""}" data-tooltip="${t("header.pins")}" aria-label="${t("header.pins")}">${icon("pin")}</button>
        <button id="open-search" class="ghost" data-tooltip="${t("header.search")}" aria-label="${t("modal.search")}">${icon("search")}</button>
        ${canModerate ? `<button id="open-audit" class="ghost" data-tooltip="${t("header.audit")}" aria-label="${t("header.audit")}">${icon("scroll")}</button>` : ""}
        <button id="toggle-member-sidebar" class="ghost" data-tooltip="${uiContext.state.memberSidebarOpen ? t("header.members.hide") : t("header.members.show")}" aria-label="${t("modal.members")}">${icon("users")}</button>
      </div>
      <div id="region-pins">${uiContext.state.pinsPopupOpen && uiContext.state.channelPinsChannelId === channel.id ? renderPinsPopup() : ""}</div>
    </header>
    ${
      canSend
        ? `<div id="drop-zone" class="drop-zone" hidden>
      <div class="drop-zone-inner">${t("chat.dropzone")}</div>
    </div>`
        : ""
    }
    <div id="sticky-date" class="sticky-date" hidden></div>
    <div id="message-list" class="message-list">
      ${renderMessagesWithDivider()}
    </div>
    ${renderJumpToUnread()}
    ${uiContext.state.pendingUploads.length > 0 ? renderPendingUploads() : ""}
    ${renderReplyBar()}
    <div id="mention-popup" class="mention-popup" hidden></div>
    <div id="channel-popup" class="mention-popup" hidden></div>
    <div id="slash-popup" class="mention-popup" hidden></div>
    <div id="typing-line" class="typing-line"></div>
    <form id="send-form" class="send-form">
      <label class="attach-btn ${canSend ? "" : "disabled"}" data-tooltip="${t("chat.composer.attach", { max: uiContext.MAX_ATTACHMENTS })}">
        ${icon("paperclip")}
        <input type="file" id="attach-input" multiple hidden ${canSend ? "" : "disabled"} />
      </label>
      <input
        name="body"
        autocomplete="off"
        placeholder="${
          canSend
            ? slowModeRemainingSec(channel.id) > 0
              ? t("chat.composer.slowmode", {
                  sec: slowModeRemainingSec(channel.id),
                })
              : t("chat.composer.message_in", { name: channel.name })
            : isArchived
              ? t("chat.composer.archived")
              : t("chat.composer.readonly")
        }"
        ${canSend ? "" : "disabled"}
        value="${escapeHtml(canSend ? loadDraft(channel.id) : "")}"
      />
      <button type="button" id="composer-emoji" class="composer-emoji-btn" data-tooltip="${t("chat.composer.emoji")}" ${canSend ? "" : "disabled"}>${icon("smile")}</button>
      <button type="submit" ${canSend && slowModeRemainingSec(channel.id) === 0 ? "" : "disabled"}>${uiContext.state.uploadInFlight ? "…" : "↑"}</button>
    </form>
  `;
}
