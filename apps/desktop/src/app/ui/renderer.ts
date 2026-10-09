import { patchChildren, patchElement } from "../dom";
import { t } from "../i18n";
import { icon } from "../icons";
import { polishListboxes } from "../listbox";
import type { RenderRegion } from "../runtime";
import { uiContext } from "../state";
import { hideTooltip } from "../tooltips";
import { escapeHtml } from "../util/html";
import { newAdminCreate } from "./admin";
import {
  renderAuth,
  renderConnectionLost,
  renderForcedPasswordChange,
} from "./authentication";
import { renderCallOverlay } from "./callView";
import {
  renderBellButton,
  renderChannelView,
  renderChannelsBlock,
  renderDMChannelView,
  renderDMHome,
  renderDMSidebarList,
  renderEmpty,
  renderWorkspaceHeaderMenu,
} from "./channelView";
import { attachShellHandlers } from "./handlers";
import { attachCallsRegion } from "./handlersCalls";
import { attachFriendsRegion } from "./handlersFriends";
import { attachMemberMenuRegion } from "./handlersMemberMenu";
import { attachMembersRegion } from "./handlersMembers";
import { attachSidebarRegion } from "./handlersSidebar";
import { attachWorkspaceCreateRegion } from "./handlersWorkspaceCreate";
import { armStatusAutoClear } from "./helpers";
import {
  renderUpdateBanner,
  renderPinsPopup,
  updatePttIndicator,
  updateTypingLine,
} from "./loaders";
import { hydrateMedia } from "./media";
import { rememberRenderedRows, updateMessageList } from "./messageList";
import { renderModal } from "./modals";
import {
  polishNativeControls,
  presenceDotClass,
  presenceLabel,
  renderAvatar,
  renderCategoryMenu,
  renderChannelMenu,
  renderMemberMenu,
  renderMemberSidebar,
  renderStatusMenu,
  renderVoiceVolumeMenu,
  renderWorkspaceMenu,
} from "./shell";
import {
  attachVoiceVideoStreams,
  renderVoiceChannelView,
  renderVoiceStrip,
} from "./voiceView";

export function render(
  regions: ReadonlySet<RenderRegion> = new Set(["all"]),
): void {
  // Временный пароль нового пользователя показывается один раз и живёт, пока
  // открыта вкладка «Пользователи»: закрытие окна, смена вкладки и выход его
  // стирают, как и введённое в форму.
  if (
    (uiContext._adminCreate.result || uiContext._adminCreate.open) &&
    (uiContext.state.modal !== "admin" ||
      uiContext.state.admin.tab !== "users" ||
      !uiContext.httpClient.getTokens())
  ) {
    uiContext._adminCreate = newAdminCreate();
  }
  armStatusAutoClear();
  // Пере-рендер уносит hover-элемент из DOM — открытый тултип залипал бы.
  hideTooltip();
  if (!uiContext.httpClient.getTokens()) {
    renderAuth();
    return;
  }
  if (uiContext.state.bootError && !uiContext.state.me) {
    renderConnectionLost();
    return;
  }
  if (uiContext.state.me?.mustChangePassword) {
    renderForcedPasswordChange();
    return;
  }
  if (!regions.has("all") && uiContext.rootEl.querySelector(".shell")) {
    renderRegions(regions);
    return;
  }
  // C.4: фиксируем bottom-offset ДО уничтожения старого message-list,
  // чтобы после re-render позиция чтения не уехала. Если значение уже
  // задано (loadOlderMessages с pre-prepend высотой) — не перетираем.
  if (
    !uiContext.state.stickToBottom &&
    uiContext.state.restoreScrollBottom === null
  ) {
    const oldList =
      uiContext.rootEl.querySelector<HTMLDivElement>("#message-list");
    if (oldList) {
      uiContext.state.restoreScrollBottom =
        oldList.scrollHeight - oldList.scrollTop - oldList.clientHeight;
    }
  }

  renderShell();

  // Wave 2: #typing-line пересоздан пустым — восстанавливаем из map.
  updateTypingLine();
}

