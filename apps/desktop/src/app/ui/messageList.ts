import { getAppearance } from "../appearance";
import { patchElement } from "../dom";
import { describeError } from "../errors";
import { getLocale, getTimeFormat } from "../i18n";
import { layoutMessages } from "../layoutMessages";
import { uiContext } from "../state";
import type { Message } from "../types";
import { dayLabel } from "../util/dates";
import { escapeHtml } from "../util/html";
import { setTransientStatus } from "./helpers";
import { focusHistory, mergeHistory, visibleRange } from "./history";
import { updateTypingLine } from "./loaders";
import { hydrateMedia } from "./media";
import { messageListState } from "./messageListState";
import { renderMessage } from "./messageView";

// C.5: рендер с разделителем "Новые сообщения" перед первым
// сообщением, чей createdAt позже зафиксированного lastReadAt.
// lastReadAt фризим в selectChannel, чтобы divider не «уплыл» когда
// мы автомаркаем канал прочитанным после загрузки.
export function renderMessagesWithDivider(): string {
  const range = visibleRange();
  const layout = layoutMessages(uiContext.state.messages, {
    ...range,
    meId: uiContext.state.me?.id,
    lastReadAt: uiContext.state.selectedChannelLastReadAt,
    editingId: uiContext.state.editingMessageId,
    groupMessages: getAppearance().groupMessages,
  });
  return layout
    .map((row) => messageRowHtml(uiContext.state.messages[row.index], row))
    .join("");
}

export function messageRowHtml(
  message: Message,
  row: ReturnType<typeof layoutMessages>[number],
): string {
  const current = [
    uiContext.state.members,
    uiContext.state.channels,
    uiContext.state.me,
    uiContext.state.workspaces,
    getAppearance(),
    getLocale(),
    getTimeFormat(),
  ];
  if (
    current.some((value, i) => value !== messageListState.lastMessageContext[i])
  ) {
    messageListState.messageContextVersion++;
    messageListState.lastMessageContext = current;
  }
  const context = [
    messageListState.messageContextVersion,
    row.day,
    row.unread,
    row.grouped,
    uiContext.state.editingMessageId === message.id,
    uiContext.state.pickerForMessageId === message.id,
    uiContext.state.dmMode,
    uiContext.state.blockedIds.has(message.authorId),
    uiContext.state.revealedBlocked.has(message.id),
  ].join(":");
  const cached = messageListState.messageHtmlCache.get(message);
  if (cached?.context === context) return cached.html;
  const html =
    '<div class="message-row" data-row-id="' +
    escapeHtml(message.id) +
    '">' +
    (row.day
      ? '<div class="day-divider"><span>' +
        escapeHtml(dayLabel(message.createdAt)) +
        "</span></div>"
      : "") +
    (row.unread
      ? '<div class="new-messages-divider"><span>Новые сообщения</span></div>'
      : "") +
    renderMessage(message, row.grouped) +
    "</div>";
  messageListState.messageHtmlCache.set(message, { context, html });
  return html;
}

export function updateMessageList(): void {
  const list = uiContext.rootEl.querySelector<HTMLDivElement>("#message-list");
  if (!list) return;
  const anchor = [...list.querySelectorAll<HTMLElement>(".message-row")].find(
    (row) => row.offsetTop >= list.scrollTop,
  );
  const anchorId = anchor?.dataset.rowId,
    offset = anchor ? anchor.offsetTop - list.scrollTop : 0;
  const range = visibleRange();
  const rows = layoutMessages(uiContext.state.messages, {
    ...range,
    meId: uiContext.state.me?.id,
    lastReadAt: uiContext.state.selectedChannelLastReadAt,
    editingId: uiContext.state.editingMessageId,
    groupMessages: getAppearance().groupMessages,
  });
  const existing = new Map(
    [...list.children].map((el) => [
      (el as HTMLElement).dataset.rowId,
      el as HTMLElement,
    ]),
  );
  const wanted = new Set(rows.map((row) => row.id));
  for (const [id, el] of existing) if (!id || !wanted.has(id)) el.remove();
  let previous: HTMLElement | null = null;
  for (const row of rows) {
    const html = messageRowHtml(uiContext.state.messages[row.index], row);
    let element = existing.get(row.id);
    if (!element) {
      const template = document.createElement("template");
      template.innerHTML = html;
      element = template.content.firstElementChild as HTMLElement;
      list.insertBefore(
        element,
        previous ? previous.nextSibling : list.firstChild,
      );
      messageListState.renderedRows.set(element, html);
      hydrateMedia(element);
    } else {
      if (messageListState.renderedRows.get(element) !== html) {
        patchElement(element, html);
        messageListState.renderedRows.set(element, html);
        hydrateMedia(element);
      }
      const expected: ChildNode | null = previous
        ? previous.nextSibling
        : list.firstChild;
      if (expected !== element) list.insertBefore(element, expected);
    }
    previous = element;
  }
  if (uiContext.state.stickToBottom) list.scrollTop = list.scrollHeight;
  else if (anchorId) {
    const kept = list.querySelector<HTMLElement>(
      '[data-row-id="' + CSS.escape(anchorId) + '"]',
    );
    if (kept) list.scrollTop = kept.offsetTop - offset;
  }
  updateTypingLine();
}

export function rememberRenderedRows(): void {
  const elements = new Map(
    [...uiContext.rootEl.querySelectorAll<HTMLElement>("[data-row-id]")].map(
      (element) => [element.dataset.rowId, element],
    ),
  );
  const range = visibleRange();
  for (const row of layoutMessages(uiContext.state.messages, {
    ...range,
    meId: uiContext.state.me?.id,
    lastReadAt: uiContext.state.selectedChannelLastReadAt,
    editingId: uiContext.state.editingMessageId,
    groupMessages: getAppearance().groupMessages,
  })) {
    const el = elements.get(row.id);
    if (el)
      messageListState.renderedRows.set(
        el,
        messageRowHtml(uiContext.state.messages[row.index], row),
      );
  }
}

export async function jumpToMessage(id: string): Promise<void> {
  const channelId = uiContext.state.selectedChannelId;
  if (!channelId) return;
  let index = uiContext.state.messages.findIndex(
    (message) => message.id === id,
  );
  if (index < 0) {
    try {
      const data = await uiContext.httpClient.get<{ items: Message[] }>(
        `/api/v1/channels/${channelId}/messages?limit=100&around=${encodeURIComponent(id)}`,
      );
      if (uiContext.state.selectedChannelId !== channelId) return;
      mergeHistory(data.items ?? []);
      const first = uiContext.state.messages[0];
      if (first) {
        uiContext.state.messagesCursor = `${first.createdAt}|${first.id}`;
        uiContext.state.messagesHasMore = true;
      }
      index = uiContext.state.messages.findIndex(
        (message) => message.id === id,
      );
      if (index < 0) {
        setTransientStatus("Сообщение удалено или недоступно");
        return;
      }
    } catch (error) {
      setTransientStatus(describeError(error));
      return;
    }
  }
  uiContext.state.stickToBottom = false;
  focusHistory(index);
  updateMessageList();
  const target = uiContext.rootEl.querySelector<HTMLElement>(
    '.message[data-id="' + CSS.escape(id) + '"]',
  );
  if (target) {
    target.scrollIntoView({ block: "center" });
    target.classList.add("highlight");
    setTimeout(() => target.classList.remove("highlight"), 1500);
  }
}
