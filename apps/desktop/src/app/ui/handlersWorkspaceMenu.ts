import { confirmDialog } from "../dialogs";
import { bindEvent, delegate } from "../dom";
import { describeError } from "../errors";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type { NotifLevel, PendingUpload, Workspace } from "../types";
import { setWorkspaceNotifLevel } from "./loaders";
import {
  attachWorkspaceRolesHandlers,
  openWelcomeChannelModal,
  openWorkspaceRolesModal,
  saveWelcomeChannel,
} from "./workspaceRoles";

export function attachWorkspaceMenuRegion(): void {
  uiContext.rootEl.querySelector<HTMLElement>("[data-channel-menu-close]")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLElement>(
          "[data-channel-menu-close]",
        ),
        "click",
        () => {
          uiContext.state.channelMenu = null;
          render();
        },
        "bind-463668",
      )
    : undefined;

  uiContext.rootEl.querySelector<HTMLElement>("[data-workspace-menu-close]")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLElement>(
          "[data-workspace-menu-close]",
        ),
        "click",
        () => {
          uiContext.state.workspaceMenu = null;
          render();
        },
        "bind-463819",
      )
    : undefined;

  // H.2: ПКМ-меню воркспейса — загрузка/удаление иконки + copy ID.
  // Upload — двухступенчатый: POST /uploads (existing media-pipeline,
  // переиспользует квоты и MinIO-store), затем PUT /workspaces/{id}/avatar
  // с полученным mediaId. Все права проверяет бэк.
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-workspace-action]",
    "click",
    async (_event, btn) => {
      const action = btn.dataset.workspaceAction;
      const id = btn.dataset.id;
      if (!id || !action) return;
      uiContext.state.workspaceMenu = null;
      const ws = uiContext.state.workspaces.find((w) => w.id === id);
      if (!ws) {
        render();
        return;
      }
      if (action === "copy-id") {
        try {
          await navigator.clipboard.writeText(id);
          uiContext.state.status = `ID воркспейса «${ws.name}» скопирован`;
        } catch {
          uiContext.state.status = "Не удалось скопировать";
        }
        render();
        return;
      }
      if (action === "notif") {
        const level = (btn.dataset.level ?? "") as NotifLevel | "";
        void setWorkspaceNotifLevel(id, level);
        return;
      }
      if (action === "remove-icon") {
        const ok = await confirmDialog({
          title: "Удалить иконку",
          body: `Удалить иконку воркспейса «${ws.name}»?`,
          confirmLabel: "Удалить",
          danger: true,
        });
        if (!ok) {
          render();
          return;
        }
        try {
          const updated = await uiContext.httpClient.del<Workspace>(
            `/api/v1/workspaces/${id}/avatar`,
          );
          uiContext.state.workspaces = uiContext.state.workspaces.map((w) =>
            w.id === id ? { ...w, avatarMediaId: updated.avatarMediaId } : w,
          );
        } catch (err) {
          uiContext.state.status = describeError(err);
        }
        render();
        return;
      }
      if (action === "upload-icon") {
        const input = uiContext.rootEl.querySelector<HTMLInputElement>(
          "#workspace-avatar-input",
        );
        if (!input) {
          render();
          return;
        }
        input.onchange = async () => {
          const file = input.files?.[0];
          input.value = "";
          if (!file) return;
          try {
            const uploaded =
              await uiContext.httpClient.uploadFile<PendingUpload>(
                "/api/v1/uploads",
                file,
              );
            const updated = await uiContext.httpClient.put<Workspace>(
              `/api/v1/workspaces/${id}/avatar`,
              { mediaId: uploaded.id },
            );
            uiContext.state.workspaces = uiContext.state.workspaces.map((w) =>
              w.id === id ? { ...w, avatarMediaId: updated.avatarMediaId } : w,
            );
            uiContext.state.status = `Иконка воркспейса «${ws.name}» обновлена`;
          } catch (err) {
            uiContext.state.status = describeError(err);
          }
          render();
        };
        input.click();
        return;
      }
      if (action === "manage-roles") {
        await openWorkspaceRolesModal(id);
        return;
      }
      if (action === "welcome-channel") {
        await openWelcomeChannelModal(id);
        return;
      }
    },
    "delegate-465177",
  );

  attachWorkspaceRolesHandlers();

  uiContext.rootEl.querySelector<HTMLButtonElement>("#welcome-channel-save")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#welcome-channel-save",
        ),
        "click",
        () => {
          const sel = uiContext.rootEl.querySelector<HTMLSelectElement>(
            "#welcome-channel-select",
          );
          const wsId = uiContext.state.selectedWorkspaceId;
          if (!sel || !wsId) return;
          void saveWelcomeChannel(wsId, sel.value || null);
        },
        "bind-466952",
      )
    : undefined;

  uiContext.rootEl.querySelector<HTMLButtonElement>("#toggle-member-sidebar")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#toggle-member-sidebar",
        ),
        "click",
        () => {
          uiContext.state.memberSidebarOpen =
            !uiContext.state.memberSidebarOpen;
          render();
        },
        "bind-467274",
      )
    : undefined;
}
