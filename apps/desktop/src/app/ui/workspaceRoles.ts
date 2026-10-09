import { confirmDialog, promptDialog } from "../dialogs";
import { bindEvent, delegate } from "../dom";
import { describeError } from "../errors";
import { t } from "../i18n";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type { Workspace, WorkspaceRole } from "../types";
import { escapeHtml } from "../util/html";
import { loadMembers, slugify } from "./loaders";
import { selectWorkspace } from "./session";

// H.9: модалка выбора welcome-канала. state.workspaces содержит
// welcomeChannelId — отрисовываем select из text-каналов воркспейса.
export function renderWelcomeChannelModal(): string {
  const ws = uiContext.state.workspaces.find(
    (w) => w.id === uiContext.state.selectedWorkspaceId,
  );
  if (!ws) return "";
  const textChannels = uiContext.state.channels.filter(
    (c) => c.workspaceId === ws.id && c.kind === "text",
  );
  const current = ws.welcomeChannelId ?? "";
  const opts = textChannels
    .map(
      (c) =>
        `<option value="${c.id}"${c.id === current ? " selected" : ""}>#${escapeHtml(c.name)}</option>`,
    )
    .join("");
  return `
    <div class="modal-backdrop" data-modal-close></div>
    <div class="modal welcome-channel-modal" role="dialog" aria-modal="true">
      <header class="modal-header">
        <h3>Канал приветствия</h3>
        <button class="ghost" data-modal-close aria-label="Закрыть">✕</button>
      </header>
      <div class="modal-body">
        <p class="modal-hint">Сюда будет приходить плашка «X присоединился к серверу», когда новый участник принимает инвайт.</p>
        <label class="welcome-channel-field">
          <span>Канал</span>
          <select id="welcome-channel-select" class="listbox">
            <option value=""${current === "" ? " selected" : ""}>— не присылать —</option>
            ${opts}
          </select>
        </label>
      </div>
      <footer class="modal-footer">
        <button class="ghost" data-modal-close>Отмена</button>
        <button id="welcome-channel-save" class="primary">Сохранить</button>
      </footer>
    </div>
  `;
}

export async function openWelcomeChannelModal(
  workspaceId: string,
): Promise<void> {
  if (uiContext.state.selectedWorkspaceId !== workspaceId) {
    await selectWorkspace(workspaceId);
  }
  uiContext.state.modal = "welcomeChannel";
  render();
}

export async function saveWelcomeChannel(
  workspaceId: string,
  channelId: string | null,
): Promise<void> {
  try {
    const updated = await uiContext.httpClient.put<Workspace>(
      `/api/v1/workspaces/${workspaceId}/welcome-channel`,
      { channelId: channelId || null },
    );
    uiContext.state.workspaces = uiContext.state.workspaces.map((w) =>
      w.id === workspaceId
        ? { ...w, welcomeChannelId: updated.welcomeChannelId }
        : w,
    );
    uiContext.state.modal = null;
    uiContext.state.status = channelId
      ? "Канал приветствия обновлён"
      : "Канал приветствия отключён";
  } catch (err) {
    uiContext.state.status = describeError(err);
  }
  render();
}

