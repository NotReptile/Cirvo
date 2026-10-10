import { bindEvent, delegate } from "../dom";
import { describeError } from "../errors";
import { t } from "../i18n";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type {
  Me,
  PendingUpload,
  Workspace,
  WorkspaceRole,
  WorkspaceSettingsTab,
} from "../types";
import { escapeHtml } from "../util/html";
import { setTransientStatus } from "./helpers";
import { renderBody } from "./messageView";
import { selectWorkspace } from "./session";
import { renderAvatar } from "./shell";
import { openWorkspaceRolesModal } from "./workspaceRoles";
import { canWorkspace, unavailablePermissionsModal } from "./capabilities";

export function renderWorkspaceSettingsModal(): string {
  const wsSet = uiContext.state.workspaceSettings;
  const ws = uiContext.state.workspaces.find((w) => w.id === wsSet.workspaceId);
  if (!ws) return "";
  if (!canWorkspace("workspace.update", ws.id)) return unavailablePermissionsModal();
  const isOwner = canWorkspace("workspace.delete", ws.id);
  const tabs = uiContext.WS_TABS.filter((t) => t.id !== "delete" || isOwner);
  const tabBar = tabs
    .map((t) => {
      const active = t.id === wsSet.tab ? " active" : "";
      const danger = t.id === "delete" ? " danger" : "";
      return `<button class="ws-settings-tab${active}${danger}" data-ws-tab="${t.id}">${escapeHtml(t.label)}</button>`;
    })
    .join("");
  let body = "";
  if (wsSet.tab === "overview") body = renderWSOverviewTab(ws);
  else if (wsSet.tab === "welcome") body = renderWSWelcomeTab(ws);
  else if (wsSet.tab === "roles") body = renderWSRolesTab(ws);
  else if (wsSet.tab === "delete") body = renderWSDeleteTab(ws);
  const errBlock = wsSet.error
    ? `<div class="modal-error">${escapeHtml(wsSet.error)}</div>`
    : "";
  return `
    <input id="ws-settings-avatar-input" type="file" accept="image/*" hidden />
    <div class="modal-backdrop" data-modal-close>
      <div class="modal ws-settings-modal" role="dialog">
        <div class="modal-header">
          <h3>${t("modal.wssettings")} · ${escapeHtml(ws.name)}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="ws-settings-shell">
          <nav class="ws-settings-tabs">${tabBar}</nav>
          <div class="ws-settings-body">
            ${body}
            ${errBlock}
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderWSOverviewTab(ws: Workspace): string {
  const wsSet = uiContext.state.workspaceSettings;
  const avatarBlock = `
    <div class="ws-settings-avatar-block">
      ${renderAvatar({
        avatarMediaId: ws.avatarMediaId,
        fallbackText: ws.name,
        sizePx: 96,
        className: "ws-settings-avatar",
      })}
      <div class="ws-settings-avatar-actions">
        <button id="ws-settings-avatar-upload" class="ghost">${ws.avatarMediaId ? "Сменить иконку" : "Загрузить иконку"}</button>
        ${ws.avatarMediaId ? `<button id="ws-settings-avatar-remove" class="ghost danger">Удалить</button>` : ""}
        <div class="cc-field-hint">PNG/JPG, до 25 MiB. Будет видна всем участникам.</div>
      </div>
    </div>
  `;
  return `
    ${avatarBlock}
    <label class="cc-field">
      <span class="cc-field-label">Название</span>
      <input id="ws-settings-name" type="text" maxlength="64" value="${escapeHtml(wsSet.draftName)}" />
    </label>
    <label class="cc-field">
      <span class="cc-field-label">Адрес (slug)</span>
      <input type="text" value="${escapeHtml(ws.slug)}" disabled />
      <span class="cc-field-hint">Slug нельзя сменить — это стабильный идентификатор, на нём держатся ссылки и инвайты.</span>
    </label>
    <div class="modal-footer">
      <button id="ws-settings-save" class="primary" ${wsSet.saving || wsSet.draftName.trim() === ws.name ? "disabled" : ""}>
        ${wsSet.saving ? "Сохранение…" : "Сохранить"}
      </button>
    </div>
  `;
}

export function renderWSWelcomeTab(ws: Workspace): string {
  const textChannels = uiContext.state.channels.filter(
    (c) => c.workspaceId === ws.id && c.kind === "text",
  );
  const current = ws.welcomeChannelId ?? "";
  const options = [
    `<option value="">— не присылать —</option>`,
    ...textChannels.map(
      (c) =>
        `<option value="${c.id}"${c.id === current ? " selected" : ""}>#${escapeHtml(c.name)}</option>`,
    ),
  ].join("");
  return `
    <p class="modal-hint">Канал, в который автоматически прилетает плашка «X присоединился к серверу» при принятии инвайта.</p>
    <label class="cc-field">
      <span class="cc-field-label">Welcome-канал</span>
      <select id="ws-settings-welcome" class="cc-field-select" ${uiContext.state.workspaceSettings.welcomeSaving ? "disabled" : ""}>${options}</select>
      ${uiContext.state.workspaceSettings.welcomeSaving ? `<span class="cc-field-hint">Сохранение…</span>` : ""}
    </label>
  `;
}

