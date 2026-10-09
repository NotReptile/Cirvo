import { bindEvent, delegate } from "../dom";
import { describeError } from "../errors";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import { attachCreateForumPostHandlers } from "./channelCreate";
import { setTransientStatus } from "./helpers";
import {
  applyPttModeToActiveSessions,
  jumpToSearchHit,
  runSearch,
  selectChannel,
  togglePinsPopup,
} from "./loaders";
import { jumpToMessage } from "./messageList";

export function attachNavigationRegion(): void {
  uiContext.rootEl.querySelector<HTMLButtonElement>("#open-pins")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#open-pins"),
        "click",
        () => {
          const ch = uiContext.state.selectedChannelId;
          if (!ch) return;
          togglePinsPopup(ch);
        },
        "bind-435469",
      )
    : undefined;

  // Wave 9: форум. Открытие поста/родителя (карточка, breadcrumb) + модалка
  // «Новый пост».
  delegate<HTMLElement, "click">(
    uiContext.rootEl,
    "[data-ch-open]",
    "click",
    (_event, el) => {
      const id = el.dataset.chOpen;
      if (id) void selectChannel(id);
    },
    "delegate-436173",
  );
  uiContext.rootEl.querySelector<HTMLButtonElement>("#forum-new-post")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#forum-new-post"),
        "click",
        () => {
          const ch = uiContext.state.selectedChannelId;
          if (!ch) return;
          uiContext.state.createForumPost = {
            channelId: ch,
            title: "",
            body: "",
            saving: false,
            error: null,
          };
          uiContext.state.modal = "createForumPost";
          render();
          requestAnimationFrame(() => {
            uiContext.rootEl
              .querySelector<HTMLInputElement>("#forum-post-title")
              ?.focus();
          });
        },
        "bind-435936",
      )
    : undefined;
  attachCreateForumPostHandlers();

  // #4a: кнопка звонка в DM-хедере. Тот же placeCall, что из профиля/member-list.
  uiContext.rootEl.querySelector<HTMLButtonElement>("#dm-call")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#dm-call"),
        "click",
        async (ev) => {
          const userId = (ev.currentTarget as HTMLButtonElement).dataset.userId;
          if (!userId) return;
          if (uiContext.callMgr.isActive() || uiContext.voiceMgr.isActive()) {
            setTransientStatus("Уже в звонке");
            return;
          }
          try {
            await uiContext.callMgr.placeCall(userId);
            applyPttModeToActiveSessions();
          } catch (err) {
            uiContext.state.status = describeError(err);
            render();
          }
        },
        "bind-436483",
      )
    : undefined;

  delegate<HTMLDivElement, "click">(
    uiContext.rootEl,
    ".pin-row[data-pin-jump]",
    "click",
    (_event, row) => {
      const id = row.dataset.pinJump;
      if (!id) return;
      uiContext.state.pinsPopupOpen = false;
      render();
      void jumpToMessage(id);
    },
    "delegate-437413",
  );

  uiContext.rootEl.querySelector<HTMLButtonElement>("#open-search")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#open-search"),
        "click",
        () => {
          uiContext.state.modal = "search";
          uiContext.state.search = {
            query: uiContext.state.search.query,
            loading: false,
            hits: uiContext.state.search.hits,
            error: null,
          };
          render();
          // фокус и каретка в конец после render()
          const input =
            uiContext.rootEl.querySelector<HTMLInputElement>("#search-input");
          if (input) {
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          }
        },
        "bind-437875",
      )
    : undefined;

  // Debounce поиска на input. 200мс достаточно чтобы юзер допечатал
  // слово и сервер не молотил каждое нажатие. Прямой DOM-update inside
  // modal-body — иначе render() сбрасывал бы фокус и каретку.
  const searchInput =
    uiContext.rootEl.querySelector<HTMLInputElement>("#search-input");
  if (searchInput) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    bindEvent(
      searchInput,
      "input",
      () => {
        if (timer) clearTimeout(timer);
        const value = searchInput.value;
        timer = setTimeout(() => {
          void runSearch(value);
        }, 200);
      },
      "bind-438723",
    );
  }

  delegate<HTMLElement, "click">(
    uiContext.rootEl,
    ".search-hit",
    "click",
    (_event, el) => {
      const id = el.dataset.hitId;
      const ch = el.dataset.hitChannel;
      if (!id || !ch) return;
      const hit = uiContext.state.search.hits.find((h) => h.id === id);
      if (hit) void jumpToSearchHit(hit);
    },
    "delegate-439399",
  );
}
