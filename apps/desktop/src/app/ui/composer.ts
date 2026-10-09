import type { ApiError } from "../../network/httpClient";
import { t } from "../i18n";
import { uiContext } from "../state";
import type { Channel, MentionOption } from "../types";
import { escapeHtml } from "../util/html";
import { channelPrefix } from "./channelView";
import { hasHistoryGap, loadHistoryGap, visibleRange } from "./history";
import { loadOlderMessages } from "./loaders";
import { updateMessageList } from "./messageList";

export function updateStickyDate(list: HTMLDivElement): void {
  const pill = uiContext.rootEl.querySelector<HTMLElement>("#sticky-date");
  if (!pill) return;
  if (list.scrollTop < 20) {
    pill.hidden = true;
    return;
  }
  const listRect = list.getBoundingClientRect();
  let label: string | null = null;
  // Дивайдеров в окне немного (1 на день) — линейный проход дешёвый.
  for (const holder of Array.from(
    list.querySelectorAll<HTMLElement>(".day-divider"),
  )) {
    if (holder.getBoundingClientRect().top <= listRect.top + 12) {
      label = holder.textContent?.trim() ?? null;
    } else {
      break;
    }
  }
  if (!label) {
    pill.hidden = true;
    return;
  }
  pill.textContent = label;
  pill.hidden = false;
  if (uiContext.stickyDateHideTimer)
    clearTimeout(uiContext.stickyDateHideTimer);
  uiContext.stickyDateHideTimer = setTimeout(() => {
    pill.hidden = true;
  }, 1200);
}

export function onMessageListScroll(e: Event): void {
  const list = e.currentTarget as HTMLDivElement;
  const range = visibleRange();
  const bottomDistance = list.scrollHeight - list.scrollTop - list.clientHeight;
  uiContext.state.stickToBottom =
    bottomDistance < 80 && range.end === uiContext.state.messages.length;
  updateStickyDate(list);
  if (list.scrollTop < 150 && range.start > 0) {
    if (hasHistoryGap(range.start - 1))
      void loadHistoryGap("before", uiContext.state.messages[range.start]);
    else {
      uiContext.state.windowStart = Math.max(0, range.start - 100);
      updateMessageList();
    }
  } else if (
    bottomDistance < 150 &&
    range.end < uiContext.state.messages.length
  ) {
    if (hasHistoryGap(range.end - 1))
      void loadHistoryGap("after", uiContext.state.messages[range.end - 1]);
    else {
      uiContext.state.windowStart = range.start + 100;
      updateMessageList();
    }
  } else if (
    list.scrollTop < 200 &&
    uiContext.state.messagesHasMore &&
    !uiContext.state.messagesLoadingOlder &&
    uiContext.state.selectedChannelId
  )
    void loadOlderMessages(uiContext.state.selectedChannelId, list);
}

export function filterMentionMatches(query: string): MentionOption[] {
  const q = query.toLowerCase();
  const meId = uiContext.state.me?.id;
  const out: MentionOption[] = [];
  for (const m of uiContext.state.members) {
    if (m.userId === meId) continue;
    if (!m.username.startsWith(q)) continue;
    out.push(m);
    if (out.length >= 8) break;
  }
  // @everyone/@here — в конце списка, только в workspace-каналах. Сервер
  // сам молча проигнорит пинг, если права message.mention_everyone нет.
  if (!uiContext.state.dmMode) {
    if ("everyone".startsWith(q))
      out.push({
        username: "everyone",
        displayName: "Уведомить всех участников",
      });
    if ("here".startsWith(q))
      out.push({
        username: "here",
        displayName: "Уведомить участников онлайн",
      });
  }
  return out;
}

export function updateMentionPopup(
  input: HTMLInputElement,
  popup: HTMLDivElement,
): void {
  const caret = input.selectionStart ?? input.value.length;
  const head = input.value.slice(0, caret);
  const m = head.match(uiContext.MENTION_TOKEN_RE);
  if (!m) {
    hideMentionPopup(popup);
    return;
  }
  const query = m[1];
  const matches = filterMentionMatches(query);
  if (matches.length === 0) {
    hideMentionPopup(popup);
    return;
  }
  const prevIndex = uiContext.state.mentionAutocomplete?.selectIndex ?? 0;
  const selectIndex = Math.min(prevIndex, matches.length - 1);
  uiContext.state.mentionAutocomplete = { query, selectIndex };
  renderMentionPopupContent(popup, matches, selectIndex);
  popup.hidden = false;
}

