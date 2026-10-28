import { t } from "../i18n";
import { canChannel, canWorkspace } from "./capabilities";
import { icon } from "../icons";
import { openLightbox } from "../lightbox";
import { mediaBlobCache } from "../mediaCache";
import { renderBody as renderMessageBody } from "../messageBody";
import { uiContext } from "../state";
import type {
  Attachment,
  LinkPreview,
  Message,
  MessageThreadInfo,
  ReactionAgg,
  ReplySnippet,
} from "../types";
import {
  formatTime,
  formatTimeSmart,
  formatTimeSmartShort,
} from "../util/format";
import { escapeHtml } from "../util/html";
import { authorBadge, authorColorStyle, describePeer } from "./callView";
import { channelsByName, membersById, membersByUsername } from "./indexes";
import { getUserColor, renderAvatar } from "./shell";
export function renderBody(body: string, mentionEveryone?: string): string {
  return renderMessageBody(body, mentionEveryone, {
    meUsername: uiContext.state.me?.username,
    membersByUsername: membersByUsername(),
    channelsByName: channelsByName(),
  });
}

export function renderPendingUploads(): string {
  return `
    <div class="pending-uploads">
      ${uiContext.state.pendingUploads
        .map(
          (a) => `
        <div class="pending-chip" data-pending="${a.id}">
          <span>${isImage(a.contentType) ? "🖼" : "📄"} ${escapeHtml(a.filename || "файл")} · ${formatBytes(a.sizeBytes)}</span>
          <button class="ghost pending-remove" data-id="${a.id}" data-tooltip="Убрать">✕</button>
        </div>
      `,
        )
        .join("")}
    </div>
  `;
}

// Wave 2: лайтбокс по клику на превью. Thumb уже в mediaBlobCache (его
// загрузил attach-image loop); оригинал тянем лениво через httpClient
// (media-endpoint требует Authorization) и кешируем в тот же LRU.
export function openImageLightbox(slot: HTMLDivElement): void {
  const thumbKey = slot.dataset.mediaUrl;
  const fullUrl = slot.dataset.fullUrl;
  if (!fullUrl) return;
  openLightbox({
    thumbUrl: thumbKey ? (mediaBlobCache.get(thumbKey) ?? null) : null,
    filename: slot.dataset.filename || "image",
    loadFull: async () => {
      const cached = mediaBlobCache.get(fullUrl);
      if (cached) return cached;
      const blob = await uiContext.httpClient.getBlob(fullUrl);
      const blobUrl = URL.createObjectURL(blob);
      mediaBlobCache.set(fullUrl, blobUrl);
      return blobUrl;
    },
  });
}

// Wave 2: OG-карточки под сообщением (Discord-style: accent-полоса слева,
// siteName/title/description + thumb справа). imageUrl хотлинкается с
// внешнего сайта (CSP null) — заголовок и так весь escape'ится.
export function renderLinkPreviews(
  previews: LinkPreview[] | undefined,
): string {
  if (!previews || previews.length === 0) return "";
  const cards = previews
    .filter((p) => p.url && /^https?:\/\//i.test(p.url))
    .map((p) => {
      const img =
        p.imageUrl && /^https?:\/\//i.test(p.imageUrl)
          ? `<img class="link-preview-img" src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy" />`
          : "";
      return `
        <div class="link-preview">
          <div class="link-preview-text">
            ${p.siteName ? `<div class="link-preview-site">${escapeHtml(p.siteName)}</div>` : ""}
            ${p.title ? `<a class="link-preview-title" href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(p.title)}</a>` : ""}
            ${p.description ? `<div class="link-preview-desc">${escapeHtml(p.description)}</div>` : ""}
          </div>
          ${img}
        </div>
      `;
    })
    .join("");
  return cards ? `<div class="link-previews">${cards}</div>` : "";
}

export function renderAttachment(a: Attachment): string {
  if (isImage(a.contentType)) {
    return `<div class="attach-image" data-media-url="${escapeHtml(a.url + "/thumb")}" data-full-url="${escapeHtml(a.url)}" data-filename="${escapeHtml(a.filename || "image")}">
              <div class="attach-image-loader">Загрузка изображения…</div>
            </div>`;
  }
  return `
    <a class="attach-file" data-media-url="${escapeHtml(a.url)}" data-filename="${escapeHtml(a.filename || "file")}" href="#">
      <span class="attach-icon">📄</span>
      <div>
        <div class="attach-name">${escapeHtml(a.filename || "файл")}</div>
        <div class="attach-meta">${escapeHtml(a.contentType)} · ${formatBytes(a.sizeBytes)}</div>
      </div>
    </a>
  `;
}

