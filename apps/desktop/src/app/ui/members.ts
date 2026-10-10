import { bindEvent } from "../dom";
import { describeError } from "../errors";
import { t } from "../i18n";
import { icon } from "../icons";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type { Channel, ChannelCategory, Member } from "../types";
import { escapeHtml } from "../util/html";
import { canWorkspace } from "./capabilities";

export function renderMembersModal(): string {
  const ws = uiContext.state.workspaces.find(
    (w) => w.id === uiContext.state.selectedWorkspaceId,
  );
  if (!ws) return "";
  const canManageRole = canWorkspace("member.manage_role", ws.id);
  const canKick = canWorkspace("member.kick", ws.id);
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide" role="dialog">
        <div class="modal-header">
          <h3>${t("modal.members")} · ${escapeHtml(ws.name)}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="modal-body">
          ${
            uiContext.state.membersLoading
              ? `<div class="invites-empty">${t("common.loading")}</div>`
              : `<table class="members-table">
                  <thead><tr><th>${t("members.table.user")}</th><th>${t("members.table.role")}</th><th></th></tr></thead>
                  <tbody>
                    ${uiContext.state.members
                      .map((m) =>
                        renderMemberRow(m, ws.ownerId, canManageRole, canKick),
                      )
                      .join("")}
                  </tbody>
                </table>`
          }
        </div>
      </div>
    </div>
  `;
}

export function renderMemberRow(
  m: Member,
  ownerId: string,
  canManageRole: boolean,
  canKick: boolean,
): string {
  const isOwner = m.userId === ownerId;
  const isSelf = m.userId === uiContext.state.me?.id;
  const roleOptions = ["admin", "moderator", "member"];
  const showRoleSelect = canManageRole && !isOwner && !isSelf;
  const showKick = canKick && !isOwner && !isSelf;
  const showCall = !isSelf && uiContext.state.callSnapshot === null;
  return `
    <tr data-member="${m.userId}">
      <td>
        <div class="member-name">${escapeHtml(m.displayName || m.username)}</div>
        <div class="member-sub">@${escapeHtml(m.username)}</div>
      </td>
      <td>
        ${
          showRoleSelect
            ? `<select class="member-role" data-user-id="${m.userId}">
                ${roleOptions
                  .map(
                    (r) =>
                      `<option value="${r}"${r === m.role ? " selected" : ""}>${escapeHtml(r)}</option>`,
                  )
                  .join("")}
              </select>`
            : `<span class="role-badge role-${escapeHtml(m.role)}">${escapeHtml(m.role)}</span>`
        }
      </td>
      <td>
        ${!isSelf ? `<button class="ghost member-dm" data-user-id="${m.userId}" data-tooltip="Личное сообщение">${icon("reply")}</button>` : ""}
        ${showCall ? `<button class="ghost member-call" data-user-id="${m.userId}" data-tooltip="Позвонить">${icon("phone")}</button>` : ""}
        ${showKick ? `<button class="ghost member-kick" data-user-id="${m.userId}" data-tooltip="Удалить">${icon("trash")}</button>` : ""}
      </td>
    </tr>
  `;
}

export function attachDragReorderHandlers(): void {
  // --- Channel drag ---
  uiContext.rootEl
    .querySelectorAll<HTMLLIElement>('[data-ch][draggable="true"]')
    .forEach((li) => {
      bindEvent(
        li,
        "dragstart",
        (e) => {
          const id = li.dataset.ch;
          if (!id) return;
          uiContext._dragKind = "channel";
          uiContext._dragId = id;
          e.dataTransfer?.setData("text/plain", id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
          li.classList.add("drag-source");
        },
        "bind-421883",
      );
      bindEvent(
        li,
        "dragend",
        () => {
          uiContext._dragKind = null;
          uiContext._dragId = null;
          li.classList.remove("drag-source");
          uiContext.rootEl
            .querySelectorAll(".drop-before, .drop-after")
            .forEach((el) => el.classList.remove("drop-before", "drop-after"));
        },
        "bind-422194",
      );
      bindEvent(
        li,
        "dragover",
        (e) => {
          if (uiContext._dragKind !== "channel") return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          const rect = li.getBoundingClientRect();
          const after = e.clientY > rect.top + rect.height / 2;
          li.classList.toggle("drop-after", after);
          li.classList.toggle("drop-before", !after);
        },
        "bind-422459",
      );
      bindEvent(
        li,
        "dragleave",
        () => {
          li.classList.remove("drop-before", "drop-after");
        },
        "bind-422848",
      );
      bindEvent(
        li,
        "drop",
        (e) => {
          if (uiContext._dragKind !== "channel" || !uiContext._dragId) return;
          e.preventDefault();
          const targetId = li.dataset.ch;
          const targetCatId = li.dataset.catId || null;
          const rect = li.getBoundingClientRect();
          const after = e.clientY > rect.top + rect.height / 2;
          li.classList.remove("drop-before", "drop-after");
          if (targetId && targetId !== uiContext._dragId) {
            void moveChannelTo(uiContext._dragId, targetCatId, targetId, after);
          }
        },
        "bind-422957",
      );
    });

  // --- Drop канала на заголовок категории = переместить канал в начало
  //     этой категории. ---
  uiContext.rootEl
    .querySelectorAll<HTMLDivElement>("[data-cat-drag]")
    .forEach((header) => {
      bindEvent(
        header,
        "dragstart",
        (e) => {
          const id = header.dataset.catDrag;
          if (!id) return;
          uiContext._dragKind = "category";
          uiContext._dragId = id;
          e.dataTransfer?.setData("text/plain", id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
          header.classList.add("drag-source");
        },
        "bind-423653",
      );
      bindEvent(
        header,
        "dragend",
        () => {
          uiContext._dragKind = null;
          uiContext._dragId = null;
          header.classList.remove("drag-source");
          uiContext.rootEl
            .querySelectorAll(".drop-before, .drop-after")
            .forEach((el) => el.classList.remove("drop-before", "drop-after"));
        },
        "bind-423982",
      );
      bindEvent(
        header,
        "dragover",
        (e) => {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          if (uiContext._dragKind === "channel") {
            // Канал на категорию — подсветим целиком.
            header.classList.add("drop-after");
          } else if (uiContext._dragKind === "category") {
            const rect = header.getBoundingClientRect();
            const after = e.clientY > rect.top + rect.height / 2;
            header.classList.toggle("drop-after", after);
            header.classList.toggle("drop-before", !after);
          }
        },
        "bind-424255",
      );
      bindEvent(
        header,
        "dragleave",
        () => {
          header.classList.remove("drop-before", "drop-after");
        },
        "bind-424810",
      );
      bindEvent(
        header,
        "drop",
        (e) => {
          e.preventDefault();
          const targetCatId = header.dataset.catDrag;
          header.classList.remove("drop-before", "drop-after");
          if (!targetCatId || !uiContext._dragId) return;
          if (uiContext._dragKind === "channel") {
            void moveChannelTo(uiContext._dragId, targetCatId, null, false);
          } else if (
            uiContext._dragKind === "category" &&
            uiContext._dragId !== targetCatId
          ) {
            const rect = header.getBoundingClientRect();
            const after = e.clientY > rect.top + rect.height / 2;
            void moveCategoryTo(uiContext._dragId, targetCatId, after);
          }
        },
        "bind-424927",
      );
    });
}

export async function moveChannelTo(
  channelId: string,
  newCategoryId: string | null,
  beforeChannelId: string | null,
  insertAfter: boolean,
): Promise<void> {
  const ch = uiContext.state.channels.find((c) => c.id === channelId);
  if (!ch) return;
  // Сначала optimistic: уберём из старого места, вставим в новое, renumber'нём
  // позиции в затронутых категориях. PATCH'и шлём в фоне.
  const oldCategoryId = ch.categoryId ?? null;
  // Все каналы целевой категории в текущем порядке.
  const targetSiblings = uiContext.state.channels
    .filter(
      (c) => (c.categoryId ?? null) === newCategoryId && c.id !== channelId,
    )
    .sort((a, b) => a.position - b.position);
  let insertIdx: number;
  if (beforeChannelId) {
    insertIdx = targetSiblings.findIndex((c) => c.id === beforeChannelId);
    if (insertIdx < 0) insertIdx = targetSiblings.length;
    else if (insertAfter) insertIdx += 1;
  } else {
    insertIdx = 0;
  }
  const newOrder = [
    ...targetSiblings.slice(0, insertIdx),
    ch,
    ...targetSiblings.slice(insertIdx),
  ];
  // Renumber: position = (idx + 1) * 100.
  const updates: {
    id: string;
    position: number;
    categoryId?: string | null;
  }[] = [];
  newOrder.forEach((c, idx) => {
    const newPos = (idx + 1) * 100;
    const needsUpdate =
      c.id === channelId
        ? c.position !== newPos || (c.categoryId ?? null) !== newCategoryId
        : c.position !== newPos;
    if (needsUpdate) {
      updates.push({
        id: c.id,
        position: newPos,
        categoryId: c.id === channelId ? newCategoryId : undefined,
      });
    }
  });
  // Optimistic local update.
  uiContext.state.channels = uiContext.state.channels.map((c) => {
    if (c.id === channelId) {
      const newPos = (newOrder.indexOf(ch) + 1) * 100;
      return { ...c, categoryId: newCategoryId, position: newPos };
    }
    const u = updates.find((x) => x.id === c.id);
    if (u) return { ...c, position: u.position };
    return c;
  });
  // Если канал ушёл из старой категории, та категория тоже может потребовать renumber'а
  // (между бывшими соседями появилась "дыра", но позиции остаются монотонными — не страшно).
  void oldCategoryId;
  render();
  // PATCH-flush в фоне.
  for (const u of updates) {
    const body: Record<string, unknown> = { position: u.position };
    if (u.categoryId !== undefined) body.categoryId = u.categoryId ?? "";
    try {
      await uiContext.httpClient.patch<Channel>(
        `/api/v1/channels/${u.id}`,
        body,
      );
    } catch (err) {
      uiContext.state.status = describeError(err);
      render();
      return;
    }
  }
}

export async function moveCategoryTo(
  categoryId: string,
  targetCategoryId: string,
  insertAfter: boolean,
): Promise<void> {
  const cats = [...uiContext.state.categories].sort(
    (a, b) => a.position - b.position,
  );
  const fromIdx = cats.findIndex((c) => c.id === categoryId);
  if (fromIdx < 0) return;
  const [moved] = cats.splice(fromIdx, 1);
  let toIdx = cats.findIndex((c) => c.id === targetCategoryId);
  if (toIdx < 0) toIdx = cats.length;
  else if (insertAfter) toIdx += 1;
  cats.splice(toIdx, 0, moved);
  const updates: { id: string; position: number }[] = [];
  cats.forEach((c, idx) => {
    const newPos = (idx + 1) * 100;
    if (c.position !== newPos) updates.push({ id: c.id, position: newPos });
  });
  uiContext.state.categories = cats.map((c, idx) => ({
    ...c,
    position: (idx + 1) * 100,
  }));
  render();
  for (const u of updates) {
    try {
      await uiContext.httpClient.patch<ChannelCategory>(
        `/api/v1/categories/${u.id}`,
        { position: u.position },
      );
    } catch (err) {
      uiContext.state.status = describeError(err);
      render();
      return;
    }
  }
}