export function renderShell(): void {
  const me = uiContext.state.me;
  const selectedChannel = uiContext.state.channels.find(
    (c) => c.id === uiContext.state.selectedChannelId,
  );
  const selectedDM = uiContext.state.dms.find(
    (d) => d.channelId === uiContext.state.selectedChannelId,
  );
  const selectedWorkspace = uiContext.state.workspaces.find(
    (w) => w.id === uiContext.state.selectedWorkspaceId,
  );
  const canModerate =
    !!selectedWorkspace &&
    ["owner", "admin", "moderator"].includes(selectedWorkspace.role ?? "");
  const dmMode = uiContext.state.dmMode;
  // member-sidebar только для workspace-каналов
  const showMembers =
    !!selectedChannel && uiContext.state.memberSidebarOpen && !dmMode;

  const dmBadge =
    uiContext.state.dmUnreadTotal > 0
      ? `<span class="ws-rail-badge">${uiContext.state.dmUnreadTotal > 99 ? "99+" : uiContext.state.dmUnreadTotal}</span>`
      : "";

  patchChildren(
    uiContext.rootEl,
    `
    ${
      uiContext.connState === "reconnecting" && me
        ? `
      <div class="conn-banner" role="status">
        <span class="conn-banner-spinner"></span>
        ${t("conn.reconnecting")}
      </div>
    `
        : ""
    }
    ${me ? renderUpdateBanner() : ""}
    <div class="shell${showMembers ? " with-members" : ""}${uiContext.state.callSnapshot?.state === "active" ? " has-call-bar" : ""}">
      <aside class="ws-rail">
        <button id="ws-rail-dm" class="ws-rail-icon ws-rail-home${dmMode ? " active" : ""}" data-tooltip="Личные сообщения" aria-label="Личные сообщения">
          ${icon("users")}
          ${dmBadge}
        </button>
        <div class="ws-rail-divider"></div>
        ${uiContext.state.workspaces
          .map((ws) => {
            const active =
              !dmMode && ws.id === uiContext.state.selectedWorkspaceId
                ? " active"
                : "";
            const mediaAttr = ws.avatarMediaId
              ? ` data-avatar-media="${escapeHtml(ws.avatarMediaId)}"`
              : "";
            return `
          <button class="ws-rail-icon${active}" data-ws="${ws.id}"${mediaAttr} data-tooltip="${escapeHtml(ws.name)}" aria-label="${escapeHtml(ws.name)}">
            <span class="ws-rail-letter">${escapeHtml(ws.name.charAt(0).toUpperCase())}</span>
          </button>
        `;
          })
          .join("")}
        <div class="ws-rail-spacer"></div>
        <button id="ws-rail-create" class="ws-rail-icon ws-rail-add" data-tooltip="Создать воркспейс" aria-label="Создать воркспейс">+</button>
        <button id="ws-rail-invite" class="ws-rail-icon ws-rail-add" data-tooltip="Принять инвайт" aria-label="Принять инвайт">↵</button>
      </aside>
      <aside class="ch-panel">
        <header class="ch-panel-header">
          ${
            dmMode || !selectedWorkspace
              ? `<span class="ch-panel-title">${dmMode ? "Личные сообщения" : "Нет воркспейса"}</span>`
              : `<button id="open-ws-menu" class="ch-panel-title ch-panel-menu-btn" aria-haspopup="menu" aria-expanded="${uiContext.state.workspaceMenuOpen ? "true" : "false"}">
                 <span>${escapeHtml(selectedWorkspace.name)}</span>
                 <span class="ch-panel-menu-glyph">${uiContext.state.workspaceMenuOpen ? "▴" : "▾"}</span>
               </button>`
          }
          ${uiContext.state.workspaceMenuOpen && !dmMode && selectedWorkspace ? renderWorkspaceHeaderMenu(selectedWorkspace, canModerate) : ""}
        </header>
        <div class="ch-panel-body">
          <div id="region-channels">
          ${
            dmMode
              ? renderDMSidebarList()
              : uiContext.state.selectedWorkspaceId
                ? renderChannelsBlock()
                : `<div class="ch-panel-empty">Выбери воркспейс слева или создай новый кнопкой +.</div>`
          }
          </div>
          <div id="region-voice">${renderVoiceStrip()}</div>
        </div>
        <footer class="user-strip">
          <button id="open-status" class="user user-btn" data-tooltip="Изменить статус">
            <span class="user-strip-avatar-wrap">
              ${renderAvatar({
                avatarMediaId: me?.avatarMediaId,
                fallbackText: me?.displayName || me?.username || "?",
                sizePx: 32,
              })}
              <span class="presence-dot ${presenceDotClass(me?.presenceMode)}"></span>
            </span>
            <div class="user-strip-name">
              <div class="user-name">${escapeHtml(me?.displayName || me?.username || "—")}</div>
              <div class="user-sub">${me?.customStatus ? escapeHtml(me.customStatus) : presenceLabel(me?.presenceMode)}</div>
            </div>
          </button>
          <div class="user-strip-actions">
            ${renderBellButton()}
            ${me?.isRoot ? `<button id="open-admin" class="ghost" data-tooltip="Админ-панель" aria-label="Админ-панель">${icon("shield")}</button>` : ""}
            <button id="open-profile" class="ghost" data-tooltip="Настройки" aria-label="Настройки">${icon("settings")}</button>
          </div>
        </footer>
      </aside>
      <main class="content">
        ${
          selectedChannel
            ? renderChannelView(selectedChannel)
            : selectedDM
              ? renderDMChannelView(selectedDM)
              : dmMode
                ? renderDMHome()
                : renderEmpty()
        }
      </main>
      ${showMembers ? renderMemberSidebar() : ""}
      <div id="region-status">${uiContext.state.status ? `<div class="status-bar">${escapeHtml(uiContext.state.status)}</div>` : ""}</div>
      <div id="region-modal">${renderModal()}</div>
      <div id="region-call">${renderCallOverlay()}</div>
      ${renderChannelMenu()}
      ${renderWorkspaceMenu()}
      ${renderMemberMenu()}
      ${renderCategoryMenu()}
      ${renderVoiceVolumeMenu()}
      ${renderStatusMenu()}
    </div>
  `,
  );
  rememberRenderedRows();
  attachShellHandlers();
  attachVoiceVideoStreams();
  updatePttIndicator();
  polishListboxes(uiContext.rootEl);
  polishNativeControls(uiContext.rootEl);
}

