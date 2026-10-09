import { confirmDialog } from "../dialogs";
import { bindEvent, delegate } from "../dom";
import { describeError } from "../errors";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import { openDMWith } from "./loaders";
import { openUserProfile } from "./profile";

export function attachMembersRegion(): void {
  delegate<HTMLSelectElement, "change">(
    uiContext.rootEl,
    ".member-role",
    "change",
    async (_event, sel) => {
      if (!uiContext.state.selectedWorkspaceId) return;
      const userId = sel.dataset.userId;
      if (!userId) return;
      try {
        await uiContext.httpClient.patch(
          `/api/v1/workspaces/${uiContext.state.selectedWorkspaceId}/members/${userId}`,
          {
            role: sel.value,
          },
        );
        const idx = uiContext.state.members.findIndex(
          (m) => m.userId === userId,
        );
        if (idx >= 0)
          uiContext.state.members[idx] = {
            ...uiContext.state.members[idx],
            role: sel.value,
          };
        render();
      } catch (err) {
        uiContext.state.status = describeError(err);
        render();
      }
    },
    "delegate-442232",
  );

  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".member-kick",
    "click",
    async (_event, btn) => {
      if (!uiContext.state.selectedWorkspaceId) return;
      const userId = btn.dataset.userId;
      if (!userId) return;
      const ok = await confirmDialog({
        title: "Удалить участника",
        body: "Участник будет исключён из воркспейса. Его сообщения останутся.",
        confirmLabel: "Удалить",
        danger: true,
      });
      if (!ok) return;
      try {
        await uiContext.httpClient.del(
          `/api/v1/workspaces/${uiContext.state.selectedWorkspaceId}/members/${userId}`,
        );
        uiContext.state.members = uiContext.state.members.filter(
          (m) => m.userId !== userId,
        );
        render();
      } catch (err) {
        uiContext.state.status = describeError(err);
        render();
      }
    },
    "delegate-442911",
  );

  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".member-dm",
    "click",
    (_event, btn) => {
      const userId = btn.dataset.userId;
      if (!userId) return;
      uiContext.state.modal = null;
      void openDMWith({ userId });
    },
    "delegate-443705",
  );

  // Клик по карточке в member-sidebar → Discord-style profile-popup
  // с кнопками «Сообщение» и «Позвонить». Self-клик игнорится.
  uiContext.rootEl
    .querySelectorAll<HTMLElement>(".member-sidebar-item[data-member-user]")
    .forEach((el) => {
      bindEvent(
        el,
        "click",
        () => {
          const userId = el.getAttribute("data-member-user");
          if (!userId || userId === uiContext.state.me?.id) return;
          openUserProfile(userId);
        },
        "bind-443651",
      );
      // Wave 5: ПКМ по участнику — быстрые действия + назначение ролей.
      bindEvent(
        el,
        "contextmenu",
        (ev) => {
          ev.preventDefault();
          const userId = el.getAttribute("data-member-user");
          if (!userId) return;
          const x = Math.min(ev.clientX, window.innerWidth - 240);
          const y = Math.min(ev.clientY, window.innerHeight - 320);
          uiContext.state.memberMenu = { userId, x, y };
          render();
        },
        "bind-443914",
      );
    });

  uiContext.rootEl.querySelector<HTMLElement>("[data-member-menu-close]")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLElement>("[data-member-menu-close]"),
        "click",
        () => {
          uiContext.state.memberMenu = null;
          render();
        },
        "bind-444274",
      )
    : undefined;
}