export function renderWSRolesTab(ws: Workspace): string {
  return `
    <p class="modal-hint">Кастомные роли, права и назначения участников.</p>
    <button id="ws-settings-open-roles" class="primary">Открыть редактор ролей · ${escapeHtml(ws.name)}</button>
  `;
}

export function renderWSDeleteTab(ws: Workspace): string {
  const wsSet = uiContext.state.workspaceSettings;
  const matches = wsSet.deleteTyped.trim() === ws.name;
  return `
    <div class="ws-settings-danger">
      <h4>Удалить воркспейс</h4>
      <p class="modal-hint">Это действие <strong>необратимо</strong>. Будут удалены все каналы, сообщения, вложения, роли и инвайты. Восстановить нельзя.</p>
      <label class="cc-field">
        <span class="cc-field-label">Введи название «${escapeHtml(ws.name)}» для подтверждения</span>
        <input id="ws-settings-delete-input" type="text" autocomplete="off" placeholder="${escapeHtml(ws.name)}" value="${escapeHtml(wsSet.deleteTyped)}" />
      </label>
      <div class="modal-footer">
        <button id="ws-settings-delete-btn" class="danger" ${matches && !wsSet.saving ? "" : "disabled"}>
          ${wsSet.saving ? "Удаление…" : "Удалить воркспейс навсегда"}
        </button>
      </div>
    </div>
  `;
}

