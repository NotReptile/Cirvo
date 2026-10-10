import { confirmDialog } from "../dialogs";
import { bindEvent, delegate } from "../dom";
import { describeError } from "../errors";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type { FriendsTab } from "../types";
import { describePeer } from "./callView";
import { setTransientStatus } from "./helpers";
import {
  friendAction,
  loadFriends,
  openDMWith,
  selectChannel,
  sendFriendRequest,
} from "./loaders";
import { openUserProfile } from "./profile";

export function attachFriendsRegion(): void {
  // G.8: клик на DM-айтем в sidebar или home-карточку
  delegate<HTMLElement, "click">(
    uiContext.rootEl,
    "[data-dm]",
    "click",
    (ev, el) => {
      // Игнорим клик на кнопке закрытия — обрабатывается отдельным listener'ом.
      if ((ev.target as HTMLElement).closest("[data-dm-close]")) return;
      const id = el.dataset.dm;
      if (id && id !== uiContext.state.selectedChannelId)
        void selectChannel(id);
    },
    "delegate-457223",
  );

  // Скрытие DM из списка (клиентский UX-фильтр; backend всё ещё хранит канал,
  // в любой момент можно открыть заново через find). Не путать с «удалить
  // DM навсегда» — этого нет ни на бэке, ни в Discord-like UX.
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-dm-close]",
    "click",
    (ev, btn) => {
      ev.stopPropagation();
      const id = btn.dataset.dmClose;
      if (!id) return;
      uiContext.state.dms = uiContext.state.dms.filter(
        (d) => d.channelId !== id,
      );
      if (uiContext.state.selectedChannelId === id) {
        uiContext.state.selectedChannelId = null;
        uiContext.state.messages = [];
      }
      // Не пересчитываем dmUnreadTotal — скрытый DM продолжит приходить
      // через realtime и заново появится при openDMWith или dm.opened.
      render();
    },
    "delegate-457827",
  );

  // Кнопка «+» в DM-sidebar — сбросить выбор и показать home (фокус инпута).
  uiContext.rootEl.querySelector<HTMLButtonElement>("#dm-find-btn")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#dm-find-btn"),
        "click",
        () => {
          uiContext.state.selectedChannelId = null;
          uiContext.state.messages = [];
          uiContext.state.dmFindError = null;
          render();
          uiContext.rootEl
            .querySelector<HTMLInputElement>("#dm-find-input")
            ?.focus();
        },
        "bind-457766",
      )
    : undefined;

  // Форма «Найти или начать беседу» на home-экране DM.
  const dmFindForm =
    uiContext.rootEl.querySelector<HTMLFormElement>("#dm-find-form");
  const dmFindInput =
    uiContext.rootEl.querySelector<HTMLInputElement>("#dm-find-input");
  if (dmFindForm && dmFindInput) {
    bindEvent(
      dmFindInput,
      "input",
      () => {
        uiContext.state.dmFindQuery = dmFindInput.value;
        // не вызываем render(), чтобы не сбросить каретку — query фиксируется при submit
      },
      "bind-458292",
    );
    bindEvent(
      dmFindForm,
      "submit",
      (ev) => {
        ev.preventDefault();
        const raw = dmFindInput.value.trim().toLowerCase().replace(/^@/, "");
        if (!raw) {
          uiContext.state.dmFindError = "Введи username";
          render();
          return;
        }
        void openDMWith({ username: raw });
      },
      "bind-458483",
    );
  }

  // Wave 3: друзья — форма добавления, табы, действия per-row.
  uiContext.rootEl.querySelector<HTMLFormElement>("#friend-add-form")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLFormElement>("#friend-add-form"),
        "submit",
        (ev) => {
          ev.preventDefault();
          const input =
            uiContext.rootEl.querySelector<HTMLInputElement>(
              "#friend-add-input",
            );
          const username =
            input?.value.trim().toLowerCase().replace(/^@/, "") ?? "";
          if (!username) return;
          if (input) input.value = "";
          void sendFriendRequest(username);
        },
        "bind-458861",
      )
    : undefined;
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-friends-tab]",
    "click",
    (_event, btn) => {
      uiContext.state.friendsTab = btn.dataset.friendsTab as FriendsTab;
      uiContext.state.friendAddError = null;
      uiContext.state.friendAddOk = null;
      render();
    },
    "delegate-459962",
  );
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-friend-accept]",
    "click",
    (ev, btn) => {
      ev.stopPropagation();
      void friendAction(btn.dataset.friendAccept!, "accept");
    },
    "delegate-460250",
  );
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-friend-remove]",
    "click",
    (ev, btn) => {
      ev.stopPropagation();
      void friendAction(btn.dataset.friendRemove!, "remove");
    },
    "delegate-460486",
  );
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-friend-remove-confirm]",
    "click",
    async (ev, btn) => {
      ev.stopPropagation();
      const userId = btn.dataset.friendRemoveConfirm!;
      const ok = await confirmDialog({
        title: "Удалить из друзей",
        body: `Убрать ${describePeer(userId)} из друзей?`,
        confirmLabel: "Удалить",
        danger: true,
      });
      if (ok) void friendAction(userId, "remove");
    },
    "delegate-460722",
  );
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-friend-unblock]",
    "click",
    (ev, btn) => {
      ev.stopPropagation();
      void friendAction(btn.dataset.friendUnblock!, "unblock");
    },
    "delegate-461214",
  );
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-friend-msg]",
    "click",
    (ev, btn) => {
      ev.stopPropagation();
      void openDMWith({ userId: btn.dataset.friendMsg! });
    },
    "delegate-461453",
  );
  delegate<HTMLElement, "click">(
    uiContext.rootEl,
    "[data-friend-profile]",
    "click",
    (event, row) => {
      // Delegated root listeners share the same target; stopPropagation on an
      // action button does not prevent this row listener from running.
      if ((event.target as Element | null)?.closest("button, a, input, select, textarea")) return;
      openUserProfile(row.dataset.friendProfile!, row);
    },
    "delegate-461683",
  );
  // Collapse-плашка сообщения заблокированного — клик раскрывает.
  delegate<HTMLElement, "click">(
    uiContext.rootEl,
    "[data-reveal-blocked]",
    "click",
    (_event, el) => {
      uiContext.state.revealedBlocked.add(el.dataset.revealBlocked!);
      render();
    },
    "delegate-461940",
  );
  // Profile-popup: добавить в друзья / заблокировать.
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-friend-add]",
    "click",
    (ev, btn) => {
      ev.stopPropagation();
      void (async () => {
        try {
          await uiContext.httpClient.post("/api/v1/friends/requests", {
            userId: btn.dataset.friendAdd,
          });
          setTransientStatus("Заявка в друзья отправлена");
          await loadFriends();
        } catch (err) {
          uiContext.state.status = describeError(err);
          render();
        }
      })();
    },
    "delegate-462208",
  );
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-friend-block]",
    "click",
    async (ev, btn) => {
      ev.stopPropagation();
      const userId = btn.dataset.friendBlock!;
      const ok = await confirmDialog({
        title: "Заблокировать пользователя",
        body: `${describePeer(userId)} не сможет писать вам в ЛС и звонить, а его сообщения в общих каналах будут свёрнуты. Он об этом не узнает.`,
        confirmLabel: "Заблокировать",
        danger: true,
      });
      if (ok) void friendAction(userId, "block");
    },
    "delegate-462717",
  );
  // Wave 3: приватная заметка в profile-popup. Кеш — чтобы re-render'ы
  // попапа не дёргали GET повторно; PUT на change (blur).
  const noteEl =
    uiContext.rootEl.querySelector<HTMLTextAreaElement>("#user-note-input");
  if (noteEl) {
    const noteUserId = noteEl.dataset.noteUser!;
    if (uiContext.userNoteCache.has(noteUserId)) {
      if (!noteEl.value)
        noteEl.value = uiContext.userNoteCache.get(noteUserId)!;
    } else {
      uiContext.userNoteCache.set(noteUserId, "");
      void uiContext.httpClient
        .get<{ note: string }>(`/api/v1/users/${noteUserId}/note`)
        .then((res) => {
          uiContext.userNoteCache.set(noteUserId, res.note ?? "");
          const fresh = uiContext.rootEl.querySelector<HTMLTextAreaElement>(
            `#user-note-input[data-note-user="${CSS.escape(noteUserId)}"]`,
          );
          if (fresh && !fresh.value) fresh.value = res.note ?? "";
        })
        .catch(() => {
          /* нет заметки/сети — оставляем пустую */
        });
    }
    bindEvent(
      noteEl,
      "change",
      () => {
        const text = noteEl.value.trim();
        uiContext.userNoteCache.set(noteUserId, text);
        void uiContext.httpClient
          .put(`/api/v1/users/${noteUserId}/note`, { note: text })
          .then(() => setTransientStatus("Заметка сохранена"))
          .catch((err) => {
            uiContext.state.status = describeError(err);
            render();
          });
      },
      "bind-463277",
    );
  }
}
