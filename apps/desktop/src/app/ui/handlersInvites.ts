import { bindEvent, delegate } from "../dom";
import { describeError } from "../errors";
import { inviteExpiresAt } from "../invites";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type { Invite } from "../types";
import { setTransientStatus } from "./helpers";
import { loadInvites } from "./loaders";

export function attachInvitesRegion(): void {
  uiContext.rootEl.querySelector<HTMLButtonElement>("#toggle-invites")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#toggle-invites"),
        "click",
        async (e) => {
          e.preventDefault();
          uiContext.state.invitesOpen = !uiContext.state.invitesOpen;
          if (uiContext.state.invitesOpen) {
            await loadInvites();
          } else {
            render();
          }
        },
        "bind-481447",
      )
    : undefined;

  uiContext.rootEl.querySelector<HTMLFormElement>("#create-invite")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLFormElement>("#create-invite"),
        "submit",
        async (e) => {
          e.preventDefault();
          if (!uiContext.state.selectedWorkspaceId) return;
          const form = e.currentTarget as HTMLFormElement;
          const data = new FormData(form);
          const maxUses = Number(data.get("maxUses") || 0);
          const expiresAt = inviteExpiresAt(data.get("ttl"));
          try {
            const inv = await uiContext.httpClient.post<Invite>(
              `/api/v1/workspaces/${uiContext.state.selectedWorkspaceId}/invites`,
              {
                maxUses,
                ...(expiresAt ? { expiresAt } : {}),
              },
            );
            uiContext.state.invites = [inv, ...uiContext.state.invites];
            form.reset();
            render();
          } catch (err) {
            uiContext.state.status = describeError(err);
            render();
          }
        },
        "bind-481716",
      )
    : undefined;

  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".invite-copy",
    "click",
    async (_event, btn) => {
      const code = btn.dataset.code ?? "";
      try {
        await navigator.clipboard.writeText(code);
        setTransientStatus("Код скопирован");
      } catch {
        uiContext.state.status = code;
        render();
      }
    },
    "delegate-483540",
  );

  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".invite-revoke",
    "click",
    async (_event, btn) => {
      const id = btn.dataset.invite;
      if (!id) return;
      try {
        await uiContext.httpClient.del(`/api/v1/invites/${id}`);
        uiContext.state.invites = uiContext.state.invites.filter(
          (i) => i.id !== id,
        );
        render();
      } catch (err) {
        uiContext.state.status = describeError(err);
        render();
      }
    },
    "delegate-483906",
  );
}