export function isImage(contentType: string): boolean {
  return contentType.startsWith("image/");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// reactionTooltip — «Маша, Петя и ещё 3 поставили 👍». Поле userIds —
// упорядочено по created_at (см. SQL агрегатор). Имена резолвятся через
// state.members + state.me; неизвестные UUID показываются как «кто-то».
export function reactionTooltip(emoji: string, agg: ReactionAgg): string {
  const ids = agg.userIds ?? [];
  if (ids.length === 0) return `${emoji} · реакций: ${agg.count}`;
  const names = ids.map((id) => {
    if (id === uiContext.state.me?.id) return "Вы";
    const m = uiContext.state.members.find((mm) => mm.userId === id);
    return m?.displayName || m?.username || "кто-то";
  });
  const head = names.slice(0, 6);
  const rest = names.length - head.length;
  let list = head.join(", ");
  if (rest > 0) list += ` и ещё ${rest}`;
  return `${list} — ${emoji}`;
}

export function renderReplySnippet(reply: ReplySnippet | undefined): string {
  if (!reply) return "";
  if (reply.deleted) {
    return `<div class="reply-snippet deleted">
      <span class="reply-arrow">${icon("reply", { size: 14 })}</span>
      <span class="muted">исходное сообщение удалено</span>
    </div>`;
  }
  const author = describePeer(reply.authorId);
  const member = uiContext.state.members.find(
    (m) => m.userId === reply.authorId,
  );
  const avatar = renderAvatar({
    avatarMediaId: member?.avatarMediaId,
    fallbackText: author,
    sizePx: 16,
    className: "reply-avatar",
  });
  const color = member ? getUserColor(member.userId, member.role) : undefined;
  const authorStyle = color ? ` style="color:${color};"` : "";
  return `<div class="reply-snippet" data-jump-id="${escapeHtml(reply.messageId)}" data-tooltip="Перейти к исходному">
    <span class="reply-arrow">${icon("reply", { size: 14 })}</span>
    ${avatar}
    <span class="reply-author"${authorStyle}>${escapeHtml(author)}</span>
    <span class="reply-body">${escapeHtml(reply.body)}</span>
  </div>`;
}

export function renderReplyBar(): string {
  const r = uiContext.state.replyingTo;
  if (!r) return "";
  if (r.deleted) {
    return `<div class="reply-bar">
      <span class="muted">Отвечаем на удалённое сообщение</span>
      <button class="ghost reply-cancel" data-tooltip="Отменить ответ">✕</button>
    </div>`;
  }
  const author = describePeer(r.authorId);
  return `<div class="reply-bar">
    <span class="reply-arrow">↩</span>
    <span>В ответ <b>${escapeHtml(author)}</b>: ${escapeHtml(r.body)}</span>
    <button class="ghost reply-cancel" data-tooltip="Отменить ответ">✕</button>
  </div>`;
}

// C.5: pill "↓ N новых" — показываем когда юзер не у низа и есть
// новые сообщения в этом канале (есть divider). Клик скроллит к
// divider'у, в крайнем случае — к низу. Реализовано через
// stickToBottom: если юзер пин'нут к низу, скрываем.
export function renderJumpToUnread(): string {
  if (uiContext.state.stickToBottom) return "";
  const cutoff = uiContext.state.selectedChannelLastReadAt
    ? Date.parse(uiContext.state.selectedChannelLastReadAt)
    : NaN;
  if (Number.isNaN(cutoff)) return "";
  const newCount = uiContext.state.messages.filter(
    (m) =>
      Date.parse(m.createdAt) > cutoff && m.authorId !== uiContext.state.me?.id,
  ).length;
  if (newCount === 0) return "";
  return `<button id="jump-to-unread" class="jump-to-unread">↓ ${newCount} ${pluralizeNew(newCount)}</button>`;
}

export function pluralizeNew(n: number): string {
  return n % 10 === 1 && n % 100 !== 11 ? "новое" : "новых";
}

export function renderMessage(m: Message, grouped: boolean = false): string {
  // H.9: system-сообщения — плашка без аватара/реакций/edit/reply. body —
  // fallback-текст с бэка; resolveSystemText даёт более точную русскую
  // формулировку, если автор в state.members (свежие данные).
  if (m.kind && m.kind !== "user") {
    return renderSystemMessage(m);
  }
  // Wave 3: сообщения заблокированных свёрнуты (Discord-pattern). Клик
  // раскрывает конкретное сообщение до следующего полного relog'а.
  if (
    uiContext.state.blockedIds.has(m.authorId) &&
    !uiContext.state.revealedBlocked.has(m.id)
  ) {
    return `
      <div class="message message-blocked" data-reveal-blocked="${m.id}" data-tooltip="Нажми, чтобы показать">
        <span>Сообщение заблокированного пользователя</span>
        <button class="ghost">Показать</button>
      </div>
    `;
  }
  const isMine = uiContext.state.me?.id === m.authorId;
  const selectedWorkspace = uiContext.state.workspaces.find(
    (w) => w.id === uiContext.state.selectedWorkspaceId,
  );
  const canModerate = !!selectedWorkspace && canWorkspace("message.moderate", selectedWorkspace.id);
  const canDelete = isMine || canModerate;
  // Pin/unpin: в DM может любой участник, в workspace-канале — только модератор+.
  const canPin = uiContext.state.dmMode || canModerate;
  const isEditing = uiContext.state.editingMessageId === m.id;
  const reactions = Object.entries(m.reactions ?? {});

  const authorName = describePeer(m.authorId);
  const authorMember = membersById().get(m.authorId);
  const authorAvatarId =
    m.authorId === uiContext.state.me?.id
      ? uiContext.state.me?.avatarMediaId
      : authorMember?.avatarMediaId;
  const authorCustomStatus =
    m.authorId === uiContext.state.me?.id
      ? uiContext.state.me?.customStatus
      : authorMember?.customStatus;
  const authorTitle = authorCustomStatus
    ? ` data-tooltip="${escapeHtml(authorCustomStatus)}"`
    : "";
  const avatarHtml = `<button class="profile-avatar-button" data-profile-user="${escapeHtml(m.authorId)}" aria-label="Профиль ${escapeHtml(authorName)}">${renderAvatar({
    avatarMediaId: authorAvatarId,
    fallbackText: authorName,
    sizePx: 40,
    className: "message-avatar",
    decoration:
      m.authorId === uiContext.state.me?.id
        ? uiContext.state.me?.avatarDecoration
        : authorMember?.avatarDecoration,
  })}</button>`;

  if (isEditing) {
    return `
      <div class="message" data-id="${m.id}">
        ${avatarHtml}
        <div class="message-content">
          <div class="message-meta">
            <button class="author profile-name-button" data-profile-user="${escapeHtml(m.authorId)}"${authorColorStyle(m.authorId)}>${escapeHtml(authorName)}</button>${authorBadge(m.authorId)}
            <span class="timestamp" data-tooltip="${escapeHtml(formatTime(m.createdAt))}">${formatTimeSmart(m.createdAt)}</span>
          </div>
          <form class="edit-form" data-edit-id="${m.id}">
            <input name="body" value="${escapeHtml(m.body)}" autofocus />
            <button type="submit" class="primary">Сохранить</button>
            <button type="button" class="ghost cancel-edit" data-id="${m.id}">Отмена</button>
          </form>
        </div>
      </div>
    `;
  }

  const groupedCls = grouped ? " message-grouped" : "";
  const avatarSlot = grouped
    ? `<span class="message-avatar message-avatar-spacer" aria-hidden="true"><span class="grouped-timestamp" data-tooltip="${escapeHtml(formatTime(m.createdAt))}">${escapeHtml(formatTimeSmartShort(m.createdAt))}</span></span>`
    : avatarHtml;
  // Wave 10: тред из сообщения — только в text-каналах воркспейса (не DM,
  // не внутри треда/форума). Если тред уже есть — вход через чип, кнопку
  // не дублируем.
  const msgChannel = uiContext.state.channels.find((c) => c.id === m.channelId);
  const canThread =
    !uiContext.state.dmMode &&
    msgChannel?.kind === "text" &&
    !msgChannel.archivedAt &&
    canChannel("message.write", m.channelId) &&
    !m.thread;
  // Wave 6: общий тулбар для обоих вариантов meta — i18n в одном месте.
  const actionsHtml = `<span class="message-actions">
          ${canChannel("message.react", m.channelId) ? `<button class="ghost action-react" data-id="${m.id}" data-tooltip="${t("msg.react")}">${icon("smile")}</button>` : ""}
          <button class="ghost action-reply" data-id="${m.id}" data-author="${escapeHtml(m.authorId)}" data-tooltip="${t("msg.reply")}">${icon("reply")}</button>
          ${canThread ? `<button class="ghost action-thread" data-id="${m.id}" data-tooltip="${t("msg.thread")}">${icon("channel-forum")}</button>` : ""}
          ${isMine ? `<button class="ghost action-edit" data-id="${m.id}" data-tooltip="${t("msg.edit")}">${icon("pencil")}</button>` : ""}
          ${
            canPin
              ? `<button class="ghost action-pin" data-id="${m.id}" data-pinned="${m.isPinned ? "1" : "0"}" data-tooltip="${m.isPinned ? t("msg.unpin") : t("msg.pin")}">${icon(m.isPinned ? "pin-off" : "pin")}</button>`
              : ""
          }
          ${canDelete ? `<button class="ghost action-delete" data-id="${m.id}" data-tooltip="${t("common.delete")}">${icon("trash")}</button>` : ""}
        </span>`;
  const metaBlock = grouped
    ? `<div class="message-meta message-meta-grouped">
        ${actionsHtml}
      </div>`
    : `<div class="message-meta">
        <button class="author profile-name-button" data-profile-user="${escapeHtml(m.authorId)}"${authorColorStyle(m.authorId)}${authorTitle}>${escapeHtml(authorName)}</button>${authorBadge(m.authorId)}${isMine ? ` <span class="author-mine">${t("msg.you")}</span>` : ""}
        <span class="timestamp" data-tooltip="${escapeHtml(formatTime(m.createdAt))}">${formatTimeSmart(m.createdAt)}${m.editedAt ? t("msg.edited") : ""}</span>
        ${actionsHtml}
      </div>`;
  const pinnedCls = m.isPinned ? " message-pinned" : "";
  return `
    <div class="message${groupedCls}${pinnedCls}" data-id="${m.id}">
      ${avatarSlot}
      <div class="message-content">
      ${m.isPinned ? `<div class="message-pin-badge" data-tooltip="Закреплённое сообщение">${icon("pin", { size: 12 })}</div>` : ""}
      ${renderReplySnippet(m.replyTo)}
      ${metaBlock}
      ${m.body ? `<div class="message-body">${renderBody(m.body, m.mentionEveryone)}</div>` : ""}
      ${
        m.attachments && m.attachments.length > 0
          ? `<div class="attachments">${m.attachments.map((a) => renderAttachment(a)).join("")}</div>`
          : ""
      }
      ${renderLinkPreviews(m.linkPreviews)}
      ${
        reactions.length > 0
          ? `<div class="reaction-row">
              ${reactions
                .map(
                  ([emoji, agg]) => `
                <button class="reaction-chip${agg.mine ? " mine" : ""}" data-react-toggle="${m.id}" data-emoji="${escapeHtml(emoji)}" data-tooltip="${escapeHtml(reactionTooltip(emoji, agg))}" ${canChannel("message.react", m.channelId) ? "" : "disabled"}>
                  <span>${escapeHtml(emoji)}</span>
                  <span class="count">${agg.count}</span>
                </button>
              `,
                )
                .join("")}
            </div>`
          : ""
      }
      ${renderThreadChip(m.thread)}
      </div>
    </div>
  `;
}

// Wave 10: чип «Тред: N ответов» под сообщением. Клик открывает тред как
// обычный канал через generic [data-ch-open] обработчик.
export function renderThreadChip(
  thread: MessageThreadInfo | null | undefined,
): string {
  if (!thread) return "";
  return `<button class="thread-chip" data-ch-open="${escapeHtml(thread.threadId)}" data-tooltip="${t("thread.open")}">
      ${icon("channel-forum", { size: 14 })}
      <span class="thread-chip-title">${escapeHtml(thread.title)}</span>
      <span class="thread-chip-count">${t("thread.replies", { n: thread.messageCount })}</span>
      ${thread.lastActivityAt ? `<span class="thread-chip-activity">${escapeHtml(formatTimeSmart(thread.lastActivityAt))}</span>` : ""}
    </button>`;
}

export function renderSystemMessage(m: Message): string {
  // Иконка по kind. system_join — стрелка-вход; system_call — телефон;
  // system_channel_event — pencil (реорг канала). Старые kind'ы кроме
  // 'user' могут прилететь от свежего бэка с обновлённой матрицей —
  // fallback на info-точку.
  const iconName =
    m.kind === "system_join"
      ? "log-out"
      : m.kind === "system_call"
        ? "phone"
        : m.kind === "system_channel_event"
          ? "pencil"
          : "smile";
  // Имя автора режется через state.members (свежий displayName) с
  // фолбэком на body (бэк уже подставил displayName при создании).
  const authorName = describePeer(m.authorId);
  // body уже содержит читабельный текст. Если в state.members есть
  // displayName новее, чем на момент join'а, не подменяем — body —
  // зафиксированный «срез истории», как и должно быть для плашки.
  const text = m.body || `${authorName} (${m.kind})`;
  return `
    <div class="message message-system" data-id="${m.id}">
      <span class="message-system-icon">${icon(iconName, { size: 16 })}</span>
      <span class="message-system-text">${escapeHtml(text)}</span>
      <span class="message-system-time" data-tooltip="${escapeHtml(formatTime(m.createdAt))}">${formatTimeSmart(m.createdAt)}</span>
    </div>
  `;
}