export function renderWorkspaceRolesModal(): string {
  const rs = uiContext.state.workspaceRoles;
  const ws = uiContext.state.workspaces.find((w) => w.id === rs.workspaceId);
  if (!ws) return "";
  const selected = rs.roles.find((r) => r.id === rs.selectedRoleId);
  const draft = rs.draft;

  const list = `
    <div class="roles-list">
      <div class="roles-list-header">
        <span>Роли</span>
        <button id="role-create" class="ghost" data-tooltip="Создать роль">+</button>
      </div>
      <ul>
        ${rs.roles
          .map(
            (r) => `
          <li class="roles-list-item ${r.id === rs.selectedRoleId ? "active" : ""}" data-select-role="${r.id}" draggable="true" data-tooltip="Перетащи, чтобы изменить позицию">
            <span class="role-color-dot" style="background:${r.color ?? "var(--text-mute)"};"></span>
            <span class="role-name">${escapeHtml(r.name)}</span>
            ${r.system ? `<span class="role-badge">sys</span>` : ""}
            ${r.hoisted ? `<span class="role-badge">★</span>` : ""}
            <span class="role-count">${r.memberUserIds.length}</span>
          </li>
        `,
          )
          .join("")}
      </ul>
    </div>
  `;

  const detail = (() => {
    if (!selected || !draft)
      return `<div class="roles-empty">Выберите роль или создайте новую</div>`;
    const dirty =
      draft.name !== selected.name ||
      draft.color !== (selected.color ?? "") ||
      draft.position !== selected.position ||
      draft.hoisted !== selected.hoisted ||
      JSON.stringify([...draft.baseActionMask].sort()) !==
        JSON.stringify([...selected.baseActionMask].sort());
    return `
      <div class="roles-detail">
        <div class="roles-detail-header">
          <input id="role-name" class="role-name-input" value="${escapeHtml(draft.name)}" maxlength="64" ${selected.system && selected.code === "owner" ? "disabled" : ""} />
          <span class="role-code-hint">code: ${escapeHtml(selected.code)}${selected.system ? " · system" : ""}</span>
        </div>
        <div class="roles-detail-row">
          <label class="role-field">
            <span>Цвет</span>
            <input id="role-color" type="color" value="${escapeHtml(draft.color || "#888888")}" />
            ${draft.color ? `<button id="role-color-clear" class="ghost" data-tooltip="Без цвета">✕</button>` : ""}
          </label>
          <label class="role-field">
            <span>Позиция</span>
            <input id="role-position" type="number" min="0" step="1" value="${draft.position}" />
          </label>
          <label class="role-field role-field-check">
            <input id="role-hoisted" type="checkbox" ${draft.hoisted ? "checked" : ""} />
            <span>Отдельная секция в списке участников</span>
          </label>
        </div>
        <div class="roles-detail-section">
          <div class="roles-section-title">Права</div>
          <div class="roles-actions-grid">
            ${uiContext.ALL_PERMISSION_ACTIONS.map(
              (a) => `
              <label class="role-action-check">
                <input type="checkbox" data-role-action="${a}" ${draft.baseActionMask.includes(a) ? "checked" : ""} />
                <span>${escapeHtml(uiContext.ACTION_LABELS_RU[a] ?? a)}</span>
              </label>
            `,
            ).join("")}
          </div>
        </div>
        <div class="roles-detail-section">
          <div class="roles-section-title">Участники (${selected.memberUserIds.length})</div>
          <div class="roles-members-grid">
            ${renderRoleMembersAssignment(selected)}
          </div>
        </div>
        <div class="roles-detail-actions">
          <button id="role-save" class="primary" ${dirty && !rs.saving ? "" : "disabled"}>${rs.saving ? "Сохраняем…" : "Сохранить"}</button>
          ${!selected.system ? `<button id="role-delete" class="danger">Удалить роль</button>` : ""}
          ${rs.error ? `<span class="roles-error">${escapeHtml(rs.error)}</span>` : ""}
        </div>
      </div>
    `;
  })();

  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide roles-modal" role="dialog">
        <div class="modal-header">
          <h3>${t("modal.roles")} · ${escapeHtml(ws.name)}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="modal-body roles-modal-body">
          ${list}
          ${detail}
        </div>
      </div>
    </div>
  `;
}

export async function openWorkspaceRolesModal(
  workspaceId: string,
): Promise<void> {
  uiContext.state.modal = "workspaceRoles";
  uiContext.state.workspaceRoles = {
    workspaceId,
    loading: true,
    saving: false,
    error: null,
    roles: [],
    selectedRoleId: null,
    draft: null,
  };
  render();
  // Гарантируем что текущий ws соответствует — иначе renderRoleMembersAssignment
  // покажет state.members не от того воркспейса.
  if (uiContext.state.selectedWorkspaceId !== workspaceId) {
    await selectWorkspace(workspaceId);
  } else if (uiContext.state.members.length === 0) {
    await loadMembers();
  }
  await reloadWorkspaceRoles();
}

export async function reloadWorkspaceRoles(): Promise<void> {
  const wsId = uiContext.state.workspaceRoles.workspaceId;
  if (!wsId) return;
  uiContext.state.workspaceRoles.loading = true;
  render();
  try {
    const data = await uiContext.httpClient.get<{ items: WorkspaceRole[] }>(
      `/api/v1/workspaces/${wsId}/roles`,
    );
    uiContext.state.workspaceRoles.roles = data.items ?? [];
    // Wave 5: модалка и сайдбар смотрят на один и тот же набор ролей.
    if (uiContext.state.selectedWorkspaceId === wsId) {
      uiContext.state.wsRoles = uiContext.state.workspaceRoles.roles;
      uiContext.userColorCache = null;
    }
    if (
      !uiContext.state.workspaceRoles.selectedRoleId &&
      uiContext.state.workspaceRoles.roles.length > 0
    ) {
      uiContext.state.workspaceRoles.selectedRoleId =
        uiContext.state.workspaceRoles.roles[0].id;
    }
    syncWorkspaceRoleDraft();
    uiContext.state.workspaceRoles.error = null;
  } catch (err) {
    uiContext.state.workspaceRoles.error = describeError(err);
  } finally {
    uiContext.state.workspaceRoles.loading = false;
    render();
  }
}

export function syncWorkspaceRoleDraft(): void {
  const rs = uiContext.state.workspaceRoles;
  const sel = rs.roles.find((r) => r.id === rs.selectedRoleId);
  if (!sel) {
    rs.draft = null;
    return;
  }
  rs.draft = {
    name: sel.name,
    color: sel.color ?? "",
    position: sel.position,
    hoisted: sel.hoisted,
    baseActionMask: [...sel.baseActionMask],
  };
}

export async function reorderRole(
  dragId: string,
  targetId: string,
  after: boolean,
): Promise<void> {
  const rs = uiContext.state.workspaceRoles;
  const wsId = rs.workspaceId;
  if (!wsId) return;
  const ordered = [...rs.roles];
  const fromIdx = ordered.findIndex((r) => r.id === dragId);
  if (fromIdx === -1) return;
  const [moved] = ordered.splice(fromIdx, 1);
  let toIdx = ordered.findIndex((r) => r.id === targetId);
  if (toIdx === -1) return;
  if (after) toIdx += 1;
  ordered.splice(toIdx, 0, moved);

  const updates: Array<{ id: string; position: number }> = [];
  ordered.forEach((r, i) => {
    const pos = (ordered.length - i) * 10;
    if (r.position !== pos) {
      r.position = pos;
      updates.push({ id: r.id, position: pos });
    }
  });
  // Оптимистично применяем порядок; при ошибке перезагрузим с сервера.
  rs.roles = ordered;
  if (uiContext.state.selectedWorkspaceId === wsId) {
    uiContext.state.wsRoles = uiContext.state.wsRoles
      .map((r) => {
        const upd = ordered.find((x) => x.id === r.id);
        return upd ? { ...r, position: upd.position } : r;
      })
      .sort((a, b) => b.position - a.position);
    uiContext.userColorCache = null;
  }
  syncWorkspaceRoleDraft();
  render();
  try {
    for (const u of updates) {
      await uiContext.httpClient.patch(
        `/api/v1/workspaces/${wsId}/roles/${u.id}`,
        { position: u.position },
      );
    }
  } catch (err) {
    rs.error = describeError(err);
    await reloadWorkspaceRoles();
  }
}

export function attachWorkspaceRolesHandlers(): void {
  if (uiContext.state.modal !== "workspaceRoles") return;
  const rs = uiContext.state.workspaceRoles;

  uiContext.rootEl
    .querySelectorAll<HTMLElement>("[data-select-role]")
    .forEach((el) => {
      bindEvent(
        el,
        "click",
        () => {
          const id = el.dataset.selectRole;
          if (!id || rs.selectedRoleId === id) return;
          rs.selectedRoleId = id;
          rs.error = null;
          syncWorkspaceRoleDraft();
          render();
        },
        "bind-310209",
      );
      // Wave 5: drag-reorder позиций (H.5(1)) — вместо ручного числа в input.
      bindEvent(
        el,
        "dragstart",
        (e) => {
          const id = el.dataset.selectRole;
          if (!id) return;
          uiContext._roleDragId = id;
          e.dataTransfer?.setData("text/plain", id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
          el.classList.add("drag-source");
        },
        "bind-310527",
      );
      bindEvent(
        el,
        "dragend",
        () => {
          uiContext._roleDragId = null;
          el.classList.remove("drag-source");
          uiContext.rootEl
            .querySelectorAll(
              ".roles-list-item.drop-before, .roles-list-item.drop-after",
            )
            .forEach((x) => x.classList.remove("drop-before", "drop-after"));
        },
        "bind-310821",
      );
      bindEvent(
        el,
        "dragover",
        (e) => {
          if (
            !uiContext._roleDragId ||
            uiContext._roleDragId === el.dataset.selectRole
          )
            return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          const rect = el.getBoundingClientRect();
          const after = e.clientY > rect.top + rect.height / 2;
          el.classList.toggle("drop-after", after);
          el.classList.toggle("drop-before", !after);
        },
        "bind-311105",
      );
      bindEvent(
        el,
        "dragleave",
        () => {
          el.classList.remove("drop-before", "drop-after");
        },
        "bind-311524",
      );
      bindEvent(
        el,
        "drop",
        (e) => {
          if (!uiContext._roleDragId) return;
          e.preventDefault();
          const targetId = el.dataset.selectRole;
          const rect = el.getBoundingClientRect();
          const after = e.clientY > rect.top + rect.height / 2;
          el.classList.remove("drop-before", "drop-after");
          if (targetId && targetId !== uiContext._roleDragId) {
            void reorderRole(uiContext._roleDragId, targetId, after);
          }
        },
        "bind-311633",
      );
    });

  uiContext.rootEl.querySelector<HTMLButtonElement>("#role-create")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#role-create"),
        "click",
        async () => {
          const wsId = rs.workspaceId;
          if (!wsId) return;
          const nameRaw = await promptDialog({
            title: "Новая роль",
            label: "Название",
            placeholder: "например, Модератор",
          });
          const name = nameRaw?.trim();
          if (!name) return;
          const codeRaw = await promptDialog({
            title: "Код роли",
            body: "Только латиница (a-z), цифры, _ и -. Должен быть уникален в воркспейсе.",
            label: "Код",
            initial: slugify(name),
          });
          const code = codeRaw?.trim();
          if (!code) return;
          try {
            const created = await uiContext.httpClient.post<WorkspaceRole>(
              `/api/v1/workspaces/${wsId}/roles`,
              {
                code,
                name,
                baseActionMask: [
                  "message.write",
                  "message.react",
                  "message.attach",
                  "message.mention",
                ],
              },
            );
            rs.selectedRoleId = created.id;
            await reloadWorkspaceRoles();
          } catch (err) {
            rs.error = describeError(err);
            render();
          }
        },
        "bind-312068",
      )
    : undefined;

  // Все правки draft'а — напрямую в state без render(), чтобы не дёргать
  // фокус. render() зовём только перед сохранением и после ответа сервера.
  const draft = rs.draft;
  if (draft) {
    uiContext.rootEl.querySelector<HTMLInputElement>("#role-name")
      ? bindEvent(
          uiContext.rootEl.querySelector<HTMLInputElement>("#role-name"),
          "input",
          (ev) => {
            draft.name = (ev.target as HTMLInputElement).value;
          },
          "bind-313283",
        )
      : undefined;
    uiContext.rootEl.querySelector<HTMLInputElement>("#role-color")
      ? bindEvent(
          uiContext.rootEl.querySelector<HTMLInputElement>("#role-color"),
          "input",
          (ev) => {
            draft.color = (ev.target as HTMLInputElement).value;
          },
          "bind-313443",
        )
      : undefined;
    uiContext.rootEl.querySelector<HTMLButtonElement>("#role-color-clear")
      ? bindEvent(
          uiContext.rootEl.querySelector<HTMLButtonElement>(
            "#role-color-clear",
          ),
          "click",
          () => {
            draft.color = "";
            render();
          },
          "bind-313605",
        )
      : undefined;
    uiContext.rootEl.querySelector<HTMLInputElement>("#role-position")
      ? bindEvent(
          uiContext.rootEl.querySelector<HTMLInputElement>("#role-position"),
          "input",
          (ev) => {
            const n = parseInt((ev.target as HTMLInputElement).value, 10);
            draft.position = Number.isFinite(n) ? n : 0;
          },
          "bind-313753",
        )
      : undefined;
    uiContext.rootEl.querySelector<HTMLInputElement>("#role-hoisted")
      ? bindEvent(
          uiContext.rootEl.querySelector<HTMLInputElement>("#role-hoisted"),
          "change",
          (ev) => {
            draft.hoisted = (ev.target as HTMLInputElement).checked;
          },
          "bind-313979",
        )
      : undefined;
    delegate<HTMLInputElement, "change">(
      uiContext.rootEl,
      "[data-role-action]",
      "change",
      (_event, cb) => {
        const action = cb.dataset.roleAction;
        if (!action) return;
        if (cb.checked && !draft.baseActionMask.includes(action)) {
          draft.baseActionMask.push(action);
        } else if (!cb.checked) {
          draft.baseActionMask = draft.baseActionMask.filter(
            (a) => a !== action,
          );
        }
      },
      "delegate-314215",
    );
  }

  uiContext.rootEl.querySelector<HTMLButtonElement>("#role-save")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#role-save"),
        "click",
        async () => {
          const wsId = rs.workspaceId;
          const sel = rs.roles.find((r) => r.id === rs.selectedRoleId);
          if (!wsId || !sel || !rs.draft) return;
          rs.saving = true;
          rs.error = null;
          render();
          try {
            const body: Record<string, unknown> = {
              name: rs.draft.name.trim(),
              position: rs.draft.position,
              hoisted: rs.draft.hoisted,
              baseActionMask: rs.draft.baseActionMask,
            };
            // null цвета = «без цвета», иначе шлём hex.
            body.color = rs.draft.color ? rs.draft.color : null;
            const updated = await uiContext.httpClient.patch<WorkspaceRole>(
              `/api/v1/workspaces/${wsId}/roles/${sel.id}`,
              body,
            );
            rs.roles = rs.roles.map((r) => (r.id === updated.id ? updated : r));
            syncWorkspaceRoleDraft();
            // H.7/Wave 5: цвет/позиция роли могли поменяться — обновить wsRoles
            // для member-sidebar и .author в сообщениях.
            if (uiContext.state.selectedWorkspaceId === wsId) {
              uiContext.state.wsRoles = uiContext.state.wsRoles.map((r) =>
                r.id === updated.id ? updated : r,
              );
              uiContext.userColorCache = null;
            }
          } catch (err) {
            rs.error = describeError(err);
          } finally {
            rs.saving = false;
            render();
          }
        },
        "bind-314594",
      )
    : undefined;

  uiContext.rootEl.querySelector<HTMLButtonElement>("#role-delete")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#role-delete"),
        "click",
        async () => {
          const wsId = rs.workspaceId;
          const sel = rs.roles.find((r) => r.id === rs.selectedRoleId);
          if (!wsId || !sel) return;
          const ok = await confirmDialog({
            title: "Удалить роль",
            body: `Удалить роль «${sel.name}»? Назначения участникам исчезнут.`,
            confirmLabel: "Удалить",
            danger: true,
          });
          if (!ok) return;
          try {
            await uiContext.httpClient.del(
              `/api/v1/workspaces/${wsId}/roles/${sel.id}`,
            );
            rs.selectedRoleId = null;
            await reloadWorkspaceRoles();
          } catch (err) {
            rs.error = describeError(err);
            render();
          }
        },
        "bind-315870",
      )
    : undefined;

  delegate<HTMLInputElement, "change">(
    uiContext.rootEl,
    "[data-role-member]",
    "change",
    async (_event, cb) => {
      const wsId = rs.workspaceId;
      const sel = rs.roles.find((r) => r.id === rs.selectedRoleId);
      const userId = cb.dataset.roleMember;
      if (!wsId || !sel || !userId) return;
      const previousChecked = !cb.checked;
      try {
        if (cb.checked) {
          await uiContext.httpClient.post(
            `/api/v1/workspaces/${wsId}/roles/${sel.id}/members/${userId}`,
          );
          sel.memberUserIds = [...sel.memberUserIds, userId];
        } else {
          await uiContext.httpClient.del(
            `/api/v1/workspaces/${wsId}/roles/${sel.id}/members/${userId}`,
          );
          sel.memberUserIds = sel.memberUserIds.filter((x) => x !== userId);
        }
        // Wave 5: членство влияет на union-цвет и hoisted-секции сайдбара.
        if (uiContext.state.selectedWorkspaceId === wsId) {
          uiContext.state.wsRoles = uiContext.state.wsRoles.map((r) =>
            r.id === sel.id ? { ...r, memberUserIds: sel.memberUserIds } : r,
          );
          uiContext.userColorCache = null;
        }
      } catch (err) {
        cb.checked = previousChecked;
        rs.error = describeError(err);
        render();
      }
    },
    "delegate-316644",
  );
}

export function renderRoleMembersAssignment(role: WorkspaceRole): string {
  // state.members — участники текущего канала. Для назначения нужны все
  // участники воркспейса; на данный момент в state.members лежат участники
  // ws (member-sidebar). Если пусто — лениво подсказываем загрузить.
  if (uiContext.state.members.length === 0) {
    return `<div class="roles-empty">Откройте панель участников хотя бы раз, чтобы прогрузить список — он используется здесь же.</div>`;
  }
  const isOwnerRole = role.code === "owner";
  const sorted = [...uiContext.state.members].sort((a, b) =>
    (a.displayName || a.username).localeCompare(
      b.displayName || b.username,
      "ru",
    ),
  );
  return sorted
    .map((m) => {
      const has = role.memberUserIds.includes(m.userId);
      return `
      <label class="role-member-row${isOwnerRole ? " locked" : ""}">
        <input type="checkbox" data-role-member="${escapeHtml(m.userId)}" ${has ? "checked" : ""} ${isOwnerRole ? "disabled" : ""} />
        <span>${escapeHtml(m.displayName || m.username)}</span>
        <span class="role-member-sub">@${escapeHtml(m.username)}</span>
      </label>
    `;
    })
    .join("");
}