export function attachWorkspaceSettingsHandlers(): void {
  if (uiContext.state.modal !== "workspaceSettings") return;
  const wsSet = uiContext.state.workspaceSettings;
  const ws = uiContext.state.workspaces.find((w) => w.id === wsSet.workspaceId);
  if (!ws) return;

  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-ws-tab]",
    "click",
    (_event, btn) => {
      const tab = btn.dataset.wsTab as WorkspaceSettingsTab;
      uiContext.state.workspaceSettings.tab = tab;
      uiContext.state.workspaceSettings.error = null;
      render();
    },
    "delegate-270011",
  );

  // --- Обзор ---
  const nameInput =
    uiContext.rootEl.querySelector<HTMLInputElement>("#ws-settings-name");
  nameInput
    ? bindEvent(
        nameInput,
        "input",
        () => {
          uiContext.state.workspaceSettings.draftName = nameInput.value;
          // обновим только Save-кнопку (без render() чтобы фокус не слетел)
          const btn =
            uiContext.rootEl.querySelector<HTMLButtonElement>(
              "#ws-settings-save",
            );
          if (btn)
            btn.disabled =
              uiContext.state.workspaceSettings.saving ||
              nameInput.value.trim() === ws.name ||
              !nameInput.value.trim();
        },
        "bind-270393",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#ws-settings-save")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#ws-settings-save"),
        "click",
        () => {
          void saveWorkspaceName();
        },
        "bind-270777",
      )
    : undefined;

  // Avatar upload — переиспользуем поток workspaceMenu (POST /uploads
  // → PUT /workspaces/{id}/avatar). Кнопка триггерит hidden input.
  uiContext.rootEl.querySelector<HTMLButtonElement>(
    "#ws-settings-avatar-upload",
  )
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#ws-settings-avatar-upload",
        ),
        "click",
        () => {
          uiContext.rootEl
            .querySelector<HTMLInputElement>("#ws-settings-avatar-input")
            ?.click();
        },
        "bind-271051",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLInputElement>("#ws-settings-avatar-input")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>(
          "#ws-settings-avatar-input",
        ),
        "change",
        async (e) => {
          const input = e.currentTarget as HTMLInputElement;
          const file = input.files?.[0];
          if (!file) return;
          if (!file.type.startsWith("image/")) {
            uiContext.state.workspaceSettings.error =
              "Иконка должна быть картинкой";
            render();
            return;
          }
          try {
            uiContext.state.status = "Загрузка иконки…";
            render();
            const uploaded =
              await uiContext.httpClient.uploadFile<PendingUpload>(
                "/api/v1/uploads",
                file,
              );
            const updated = await uiContext.httpClient.put<Workspace>(
              `/api/v1/workspaces/${ws.id}/avatar`,
              { mediaId: uploaded.id },
            );
            uiContext.state.workspaces = uiContext.state.workspaces.map((w) =>
              w.id === ws.id
                ? { ...w, avatarMediaId: updated.avatarMediaId }
                : w,
            );
            setTransientStatus("Иконка обновлена");
          } catch (err) {
            uiContext.state.workspaceSettings.error = describeError(err);
            uiContext.state.status = "";
            render();
          } finally {
            input.value = "";
          }
        },
        "bind-271246",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>(
    "#ws-settings-avatar-remove",
  )
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#ws-settings-avatar-remove",
        ),
        "click",
        async () => {
          try {
            const updated = await uiContext.httpClient.del<Workspace>(
              `/api/v1/workspaces/${ws.id}/avatar`,
            );
            uiContext.state.workspaces = uiContext.state.workspaces.map((w) =>
              w.id === ws.id
                ? { ...w, avatarMediaId: updated.avatarMediaId }
                : w,
            );
            setTransientStatus("Иконка удалена");
          } catch (err) {
            uiContext.state.workspaceSettings.error = describeError(err);
            render();
          }
        },
        "bind-272241",
      )
    : undefined;

  // --- Welcome ---
  const welcomeSelect = uiContext.rootEl.querySelector<HTMLSelectElement>(
    "#ws-settings-welcome",
  );
  welcomeSelect
    ? bindEvent(
        welcomeSelect,
        "change",
        async () => {
          const value = welcomeSelect.value || null;
          uiContext.state.workspaceSettings.welcomeSaving = true;
          render();
          try {
            const updated = await uiContext.httpClient.put<Workspace>(
              `/api/v1/workspaces/${ws.id}/welcome-channel`,
              { channelId: value },
            );
            uiContext.state.workspaces = uiContext.state.workspaces.map((w) =>
              w.id === ws.id
                ? { ...w, welcomeChannelId: updated.welcomeChannelId }
                : w,
            );
            uiContext.state.status = "Welcome-канал обновлён";
          } catch (err) {
            uiContext.state.workspaceSettings.error = describeError(err);
          } finally {
            uiContext.state.workspaceSettings.welcomeSaving = false;
            render();
          }
        },
        "bind-272843",
      )
    : undefined;

  // --- Роли ---
  uiContext.rootEl.querySelector<HTMLButtonElement>("#ws-settings-open-roles")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#ws-settings-open-roles",
        ),
        "click",
        () => {
          // Закрываем эту модалку и открываем roles-модалку. openWorkspaceRolesModal
          // сам ставит state.modal = "workspaceRoles" и тянет роли.
          void openWorkspaceRolesModal(ws.id);
        },
        "bind-273518",
      )
    : undefined;

  // --- Удалить ---
  const delInput = uiContext.rootEl.querySelector<HTMLInputElement>(
    "#ws-settings-delete-input",
  );
  delInput
    ? bindEvent(
        delInput,
        "input",
        () => {
          uiContext.state.workspaceSettings.deleteTyped = delInput.value;
          // обновим только кнопку — render() сбросил бы каретку
          const btn = uiContext.rootEl.querySelector<HTMLButtonElement>(
            "#ws-settings-delete-btn",
          );
          if (btn)
            btn.disabled =
              uiContext.state.workspaceSettings.saving ||
              delInput.value.trim() !== ws.name;
        },
        "bind-273922",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#ws-settings-delete-btn")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#ws-settings-delete-btn",
        ),
        "click",
        () => {
          void deleteWorkspace();
        },
        "bind-274272",
      )
    : undefined;
}