export function renderMentionPopupContent(
  popup: HTMLDivElement,
  matches: MentionOption[],
  selectIndex: number,
): void {
  popup.innerHTML = matches
    .map(
      (
        m,
        i,
      ) => `<div class="mention-item${i === selectIndex ? " selected" : ""}" data-mention-username="${escapeHtml(m.username)}">
        <span class="mention-name">${escapeHtml(m.displayName || m.username)}</span>
        <span class="mention-sub">@${escapeHtml(m.username)}</span>
      </div>`,
    )
    .join("");
}

export function hideMentionPopup(popup: HTMLDivElement): void {
  popup.hidden = true;
  popup.innerHTML = "";
  uiContext.state.mentionAutocomplete = null;
}

export function applyMentionPick(
  input: HTMLInputElement,
  popup: HTMLDivElement,
  username: string,
): void {
  const caret = input.selectionStart ?? input.value.length;
  const head = input.value.slice(0, caret);
  const tail = input.value.slice(caret);
  const m = head.match(uiContext.MENTION_TOKEN_RE);
  if (!m) return;
  // Сохраняем разделитель перед `@` (или пустоту, если start of line).
  const prefixLen = m[0].length - 1 - m[1].length;
  const startOfToken = head.length - m[0].length + prefixLen;
  const replacement = "@" + username + " ";
  const newValue = input.value.slice(0, startOfToken) + replacement + tail;
  input.value = newValue;
  const newCaret = startOfToken + replacement.length;
  input.setSelectionRange(newCaret, newCaret);
  hideMentionPopup(popup);
  input.focus();
}

export function filterChannelMatches(query: string): Channel[] {
  const q = query.toLowerCase();
  const out: Channel[] = [];
  // Архивные тоже линкуются («доступен по прямой ссылке») — идут в конце.
  const ordered = [...uiContext.state.channels].sort(
    (a, b) =>
      Number(!!a.archivedAt) - Number(!!b.archivedAt) ||
      a.name.localeCompare(b.name),
  );
  for (const ch of ordered) {
    if (!uiContext.CHANNEL_LINKABLE_RE.test(ch.name)) continue;
    if (!ch.name.toLowerCase().startsWith(q)) continue;
    out.push(ch);
    if (out.length >= 8) break;
  }
  return out;
}

export function updateChannelPopup(
  input: HTMLInputElement,
  popup: HTMLDivElement,
): void {
  const caret = input.selectionStart ?? input.value.length;
  const head = input.value.slice(0, caret);
  const m = head.match(uiContext.CHANNEL_TOKEN_RE);
  if (!m) {
    hideChannelPopup(popup);
    return;
  }
  const query = m[1];
  const matches = filterChannelMatches(query);
  if (matches.length === 0) {
    hideChannelPopup(popup);
    return;
  }
  const prevIndex = uiContext.state.channelAutocomplete?.selectIndex ?? 0;
  const selectIndex = Math.min(prevIndex, matches.length - 1);
  uiContext.state.channelAutocomplete = { query, selectIndex };
  renderChannelPopupContent(popup, matches, selectIndex);
  popup.hidden = false;
}

export function renderChannelPopupContent(
  popup: HTMLDivElement,
  matches: Channel[],
  selectIndex: number,
): void {
  popup.innerHTML = matches
    .map(
      (
        ch,
        i,
      ) => `<div class="mention-item${i === selectIndex ? " selected" : ""}" data-channel-pick="${escapeHtml(ch.name)}">
        <span class="mention-name">${channelPrefix(ch)}${escapeHtml(ch.name)}</span>
        ${ch.archivedAt ? `<span class="mention-sub">${t("sidebar.archive")}</span>` : ch.topic ? `<span class="mention-sub">${escapeHtml(ch.topic)}</span>` : ""}
      </div>`,
    )
    .join("");
}