export function renderRegions(regions: ReadonlySet<RenderRegion>): void {
  const patch = (selector: string, html: string) => {
    const el = uiContext.rootEl.querySelector<HTMLElement>(selector);
    if (el) patchChildren(el, html);
  };
  if (regions.has("messages")) updateMessageList();
  if (regions.has("pins"))
    patch(
      "#region-pins",
      uiContext.state.pinsPopupOpen &&
        uiContext.state.channelPinsChannelId ===
          uiContext.state.selectedChannelId
        ? renderPinsPopup()
        : "",
    );
  if (regions.has("members")) {
    const el = uiContext.rootEl.querySelector<HTMLElement>(".member-sidebar");
    if (el) patchElement(el, renderMemberSidebar());
  }
  if (regions.has("channels"))
    patch(
      "#region-channels",
      uiContext.state.dmMode ? renderDMSidebarList() : renderChannelsBlock(),
    );
  if (regions.has("voice")) {
    patch("#region-voice", renderVoiceStrip());
    const channel = uiContext.state.channels.find(
      (c) => c.id === uiContext.state.selectedChannelId,
    );
    if (channel?.kind === "voice")
      patch("main.content", renderVoiceChannelView(channel));
  }
  if (regions.has("call")) {
    patch("#region-call", renderCallOverlay());
    uiContext.rootEl
      .querySelector(".shell")
      ?.classList.toggle(
        "has-call-bar",
        uiContext.state.callSnapshot?.state === "active",
      );
  }
  if (regions.has("modal")) patch("#region-modal", renderModal());
  patch(
    "#region-status",
    uiContext.state.status
      ? '<div class="status-bar">' +
          escapeHtml(uiContext.state.status) +
          "</div>"
      : "",
  );
  if (regions.has("members")) {
    attachMembersRegion();
    attachMemberMenuRegion();
  }
  if (regions.has("channels")) {
    attachSidebarRegion();
    attachFriendsRegion();
    attachWorkspaceCreateRegion();
  }
  if (regions.has("voice") || regions.has("call")) attachCallsRegion();
  if (regions.has("modal")) attachShellHandlers();
  if (regions.has("members") || regions.has("channels"))
    hydrateMedia(uiContext.rootEl);
  attachVoiceVideoStreams();
  updatePttIndicator();
}
