import { bindEvent, delegate } from "../dom";
import { describeError } from "../errors";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type { Channel } from "../types";
import { onMessageListScroll } from "./composer";
import { selectChannel } from "./loaders";
import { jumpToMessage, updateMessageList } from "./messageList";

export function attachMessageNavigationRegion(): void {
  // «Ответить» в action-bar сообщения
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".action-reply",
    "click",
    (_event, btn) => {
      const id = btn.dataset.id;
      if (!id) return;
      const target = uiContext.state.messages.find((m) => m.id === id);
      if (!target) return;
      uiContext.state.replyingTo = {
        messageId: target.id,
        authorId: target.authorId,
        body: target.body.slice(0, 120),
      };
      render();
      // Возвращаем фокус в композер.
      uiContext.rootEl
        .querySelector<HTMLInputElement>('#send-form input[name="body"]')
        ?.focus();
    },
    "delegate-508634",
  );
  uiContext.rootEl.querySelector<HTMLButtonElement>(".reply-cancel")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(".reply-cancel"),
        "click",
        () => {
          uiContext.state.replyingTo = null;
          render();
        },
        "bind-507860",
      )
    : undefined;

  // Wave 10: «Тред» из сообщения. Endpoint идемпотентен: если тред уже
  // есть (гонка с другим клиентом) — бэк вернёт существующий, открываем его.
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".action-thread",
    "click",
    async (_event, btn) => {
      const messageId = btn.dataset.id;
      const channelId = uiContext.state.selectedChannelId;
      if (!messageId || !channelId) return;
      try {
        const thread = await uiContext.httpClient.post<Channel>(
          `/api/v1/channels/${channelId}/messages/${messageId}/thread`,
          {},
        );
        if (!uiContext.state.channels.some((c) => c.id === thread.id)) {
          uiContext.state.channels = [...uiContext.state.channels, thread];
        }
        await selectChannel(thread.id);
      } catch (err) {
        uiContext.state.status = describeError(err);
        render();
      }
    },
    "delegate-509493",
  );

  // Клик на reply-snippet — прыжок к исходному сообщению (если оно в DOM).
  delegate<HTMLElement, "click">(
    uiContext.rootEl,
    ".reply-snippet[data-jump-id]",
    "click",
    (_event, el) => {
      const id = el.dataset.jumpId;
      if (!id) return;
      void jumpToMessage(id);
    },
    "delegate-510270",
  );

  uiContext.rootEl.querySelector<HTMLButtonElement>("#jump-to-unread")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#jump-to-unread"),
        "click",
        () => {
          const cutoff = Date.parse(
            uiContext.state.selectedChannelLastReadAt ?? "",
          );
          const unread = uiContext.state.messages.find(
            (m) =>
              Date.parse(m.createdAt) > cutoff &&
              m.authorId !== uiContext.state.me?.id,
          );
          if (unread) void jumpToMessage(unread.id);
          else {
            uiContext.state.windowStart = null;
            uiContext.state.stickToBottom = true;
            updateMessageList();
          }
        },
        "bind-509398",
      )
    : undefined;

  const list = uiContext.rootEl.querySelector<HTMLDivElement>("#message-list");
  if (list) {
    // C.4: восстановление позиции либо приклеивание к низу.
    if (uiContext.state.restoreScrollBottom !== null) {
      list.scrollTop =
        list.scrollHeight -
        list.clientHeight -
        uiContext.state.restoreScrollBottom;
      uiContext.state.restoreScrollBottom = null;
    } else if (uiContext.state.stickToBottom) {
      list.scrollTop = list.scrollHeight;
    }
    // После выставления scrollTop вешаем listener — иначе наш же
    // программный скролл триггерит пересчёт stickToBottom от нулевой высоты.
    bindEvent(list, "scroll", onMessageListScroll, "bind-510368");
    bindEvent(
      list,
      "click",
      (ev) => {
        const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>(
          "[data-spoiler]",
        );
        if (target && !target.classList.contains("revealed")) {
          target.classList.add("revealed");
          ev.stopPropagation();
          return;
        }
        // Wave 8: клик по #channel-ссылке — переход в канал (включая архивные).
        const chLink = (ev.target as HTMLElement | null)?.closest<HTMLElement>(
          "[data-channel-link]",
        );
        const chId = chLink?.dataset.channelLink;
        if (chId && chId !== uiContext.state.selectedChannelId) {
          ev.stopPropagation();
          void selectChannel(chId);
        }
      },
      "bind-510426",
    );
  }
}