export function hideChannelPopup(popup: HTMLDivElement): void {
  popup.hidden = true;
  popup.innerHTML = "";
  uiContext.state.channelAutocomplete = null;
}

export function applyChannelPick(
  input: HTMLInputElement,
  popup: HTMLDivElement,
  name: string,
): void {
  const caret = input.selectionStart ?? input.value.length;
  const head = input.value.slice(0, caret);
  const tail = input.value.slice(caret);
  const m = head.match(uiContext.CHANNEL_TOKEN_RE);
  if (!m) return;
  const prefixLen = m[0].length - 1 - m[1].length;
  const startOfToken = head.length - m[0].length + prefixLen;
  const replacement = "#" + name + " ";
  input.value = input.value.slice(0, startOfToken) + replacement + tail;
  const newCaret = startOfToken + replacement.length;
  input.setSelectionRange(newCaret, newCaret);
  hideChannelPopup(popup);
  input.focus();
}

export function slowModeRemainingSec(channelId: string): number {
  const until = uiContext._slowModeUntil.get(channelId);
  if (!until) return 0;
  const remaining = Math.ceil((until - Date.now()) / 1000);
  if (remaining <= 0) {
    uiContext._slowModeUntil.delete(channelId);
    return 0;
  }
  return remaining;
}

export function setSlowMode(channelId: string, retryAfterSec: number): void {
  if (retryAfterSec <= 0) return;
  uiContext._slowModeUntil.set(channelId, Date.now() + retryAfterSec * 1000);
  ensureSlowModeTicker();
}

export function ensureSlowModeTicker(): void {
  if (uiContext._slowModeTickHandle) return;
  uiContext._slowModeTickHandle = setInterval(() => {
    // Чистим истекшие, проверяем нужен ли ещё тикер.
    let active = false;
    for (const [chId, until] of uiContext._slowModeUntil) {
      if (until - Date.now() <= 0) uiContext._slowModeUntil.delete(chId);
      else active = true;
    }
    if (!active) {
      if (uiContext._slowModeTickHandle)
        clearInterval(uiContext._slowModeTickHandle);
      uiContext._slowModeTickHandle = null;
    }
    // Обновляем только composer-инпут (placeholder) и submit-кнопку без render() —
    // иначе сорвался бы фокус и каретка композера.
    const input = uiContext.rootEl.querySelector<HTMLInputElement>(
      '#send-form input[name="body"]',
    );
    const submit = uiContext.rootEl.querySelector<HTMLButtonElement>(
      '#send-form button[type="submit"]',
    );
    if (input && uiContext.state.selectedChannelId) {
      const rem = slowModeRemainingSec(uiContext.state.selectedChannelId);
      const ch = uiContext.state.channels.find(
        (c) => c.id === uiContext.state.selectedChannelId,
      );
      if (rem > 0) {
        input.placeholder = `Медленный режим: ${rem}с до следующего сообщения`;
        if (submit) submit.disabled = true;
      } else if (ch) {
        input.placeholder = `Сообщение в #${ch.name}`;
        if (submit) submit.disabled = false;
      }
    }
  }, 1000);
}

// J.3(b): slow-mode error от backend'а (429 + slow-mode reason). Backend
// ставит CodeRateLimited на конкретно slow-mode-422 (см. message.handleCreate).
export function isSlowModeError(err: unknown): { retry: number } | null {
  const api = err as ApiError;
  if (!api || typeof api !== "object") return null;
  if (api.status !== 429) return null;
  if (api.code !== "rate_limited") return null;
  const msg = (api.message ?? "").toLowerCase();
  if (!msg.includes("slow mode")) return null;
  return { retry: api.retryAfter ?? 5 };
}

export function isBodyTooLongError(err: unknown): boolean {
  const api = err as ApiError;
  if (!api || typeof api !== "object") return false;
  const msg = typeof api.message === "string" ? api.message.toLowerCase() : "";
  return msg.includes("body too long");
}