export async function saveWorkspaceName(): Promise<void> {
  const wsSet = uiContext.state.workspaceSettings;
  const ws = uiContext.state.workspaces.find((w) => w.id === wsSet.workspaceId);
  if (!ws) return;
  const name = wsSet.draftName.trim();
  if (!name || name === ws.name) return;
  wsSet.saving = true;
  wsSet.error = null;
  render();
  try {
    const updated = await uiContext.httpClient.patch<Workspace>(
      `/api/v1/workspaces/${ws.id}`,
      { name },
    );
    uiContext.state.workspaces = uiContext.state.workspaces.map((w) =>
      w.id === ws.id ? { ...w, name: updated.name } : w,
    );
    uiContext.state.workspaceSettings.draftName = updated.name;
    setTransientStatus("Воркспейс обновлён");
  } catch (err) {
    wsSet.error = describeError(err);
  } finally {
    wsSet.saving = false;
    render();
  }
}

export async function deleteWorkspace(): Promise<void> {
  const wsSet = uiContext.state.workspaceSettings;
  const ws = uiContext.state.workspaces.find((w) => w.id === wsSet.workspaceId);
  if (!ws) return;
  if (wsSet.deleteTyped.trim() !== ws.name) return;
  wsSet.saving = true;
  wsSet.error = null;
  render();
  try {
    await uiContext.httpClient.del(`/api/v1/workspaces/${ws.id}`);
    // Локальная очистка: убираем ws и его каналы, переключаемся на первый
    // оставшийся (или ни на что, если воркспейсов больше нет).
    uiContext.state.workspaces = uiContext.state.workspaces.filter(
      (w) => w.id !== ws.id,
    );
    uiContext.state.channels = uiContext.state.channels.filter(
      (c) => c.workspaceId !== ws.id,
    );
    if (uiContext.state.selectedWorkspaceId === ws.id) {
      uiContext.state.selectedWorkspaceId = null;
      uiContext.state.selectedChannelId = null;
      uiContext.state.messages = [];
    }
    uiContext.state.modal = null;
    uiContext.state.status = `Воркспейс «${ws.name}» удалён`;
    if (uiContext.state.workspaces.length > 0) {
      await selectWorkspace(uiContext.state.workspaces[0].id);
    } else {
      render();
    }
  } catch (err) {
    wsSet.error = describeError(err);
    wsSet.saving = false;
    render();
  }
}

// G.10: enter/leave inline-edit mode для поля профиля. Сбрасываем draft'ы
// и error при каждом переходе — чтобы открытие «Изменить пароль» не показало
// ошибку от прошлой попытки.
export function startProfileEdit(
  field: "displayName" | "password" | "bio" | "bannerColor",
): void {
  uiContext.state.profileEdit = {
    field,
    draftDisplayName: uiContext.state.me?.displayName ?? "",
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
    draftBio: uiContext.state.me?.bio ?? "",
    draftBannerColor: uiContext.state.me?.bannerColor ?? "",
    saving: false,
    error: null,
    okMessage: null,
  };
  render();
  // фокус на первое поле редактора
  requestAnimationFrame(() => {
    const sel =
      field === "displayName"
        ? "#profile-display-input"
        : field === "password"
          ? "#profile-pw-current"
          : field === "bio"
            ? "#profile-bio-input"
            : field === "bannerColor"
              ? "#profile-banner-color-input"
              : "";
    if (sel)
      uiContext.rootEl
        .querySelector<HTMLInputElement | HTMLTextAreaElement>(sel)
        ?.focus();
  });
}

export function cancelProfileEdit(): void {
  uiContext.state.profileEdit.field = null;
  uiContext.state.profileEdit.error = null;
  uiContext.state.profileEdit.okMessage = null;
  render();
}

