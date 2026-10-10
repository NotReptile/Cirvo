import { describeError } from "../errors";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type { CategoryPermsState, PermDraft } from "../types";
import { escapeHtml } from "../util/html";
import { permDraftToList } from "../util/permissions";
import {
  renderAuditModal,
  renderNotificationsModal,
  renderSearchModal,
} from "./activity";
import { renderAdminModal } from "./admin";
import {
  renderCreateChannelModal,
  renderCreateForumPostModal,
} from "./channelCreate";
import {
  renderChannelSettingsModal,
  renderPermGrid,
  roleLabel,
} from "./channelSettings";
import { renderInvitesModal } from "./channelView";
import { setTransientStatus } from "./helpers";
import { renderMembersModal } from "./members";
import { renderUserProfilePopup } from "./profile";
import { renderSettingsModal } from "./settings";
import {
  renderWelcomeChannelModal,
  renderWorkspaceRolesModal,
} from "./workspaceRoles";
import { renderWorkspaceSettingsModal } from "./workspaceSettings";
import { canWorkspace, unavailablePermissionsModal } from "./capabilities";

export function renderModal(): string {
  if (!uiContext.state.modal) return "";
  if (uiContext.state.modal === "settings") return renderSettingsModal();
  if (uiContext.state.modal === "members") return renderMembersModal();
  if (uiContext.state.modal === "audit") return renderAuditModal();
  if (uiContext.state.modal === "search") return renderSearchModal();
  if (uiContext.state.modal === "notifications")
    return renderNotificationsModal();
  if (uiContext.state.modal === "admin") return renderAdminModal();
  if (uiContext.state.modal === "channelSettings")
    return renderChannelSettingsModal();
  if (uiContext.state.modal === "workspaceRoles")
    return renderWorkspaceRolesModal();
  if (uiContext.state.modal === "welcomeChannel")
    return renderWelcomeChannelModal();
  if (uiContext.state.modal === "createChannel")
    return renderCreateChannelModal();
  if (uiContext.state.modal === "createForumPost")
    return renderCreateForumPostModal();
  if (uiContext.state.modal === "workspaceSettings")
    return renderWorkspaceSettingsModal();
  if (uiContext.state.modal === "userProfile") return renderUserProfilePopup();
  if (uiContext.state.modal === "invites") return renderInvitesModal();
  if (uiContext.state.modal === "categoryPermissions")
    return renderCategoryPermissionsModal();
  return "";
}

// Wave 5 (J.5b): модалка прав категории. Role-overrides, наследуются всеми
// каналами категории; канальные overrides их перекрывают.
export function renderCategoryPermissionsModal(): string {
  if (!canWorkspace("channel.update")) return unavailablePermissionsModal();
  const cp = uiContext.state.categoryPerms;
  const cat = uiContext.state.categories.find((c) => c.id === cp.categoryId);
  if (!cat) return "";
  const body = (() => {
    if (cp.loading) return `<div class="search-empty">Загрузка…</div>`;
    if (!cp.data)
      return `<div class="search-empty">${escapeHtml(cp.error ?? "Не удалось загрузить")}</div>`;
    return `
      <div class="perm-help">
        Правила применяются ко всем каналам категории. Канальные настройки
        прав имеют приоритет над категорийными. Owner не подчиняется overrides.
      </div>
      ${renderPermGrid(
        cp.data.actions,
        cp.data.roles.map((r) => ({ key: r, label: roleLabel(r) })),
        cp.draft,
        "cat-perm-select",
      )}
      <div class="admin-actions">
        <button id="cat-perm-save" class="primary" ${cp.saving ? "disabled" : ""}>
          ${cp.saving ? "Сохраняю…" : "Сохранить"}
        </button>
        ${cp.error ? `<span class="roles-error">${escapeHtml(cp.error)}</span>` : ""}
      </div>
    `;
  })();
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide" role="dialog">
        <div class="modal-header">
          <h3>Права категории · ${escapeHtml(cat.name)}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="modal-body">${body}</div>
      </div>
    </div>
  `;
}

export async function openCategoryPermissions(
  categoryId: string,
): Promise<void> {
  uiContext.state.modal = "categoryPermissions";
  uiContext.state.categoryPerms = {
    categoryId,
    loading: true,
    saving: false,
    error: null,
    data: null,
    draft: {},
  };
  const cp = uiContext.state.categoryPerms;
  render();
  try {
    const data = await uiContext.httpClient.get<CategoryPermsState["data"]>(
      `/api/v1/categories/${categoryId}/permissions`,
    );
    if (uiContext.state.categoryPerms !== cp) return;
    uiContext.state.categoryPerms.data = data;
    const draft: PermDraft = {};
    if (data) {
      for (const role of data.roles) {
        draft[role] = {};
        for (const a of data.actions) draft[role][a] = "inherit";
      }
      for (const ov of data.overrides) {
        if (!draft[ov.roleCode]) continue;
        for (const a of ov.granted) draft[ov.roleCode][a] = "grant";
        for (const a of ov.denied) draft[ov.roleCode][a] = "deny";
      }
    }
    uiContext.state.categoryPerms.draft = draft;
  } catch (err) {
    cp.error = describeError(err);
  } finally {
    cp.loading = false;
    if (uiContext.state.categoryPerms === cp) render();
  }
}

export async function saveCategoryPermissions(): Promise<void> {
  const cp = uiContext.state.categoryPerms;
  if (!cp.categoryId || cp.saving) return;
  cp.saving = true;
  cp.error = null;
  render();
  try {
    const data = await uiContext.httpClient.put<CategoryPermsState["data"]>(
      `/api/v1/categories/${cp.categoryId}/permissions`,
      {
        overrides: permDraftToList(cp.draft).map(
          ({ key, granted, denied }) => ({ roleCode: key, granted, denied }),
        ),
      },
    );
    if (uiContext.state.categoryPerms !== cp) return;
    cp.data = data;
    setTransientStatus("Права категории сохранены");
  } catch (err) {
    cp.error = describeError(err);
  } finally {
    cp.saving = false;
    if (uiContext.state.categoryPerms === cp) render();
  }
}
