import { bindEvent, delegate } from "../dom";
import { describeError } from "../errors";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import { applyPttModeToActiveSessions, openDMWith } from "./loaders";
import { openUserProfile } from "./profile";

export function attachMemberMenuRegion(): void {
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-member-action]",
    "click",
    async (_event, btn) => {
      const action = btn.dataset.memberAction;
      const userId = btn.dataset.id;
      if (!action || !userId) return;
      if (action === "profile") {
        uiContext.state.memberMenu = null;
        openUserProfile(userId);
        return;
      }
      if (action === "dm") {
        uiContext.state.memberMenu = null;
        void openDMWith({ userId });
        return;
      }
      if (action === "call") {
        uiContext.state.memberMenu = null;
        render();
        try {
          await uiContext.callMgr.placeCall(userId);
          applyPttModeToActiveSessions();
        } catch (err) {
          uiContext.state.status = describeError(err);
          render();
        }
        return;
      }
      if (action === "copy-id") {
        uiContext.state.memberMenu = null;
        try {
          await navigator.clipboard.writeText(userId);
          uiContext.state.status = "ID участника скопирован";
        } catch {
          uiContext.state.status = "Не удалось скопировать";
        }
        render();
        return;
      }
      if (action === "toggle-role") {
        // Меню НЕ закрываем — можно навесить несколько ролей подряд.
        const roleId = btn.dataset.roleId;
        const wsId = uiContext.state.selectedWorkspaceId;
        const role = uiContext.state.wsRoles.find((r) => r.id === roleId);
        if (!roleId || !wsId || !role) return;
        const has = role.memberUserIds.includes(userId);
        try {
          if (has) {
            await uiContext.httpClient.del(
              `/api/v1/workspaces/${wsId}/roles/${roleId}/members/${userId}`,
            );
            role.memberUserIds = role.memberUserIds.filter((x) => x !== userId);
          } else {
            await uiContext.httpClient.post(
              `/api/v1/workspaces/${wsId}/roles/${roleId}/members/${userId}`,
            );
            role.memberUserIds = [...role.memberUserIds, userId];
          }
          uiContext.userColorCache = null;
        } catch (err) {
          uiContext.state.status = describeError(err);
        }
        render();
        return;
      }
    },
    "delegate-446893",
  );

  uiContext.rootEl.querySelector<HTMLButtonElement>(".user-profile-dm")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(".user-profile-dm"),
        "click",
        (ev) => {
          const userId = (ev.currentTarget as HTMLButtonElement).dataset.userId;
          if (!userId) return;
          uiContext.state.modal = null;
          uiContext.state.userProfileTarget = null;
          void openDMWith({ userId });
        },
        "bind-448332",
      )
    : undefined;

  uiContext.rootEl.querySelector<HTMLButtonElement>(".user-profile-call")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(".user-profile-call"),
        "click",
        async (ev) => {
          const userId = (ev.currentTarget as HTMLButtonElement).dataset.userId;
          if (!userId) return;
          try {
            uiContext.state.modal = null;
            uiContext.state.userProfileTarget = null;
            await uiContext.callMgr.placeCall(userId);
            applyPttModeToActiveSessions();
          } catch (err) {
            uiContext.state.status = describeError(err);
            render();
          }
        },
        "bind-448631",
      )
    : undefined;

  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".member-call",
    "click",
    async (_event, btn) => {
      const userId = btn.dataset.userId;
      if (!userId) return;
      try {
        uiContext.state.modal = null;
        await uiContext.callMgr.placeCall(userId);
        applyPttModeToActiveSessions();
      } catch (err) {
        uiContext.state.status = describeError(err);
        render();
      }
    },
    "delegate-449705",
  );
}