export function attachProfileEditHandlers(): void {
  if (
    uiContext.state.modal !== "settings" ||
    uiContext.state.settings.tab !== "profile"
  )
    return;

  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-profile-edit]",
    "click",
    (_event, btn) => {
      const f = btn.dataset.profileEdit as
        "displayName" | "password" | "bio" | "bannerColor" | undefined;
      if (f) startProfileEdit(f);
    },
    "delegate-277571",
  );
  uiContext.rootEl
    .querySelectorAll<HTMLButtonElement>("[data-profile-cancel]")
    .forEach((btn) => {
      bindEvent(btn, "click", () => cancelProfileEdit(), "bind-277920");
    });

  // --- displayName edit ---
  const dnInput = uiContext.rootEl.querySelector<HTMLInputElement>(
    "#profile-display-input",
  );
  dnInput
    ? bindEvent(
        dnInput,
        "input",
        () => {
          uiContext.state.profileEdit.draftDisplayName = dnInput.value;
          // I.6(b): live-preview в profile-card-head без render() (сохраняет
          // фокус и каретку инпута).
          const previewName = uiContext.rootEl.querySelector<HTMLDivElement>(
            ".profile-card-display",
          );
          if (previewName)
            previewName.textContent =
              dnInput.value.trim() ||
              uiContext.state.me?.displayName ||
              uiContext.state.me?.username ||
              "";
        },
        "bind-278101",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#profile-display-save")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#profile-display-save",
        ),
        "click",
        () => {
          void saveDisplayName();
        },
        "bind-278521",
      )
    : undefined;

  // --- password edit (live state без render()) ---
  const pwCur = uiContext.rootEl.querySelector<HTMLInputElement>(
    "#profile-pw-current",
  );
  pwCur
    ? bindEvent(
        pwCur,
        "input",
        () => {
          uiContext.state.profileEdit.currentPassword = pwCur.value;
        },
        "bind-278790",
      )
    : undefined;
  const pwNew =
    uiContext.rootEl.querySelector<HTMLInputElement>("#profile-pw-new");
  pwNew
    ? bindEvent(
        pwNew,
        "input",
        () => {
          uiContext.state.profileEdit.newPassword = pwNew.value;
        },
        "bind-278961",
      )
    : undefined;
  const pwConfirm = uiContext.rootEl.querySelector<HTMLInputElement>(
    "#profile-pw-confirm",
  );
  pwConfirm
    ? bindEvent(
        pwConfirm,
        "input",
        () => {
          uiContext.state.profileEdit.confirmPassword = pwConfirm.value;
        },
        "bind-279136",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#profile-pw-save")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#profile-pw-save"),
        "click",
        () => {
          void savePassword();
        },
        "bind-279240",
      )
    : undefined;

  // I.6: bio / bannerColor edits.
  const bioInput =
    uiContext.rootEl.querySelector<HTMLTextAreaElement>("#profile-bio-input");
  bioInput
    ? bindEvent(
        bioInput,
        "input",
        () => {
          uiContext.state.profileEdit.draftBio = bioInput.value;
          // Обновляем счётчик символов без render() (текстарея сохраняет фокус).
          const hint = bioInput.parentElement?.querySelector<HTMLElement>(
            ".profile-field-hint",
          );
          if (hint)
            hint.textContent = t("pf.bio.chars", {
              n: 600 - bioInput.value.length,
            });
          // I.6(b): live-preview bio в profile-card-head через renderBody.
          const previewBio = uiContext.rootEl.querySelector<HTMLDivElement>(
            ".profile-card-bio-preview",
          );
          if (previewBio) previewBio.innerHTML = renderBody(bioInput.value);
        },
        "bind-279488",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#profile-bio-save")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#profile-bio-save"),
        "click",
        () => {
          void saveProfileExtra("bio");
        },
        "bind-280076",
      )
    : undefined;

  const bcInput = uiContext.rootEl.querySelector<HTMLInputElement>(
    "#profile-banner-color-input",
  );
  bcInput
    ? bindEvent(
        bcInput,
        "input",
        () => {
          uiContext.state.profileEdit.draftBannerColor = bcInput.value;
          const label = uiContext.rootEl.querySelector<HTMLSpanElement>(
            "#profile-banner-color-val",
          );
          if (label) label.textContent = bcInput.value;
          // I.6(b): live-preview banner background. Если banner_media_id есть,
          // временно убираем data-banner-media чтобы CSS solid-color победил.
          const banner = uiContext.rootEl.querySelector<HTMLDivElement>(
            ".profile-banner-area",
          );
          if (banner) {
            banner.style.background = bcInput.value;
            banner.removeAttribute("data-banner-media");
          }
        },
        "bind-280304",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>(
    "#profile-banner-color-clear",
  )
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#profile-banner-color-clear",
        ),
        "click",
        () => {
          uiContext.state.profileEdit.draftBannerColor = "";
          render();
        },
        "bind-280897",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>(
    "#profile-banner-color-save",
  )
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#profile-banner-color-save",
        ),
        "click",
        () => {
          void saveProfileExtra("bannerColor");
        },
        "bind-281070",
      )
    : undefined;

  // I.6: загрузка/удаление баннер-картинки (двухступенчатый flow как для аватара).
  uiContext.rootEl.querySelector<HTMLButtonElement>("#profile-banner-upload")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#profile-banner-upload",
        ),
        "click",
        () => {
          uiContext.rootEl
            .querySelector<HTMLInputElement>("#profile-banner-input")
            ?.click();
        },
        "bind-281310",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLInputElement>("#profile-banner-input")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>(
          "#profile-banner-input",
        ),
        "change",
        async (e) => {
          const input = e.currentTarget as HTMLInputElement;
          const file = input.files?.[0];
          if (!file) return;
          if (!file.type.startsWith("image/")) {
            uiContext.state.status = "Баннер должен быть картинкой";
            render();
            return;
          }
          try {
            uiContext.state.status = "Загрузка баннера…";
            render();
            const uploaded =
              await uiContext.httpClient.uploadFile<PendingUpload>(
                "/api/v1/uploads",
                file,
              );
            const updated = await uiContext.httpClient.put<
              Me & { updatedAt: string }
            >("/api/v1/users/me/banner", { mediaId: uploaded.id });
            if (uiContext.state.me) {
              uiContext.state.me = {
                ...uiContext.state.me,
                bannerMediaId: updated.bannerMediaId,
              };
            }
            setTransientStatus("Баннер обновлён");
          } catch (err) {
            uiContext.state.status = describeError(err);
            render();
          } finally {
            input.value = "";
          }
        },
        "bind-281497",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#profile-banner-remove")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#profile-banner-remove",
        ),
        "click",
        async () => {
          try {
            const updated = await uiContext.httpClient.del<
              Me & { updatedAt: string }
            >("/api/v1/users/me/banner");
            if (uiContext.state.me) {
              uiContext.state.me = {
                ...uiContext.state.me,
                bannerMediaId: undefined,
                bannerColor:
                  updated.bannerColor ?? uiContext.state.me.bannerColor,
              };
            }
            setTransientStatus("Баннер удалён");
          } catch (err) {
            uiContext.state.status = describeError(err);
            render();
          }
        },
        "bind-282438",
      )
    : undefined;
}

// I.6: общий save для bio/bannerColor — все через PUT /users/me
// с pointer-полем. Сервер возвращает обновлённый meView, обновляем state.me.
export async function saveProfileExtra(
  field: "bio" | "bannerColor",
): Promise<void> {
  const pe = uiContext.state.profileEdit;
  pe.saving = true;
  pe.error = null;
  render();
  const body: Record<string, string> = {};
  if (field === "bio") body.bio = pe.draftBio.trim();
  if (field === "bannerColor") body.bannerColor = pe.draftBannerColor.trim();
  try {
    const updated = await uiContext.httpClient.put<Me & { updatedAt: string }>(
      "/api/v1/users/me",
      body,
    );
    uiContext.state.me = {
      ...(uiContext.state.me as Me),
      bio: updated.bio,
      bannerColor: updated.bannerColor,
      displayName: updated.displayName ?? uiContext.state.me?.displayName,
      avatarMediaId: updated.avatarMediaId ?? uiContext.state.me?.avatarMediaId,
      bannerMediaId: updated.bannerMediaId ?? uiContext.state.me?.bannerMediaId,
    };
    uiContext.state.profileEdit.field = null;
    uiContext.state.profileEdit.saving = false;
    setTransientStatus(
      field === "bio" ? "Био обновлено" : "Цвет баннера обновлён",
    );
  } catch (err) {
    pe.saving = false;
    pe.error = describeError(err);
    render();
  }
}

export async function saveDisplayName(): Promise<void> {
  const pe = uiContext.state.profileEdit;
  const trimmed = pe.draftDisplayName.trim();
  pe.saving = true;
  pe.error = null;
  render();
  try {
    const updated = await uiContext.httpClient.put<Me & { updatedAt: string }>(
      "/api/v1/users/me",
      {
        displayName: trimmed,
      },
    );
    uiContext.state.me = {
      id: updated.id,
      email: updated.email,
      username: updated.username,
      displayName: updated.displayName,
      isRoot: uiContext.state.me?.isRoot,
      avatarMediaId: updated.avatarMediaId ?? uiContext.state.me?.avatarMediaId,
      presenceMode: uiContext.state.me?.presenceMode,
      customStatus: uiContext.state.me?.customStatus,
    };
    uiContext.state.profileEdit.field = null;
    uiContext.state.profileEdit.saving = false;
    setTransientStatus("Имя обновлено");
  } catch (err) {
    pe.saving = false;
    pe.error = describeError(err);
    render();
  }
}

export async function savePassword(): Promise<void> {
  const pe = uiContext.state.profileEdit;
  if (pe.currentPassword === "") {
    pe.error = "Введи текущий пароль";
    render();
    return;
  }
  if (pe.newPassword.length < 8) {
    pe.error = "Новый пароль — минимум 8 символов";
    render();
    return;
  }
  if (pe.newPassword !== pe.confirmPassword) {
    pe.error = "Подтверждение не совпадает с новым паролем";
    render();
    return;
  }
  pe.saving = true;
  pe.error = null;
  pe.okMessage = null;
  render();
  try {
    await uiContext.httpClient.post("/api/v1/users/me/password", {
      currentPassword: pe.currentPassword,
      newPassword: pe.newPassword,
    });
    uiContext.state.profileEdit.field = null;
    uiContext.state.profileEdit.saving = false;
    uiContext.state.profileEdit.currentPassword = "";
    uiContext.state.profileEdit.newPassword = "";
    uiContext.state.profileEdit.confirmPassword = "";
    setTransientStatus("Пароль обновлён");
  } catch (err) {
    pe.saving = false;
    pe.error = describeError(err);
    render();
  }
}

// H.6: открыть модалку. Параллельно (не блокируя render) тянем список
// ролей воркспейса — нужны для секции «Доступ» при isPrivate=true.
export function openCreateChannelModal(
  workspaceId: string,
  kind: "text" | "voice",
  categoryId: string | null = null,
): void {
  uiContext.state.createChannel = {
    workspaceId,
    kind,
    name: "",
    isPrivate: false,
    selectedRoles: new Set(),
    roles:
      uiContext.state.createChannel.workspaceId === workspaceId
        ? uiContext.state.createChannel.roles
        : [],
    rolesLoading: true,
    saving: false,
    error: null,
    categoryId,
  };
  uiContext.state.modal = "createChannel";
  render();
  void loadRolesForCreateChannel(workspaceId);
  // фокус на input имени
  requestAnimationFrame(() => {
    uiContext.rootEl
      .querySelector<HTMLInputElement>("#create-channel-name")
      ?.focus();
  });
}

export async function loadRolesForCreateChannel(
  workspaceId: string,
): Promise<void> {
  try {
    const data = await uiContext.httpClient.get<{ items: WorkspaceRole[] }>(
      `/api/v1/workspaces/${workspaceId}/roles`,
    );
    if (uiContext.state.createChannel.workspaceId !== workspaceId) return; // race-guard
    uiContext.state.createChannel.roles = (data.items ?? []).sort(
      (a, b) => b.position - a.position,
    );
    uiContext.state.createChannel.rolesLoading = false;
    render();
  } catch (err) {
    if (uiContext.state.createChannel.workspaceId !== workspaceId) return;
    uiContext.state.createChannel.rolesLoading = false;
    uiContext.state.createChannel.error = describeError(err);
    render();
  }
}
