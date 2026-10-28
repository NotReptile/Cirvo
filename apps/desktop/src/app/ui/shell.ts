import { participantVolumes } from "../../call/participantVolumes";
import { bindEvent } from "../dom";
import { t } from "../i18n";
import { queueRender, requestRender as render } from "../runtime";
import { uiContext } from "../state";
import { resolveUserPresence } from "../presence";
import type {
  AvatarOpts,
  Member,
  PresenceMode,
  UserProfileData,
  WorkspaceRole,
} from "../types";
import { escapeHtml } from "../util/html";
import { badgeHtml, nameGradientStyle } from "./callView";
import { channelPrefix } from "./channelView";
import { dmsByPeer, membersById } from "./indexes";
import { isNotifLevel } from "./loaders";
import { canWorkspace } from "./capabilities";

// Полиш-проход по свежему innerHTML: гасим браузерные артефакты нативных
// элементов, которые размечать в каждом шаблоне вручную слишком шумно.
export function polishNativeControls(root: ParentNode): void {
  // Спеллчек-подчёркивание уместно только там, где пишут прозу: композер
  // (input name="body") и textarea (bio, посты). Логины, поиск, url, emoji
  // подчёркиваются красным без смысла.
  for (const el of root.querySelectorAll<HTMLInputElement>("input")) {
    if (el.name === "body") continue;
    el.spellcheck = false;
  }
  // a11y: тултипы переехали из title в data-tooltip — иконочным кнопкам без
  // текста возвращаем accessible name.
  for (const el of root.querySelectorAll<HTMLElement>(
    "[data-tooltip]:not([aria-label])",
  )) {
    if (!el.textContent?.trim()) {
      el.setAttribute("aria-label", el.getAttribute("data-tooltip") ?? "");
    }
  }
  // Кастомному треку слайдера нужна стартовая позиция заливки.
  for (const el of root.querySelectorAll<HTMLInputElement>(
    'input[type="range"]',
  )) {
    setSliderFill(el);
  }
}

// Заливка прогресса слайдера: CSS-градиент трека читает --val в процентах.
export function setSliderFill(el: HTMLInputElement): void {
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const value = Number(el.value);
  const pct =
    max > min
      ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))
      : 0;
  el.style.setProperty("--val", `${pct}%`);
}

export function installNativeGuards(): void {
  if (uiContext.nativeGuardsInstalled) return;
  uiContext.nativeGuardsInstalled = true;
  bindEvent(
    window,
    "contextmenu",
    (e) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      // В полях ввода нативное меню полезно: вставка, спеллчек-замены.
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      // Выделенный текст: оставляем нативное «Копировать».
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      e.preventDefault();
    },
    "bind-136893",
  );
  bindEvent(
    window,
    "dragover",
    (e) => {
      if (e.target instanceof HTMLElement && e.target.closest("main.content"))
        return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
    },
    "bind-137354",
  );
  bindEvent(
    window,
    "drop",
    (e) => {
      if (e.target instanceof HTMLElement && e.target.closest("main.content"))
        return;
      e.preventDefault();
    },
    "bind-137576",
  );
  // Живое обновление заливки слайдеров: войс-настройки меняют value без
  // render(), полиш-проход это не догоняет. document — чтобы достать и
  // слайдеры в диалогах вне rootEl.
  bindEvent(
    document,
    "input",
    (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type === "range")
        setSliderFill(e.target);
    },
    "bind-137916",
  );
}

// Меню громкости ПКМ на участнике: «Голос» и «Звук стрима» (0–200%),
// у 1-к-1 звонка — один регулятор. Значения по userId, см. participantVolumes.
export function renderVoiceVolumeMenu(): string {
  const menu = uiContext.state.voiceVolumeMenu;
  if (!menu) return "";
  const row = (kind: string, label: string, value: number, hint = ""): string => {
    const pct = Math.round(value * 100);
    return `
      <div class="voice-volume-group">
        <div class="voice-volume-row">
          <span class="voice-volume-label">${label}</span>
          <span class="voice-volume-value">${pct}%</span>
        </div>
        <input type="range" min="0" max="200" step="1" value="${pct}"
          class="voice-volume-slider" data-volume-kind="${kind}" aria-label="${label}" />
        ${hint ? `<div class="voice-volume-hint">${hint}</div>` : ""}
      </div>`;
  };
  let body: string;
  if (menu.userId) {
    const p = uiContext.state.voiceSnapshot?.participants.find((x) => x.sessionId === menu.key);
    const sharing = !!p?.screenSharing;
    const hasScreenAudio = !!uiContext.voiceMgr.getRemoteAudioTracks(menu.key).screen;
    body =
      row("voice", "Голос", participantVolumes.get(menu.userId, "voice")) +
      (sharing
        ? row(
            "screen",
            "Звук стрима",
            participantVolumes.get(menu.userId, "screen"),
            hasScreenAudio ? "" : "В демонстрации нет звука",
          )
        : "");
  } else {
    body = row("call", "Громкость", uiContext.state.voiceVolumes[menu.key] ?? 1);
  }
  return `
    <div class="channel-menu-backdrop" data-voice-volume-close></div>
    <div class="voice-volume-menu" style="left:${menu.x}px;top:${menu.y}px;" role="menu">
      <div class="channel-menu-header">${escapeHtml(menu.label)}</div>
      ${body}
      <button class="channel-menu-item" data-voice-volume-reset>Сбросить</button>
    </div>
  `;
}

// H.8: цвет точки/метка для presence-mode. Для отсутствующего значения
// (старые серверы без миграции 21) считаем "online" если есть active
// session, иначе "offline" — поведение совпадает с pre-H.8.
export function presenceDotClass(
  mode: PresenceMode | undefined | null,
): string {
  switch (mode) {
    case "online":
      return "presence-online";
    case "idle":
      return "presence-idle";
    case "dnd":
      return "presence-dnd";
    case "invisible":
    case "offline":
      return "presence-offline";
    default:
      return "presence-online";
  }
}

export function presenceLabel(mode: PresenceMode | undefined | null): string {
  switch (mode) {
    case "online":
      return "В сети";
    case "idle":
      return "Неактивен";
    case "dnd":
      return "Не беспокоить";
    case "invisible":
      return "Невидимый";
    case "offline":
      return "Не в сети";
    default:
      return "В сети";
  }
}

export function renderStatusMenu(): string {
  const menu = uiContext.state.statusMenu;
  if (!menu) return "";
  const options = uiContext.PRESENCE_OPTIONS.map((opt) => {
    const active = menu.draftMode === opt.mode ? " active" : "";
    return `
      <button class="status-menu-option${active}" data-status-mode="${opt.mode}" role="menuitemradio" aria-checked="${menu.draftMode === opt.mode}">
        <span class="presence-dot ${presenceDotClass(opt.mode)}"></span>
        <span class="status-menu-text">
          <span class="status-menu-label">${escapeHtml(opt.label)}</span>
          <span class="status-menu-hint">${escapeHtml(opt.hint)}</span>
        </span>
      </button>
    `;
  }).join("");
  return `
    <div class="channel-menu-backdrop" data-status-menu-close></div>
    <div class="status-menu" style="left:${menu.x}px;top:${menu.y}px;" role="menu">
      <div class="status-menu-list">${options}</div>
      <div class="status-menu-separator"></div>
      <label class="status-menu-custom">
        <span class="status-menu-custom-label">Кастомный статус</span>
        <input id="status-custom-input" type="text" maxlength="64" placeholder="Например: «Играю в X»" value="${escapeHtml(menu.draftCustom)}" />
      </label>
      <div class="status-menu-actions">
        <button id="status-clear" class="ghost">Очистить</button>
        <button id="status-save" class="primary">Сохранить</button>
      </div>
    </div>
  `;
}

export function getRoleColor(
  roleCode: string | undefined | null,
): string | undefined {
  if (!roleCode) return undefined;
  if (uiContext.state.wsRoles.length > 0) {
    const role = uiContext.state.wsRoles.find((r) => r.code === roleCode);
    if (role) return role.color ?? undefined;
  }
  return uiContext.ROLE_COLORS_FALLBACK[roleCode];
}

export function getUserColor(
  userId: string,
  primaryRole: string | undefined | null,
): string | undefined {
  if (uiContext.state.wsRoles.length === 0) {
    return getRoleColor(primaryRole); // данные не загружены — fallback
  }
  if (!uiContext.userColorCache) uiContext.userColorCache = new Map();
  if (uiContext.userColorCache.has(userId))
    return uiContext.userColorCache.get(userId);
  let color: string | undefined;
  // wsRoles приходит с бэка отсортированным по position desc.
  for (const r of uiContext.state.wsRoles) {
    if (!r.color) continue;
    if (
      r.memberUserIds.includes(userId) ||
      (primaryRole && r.code === primaryRole)
    ) {
      color = r.color;
      break;
    }
  }
  uiContext.userColorCache.set(userId, color);
  return color;
}

export async function loadWsRoles(
  workspaceId: string,
  generation?: number,
): Promise<void> {
  try {
    const data = await uiContext.httpClient.get<{ items: WorkspaceRole[] }>(
      `/api/v1/workspaces/${workspaceId}/roles`,
    );
    // Race-guard: ответ устарел если юзер успел переключить воркспейс.
    if (
      uiContext.state.selectedWorkspaceId !== workspaceId ||
      (generation !== undefined && generation !== uiContext.syncGeneration)
    )
      return;
    uiContext.state.wsRoles = data.items ?? [];
    uiContext.userColorCache = null;
    queueRender("all");
  } catch {
    // Не критично — fallback к хардкоду в getRoleColor.
  }
}

export function decorationClass(id: string | undefined | null): string {
  if (!id) return "";
  return uiContext.AVATAR_DECORATIONS.some((d) => d.id === id)
    ? ` avatar-deco-${id}`
    : "";
}

export function renderAvatar(opts: AvatarOpts): string {
  const letter = (opts.fallbackText || "?").charAt(0).toUpperCase();
  const dot =
    opts.online === undefined || opts.online === null
      ? ""
      : `<span class="avatar-dot${opts.online ? " on" : " off"}"></span>`;
  const cls =
    `avatar-pic ${opts.className ?? ""}`.trim() +
    decorationClass(opts.decoration);
  const style = `width:${opts.sizePx}px;height:${opts.sizePx}px;font-size:${Math.round(opts.sizePx * 0.45)}px;`;
  if (opts.avatarMediaId) {
    return `<span class="${cls} has-media" data-avatar-media="${escapeHtml(opts.avatarMediaId)}" style="${style}"><span class="avatar-letter">${escapeHtml(letter)}</span>${dot}</span>`;
  }
  return `<span class="${cls}" style="${style}"><span class="avatar-letter">${escapeHtml(letter)}</span>${dot}</span>`;
}

export function renderMemberSidebar(): string {
  if (uiContext.state.membersLoading && uiContext.state.members.length === 0) {
    return `<aside class="member-sidebar"><div class="member-sidebar-empty">Загрузка…</div></aside>`;
  }
  const sorted = [...uiContext.state.members].sort((a, b) => {
    const an = a.displayName || a.username;
    const bn = b.displayName || b.username;
    return an.localeCompare(bn, "ru");
  });
  const renderItem = (m: Member) => {
    const name = m.displayName || m.username;
    // Wave 7: градиент имени (личная кастомизация) приоритетнее role-цвета.
    const grad = nameGradientStyle(m.nameGradient);
    const color = getUserColor(m.userId, m.role);
    const style = grad || (color ? ` style="color:${color};"` : "");
    const presence = resolveUserPresence(m.userId, m);
    const effMode = presence.mode;
    const subline = presence.customStatus
      ? `<span class="member-sidebar-status">${escapeHtml(presence.customStatus)}</span>`
      : "";
    return `
      <li class="member-sidebar-item${presence.online ? "" : " offline"}" data-member-user="${escapeHtml(m.userId)}">
        <span class="member-sidebar-avatar-wrap">
          ${renderAvatar({
            avatarMediaId: m.avatarMediaId,
            fallbackText: name,
            sizePx: 28,
            decoration: m.avatarDecoration,
          })}
          <span class="presence-dot ${presenceDotClass(effMode)}"></span>
        </span>
        <span class="member-sidebar-body">
          <span class="member-sidebar-name"${style}>${escapeHtml(name)}</span>${badgeHtml(m.badgeEmoji, m.badgeLabel)}
          ${subline}
        </span>
      </li>
    `;
  };
  const renderGroup = (label: string, items: Member[]) =>
    items.length === 0
      ? ""
      : `<div class="member-sidebar-group">${escapeHtml(label)} — ${items.length}</div>
         <ul class="member-sidebar-list">${items.map(renderItem).join("")}</ul>`;
  // H.3 → Wave 5: секции строятся из hoisted-ролей воркспейса (включая
  // кастомные) по position desc. Онлайн-юзер попадает в секцию своей
  // высшей hoisted-роли (union: workspace_role_members + primary role);
  // остальные онлайн — «В сети», все офлайн — «Не в сети». Пока wsRoles
  // не загружен — fallback к жёсткой схеме owner/admin/moderator.
  const online = sorted.filter((m) => resolveUserPresence(m.userId, m).online);
  const offline = sorted.filter((m) => !resolveUserPresence(m.userId, m).online);
  let groupsHtml: string;
  if (uiContext.state.wsRoles.length > 0) {
    const hoisted = uiContext.state.wsRoles.filter((r) => r.hoisted); // уже position desc
    const used = new Set<string>();
    const sections: string[] = [];
    for (const role of hoisted) {
      const members = online.filter(
        (m) =>
          !used.has(m.userId) &&
          (role.memberUserIds.includes(m.userId) || m.role === role.code),
      );
      members.forEach((m) => used.add(m.userId));
      sections.push(renderGroup(role.name, members));
    }
    const rest = online.filter((m) => !used.has(m.userId));
    sections.push(renderGroup(t("members.online"), rest));
    groupsHtml = sections.join("");
  } else {
    const owners = online.filter((m) => m.role === "owner");
    const admins = online.filter((m) => m.role === "admin");
    const moderators = online.filter((m) => m.role === "moderator");
    const onlineMembers = online.filter(
      (m) => m.role !== "owner" && m.role !== "admin" && m.role !== "moderator",
    );
    groupsHtml =
      renderGroup(t("members.owner"), owners) +
      renderGroup(t("members.admins"), admins) +
      renderGroup(t("members.mods"), moderators) +
      renderGroup(t("members.online"), onlineMembers);
  }
  return `
    <aside class="member-sidebar">
      ${groupsHtml}
      ${renderGroup(t("members.offline"), offline)}
      ${uiContext.state.members.length === 0 ? `<div class="member-sidebar-empty">${t("members.none")}</div>` : ""}
    </aside>
  `;
}

export function renderChannelMenu(): string {
  const menu = uiContext.state.channelMenu;
  if (!menu) return "";
  const ch = uiContext.state.channels.find((c) => c.id === menu.channelId);
  if (!ch) return "";
  const ws = uiContext.state.workspaces.find((w) => w.id === ch.workspaceId);
  const canManage = !!ws && canWorkspace("channel.update", ws.id);
  const canModerate = !!ws && canWorkspace("invite.manage", ws.id);
  const hasUnread = (uiContext.state.unread[ch.id] ?? 0) > 0;
  // Wave 4: уровень уведомлений. Явный канальный выбор; пусто = наследовать
  // от воркспейса (показываем что унаследуется).
  const explicitLevel = uiContext.state.notifPrefs.channels[ch.id] ?? "";
  const inheritedLevel = isNotifLevel(
    uiContext.state.notifPrefs.workspaces[ch.workspaceId],
  )
    ? uiContext.state.notifPrefs.workspaces[ch.workspaceId]
    : "all";
  const notifItem = (lvl: string, label: string) =>
    `<button class="channel-menu-item notif-level${explicitLevel === lvl ? " checked" : ""}" data-channel-action="notif" data-id="${ch.id}" data-level="${lvl}">${explicitLevel === lvl ? "✓" : "·"} ${label}</button>`;
  return `
    <div class="channel-menu-backdrop" data-channel-menu-close></div>
    <div class="channel-menu" style="left:${menu.x}px;top:${menu.y}px;" role="menu">
      <div class="channel-menu-header">${channelPrefix(ch)} ${escapeHtml(ch.name)}</div>
      ${hasUnread ? `<button class="channel-menu-item" data-channel-action="mark-read" data-id="${ch.id}">${t("menu.markread")}</button>` : ""}
      ${canModerate ? `<button class="channel-menu-item" data-channel-action="invite" data-id="${ch.id}">${t("menu.invite")}</button>` : ""}
      <div class="channel-menu-separator"></div>
      <div class="channel-menu-subheader">${t("modal.notifications")}</div>
      ${notifItem("", t("menu.notif_inherit", { lvl: t(`notif.short.${inheritedLevel}`) }))}
      ${notifItem("all", t("notif.all"))}
      ${notifItem("mentions", t("notif.mentions"))}
      ${notifItem("none", t("notif.none"))}
      <div class="channel-menu-separator"></div>
      ${canManage ? `<button class="channel-menu-item" data-channel-action="rename" data-id="${ch.id}">${t("menu.rename")}</button>` : ""}
      ${ws && canWorkspace("channel.create", ws.id) ? `<button class="channel-menu-item" data-channel-action="clone" data-id="${ch.id}">${t("menu.clone")}</button>` : ""}
      ${canManage ? `<button class="channel-menu-item" data-channel-action="${ch.archivedAt ? "unarchive" : "archive"}" data-id="${ch.id}">${ch.archivedAt ? t("menu.unarchive") : t("menu.archive")}</button>` : ""}
      <button class="channel-menu-item" data-channel-action="copy-id" data-id="${ch.id}">${t("menu.copyid")}</button>
      ${ws && canWorkspace("channel.delete", ws.id) ? `<div class="channel-menu-separator"></div><button class="channel-menu-item danger" data-channel-action="delete" data-id="${ch.id}">${t("menu.delete_channel")}</button>` : ""}
    </div>
  `;
}

// H.2: ПКМ-меню на иконке воркспейса. Для owner/admin показывает действия
// «Загрузить иконку» / «Удалить иконку», остальным — «Скопировать ID».
export function renderWorkspaceMenu(): string {
  const menu = uiContext.state.workspaceMenu;
  if (!menu) return "";
  const ws = uiContext.state.workspaces.find((w) => w.id === menu.workspaceId);
  if (!ws) return "";
  const canManage = canWorkspace("workspace.update", ws.id);
  return `
    <input id="workspace-avatar-input" type="file" accept="image/*" hidden />
    <div class="channel-menu-backdrop" data-workspace-menu-close></div>
    <div class="channel-menu" style="left:${menu.x}px;top:${menu.y}px;" role="menu">
      <div class="channel-menu-header">${escapeHtml(ws.name)}</div>
      ${canManage ? `<button class="channel-menu-item" data-workspace-action="upload-icon" data-id="${ws.id}">${ws.avatarMediaId ? t("menu.icon.change") : t("menu.icon.upload")}</button>` : ""}
      ${canManage && ws.avatarMediaId ? `<button class="channel-menu-item" data-workspace-action="remove-icon" data-id="${ws.id}">${t("menu.icon.remove")}</button>` : ""}
      ${canManage ? `<button class="channel-menu-item" data-workspace-action="manage-roles" data-id="${ws.id}">${t("menu.manage_roles")}</button>` : ""}
      ${canManage ? `<button class="channel-menu-item" data-workspace-action="welcome-channel" data-id="${ws.id}">${t("menu.welcome_channel")}</button>` : ""}
      <div class="channel-menu-separator"></div>
      <div class="channel-menu-subheader">${t("menu.ws_notifications")}</div>
      ${(() => {
        const cur = uiContext.state.notifPrefs.workspaces[ws.id] ?? "";
        const item = (lvl: string, label: string) =>
          `<button class="channel-menu-item notif-level${cur === lvl ? " checked" : ""}" data-workspace-action="notif" data-id="${ws.id}" data-level="${lvl}">${cur === lvl ? "✓" : "·"} ${label}</button>`;
        return (
          item("", t("notif.all")) +
          item("mentions", t("notif.mentions")) +
          item("none", t("notif.none"))
        );
      })()}
      <div class="channel-menu-separator"></div>
      <button class="channel-menu-item" data-workspace-action="copy-id" data-id="${ws.id}">${t("menu.copyid")}</button>
    </div>
  `;
}

// Wave 5 (J.5b): ПКМ-меню категории — права + копирование ID.
export function renderCategoryMenu(): string {
  const menu = uiContext.state.categoryMenu;
  if (!menu) return "";
  const cat = uiContext.state.categories.find((c) => c.id === menu.categoryId);
  if (!cat) return "";
  const ws = uiContext.state.workspaces.find(
    (w) => w.id === uiContext.state.selectedWorkspaceId,
  );
  const canManage = !!ws && canWorkspace("channel.update", ws.id);
  return `
    <div class="channel-menu-backdrop" data-category-menu-close></div>
    <div class="channel-menu" style="left:${menu.x}px;top:${menu.y}px;" role="menu">
      <div class="channel-menu-header">${escapeHtml(cat.name)}</div>
      ${canManage ? `<button class="channel-menu-item" data-category-action="permissions" data-id="${cat.id}">${t("menu.cat_perms")}</button>` : ""}
      <button class="channel-menu-item" data-category-action="copy-id" data-id="${cat.id}">${t("menu.copyid")}</button>
    </div>
  `;
}

// Wave 5: ПКМ-меню участника (member-sidebar). Быстрые действия + чек-лист
// ролей (POST/DELETE /roles/{id}/members/{userId}) без захода в roles-модалку.
// Меню остаётся открытым после toggle'а роли — удобно навешивать несколько.
export function renderMemberMenu(): string {
  const menu = uiContext.state.memberMenu;
  if (!menu) return "";
  const m = uiContext.state.members.find((x) => x.userId === menu.userId);
  if (!m) return "";
  const ws = uiContext.state.workspaces.find(
    (w) => w.id === uiContext.state.selectedWorkspaceId,
  );
  const canManage = !!ws && canWorkspace("member.manage_role", ws.id);
  const isSelf = m.userId === uiContext.state.me?.id;
  const name = m.displayName || m.username;
  const rolesSection = (() => {
    if (!canManage || uiContext.state.wsRoles.length === 0) return "";
    const items = uiContext.state.wsRoles
      .filter((r) => r.code !== "owner") // owner не назначается (бэк вернёт 403)
      .map((r) => {
        const has = r.memberUserIds.includes(m.userId) || m.role === r.code;
        const isPrimary = m.role === r.code; // primary снимается только сменой роли
        const dot = r.color
          ? `<span class="role-color-dot" style="background:${r.color};"></span>`
          : "";
        return `<button class="channel-menu-item notif-level${has ? " checked" : ""}" data-member-action="toggle-role" data-id="${m.userId}" data-role-id="${r.id}" ${isPrimary && has ? `disabled data-tooltip="${t("menu.primary_role_hint")}"` : ""}>${has ? "✓" : "·"} ${dot}${escapeHtml(r.name)}</button>`;
      })
      .join("");
    return `<div class="channel-menu-separator"></div>
      <div class="channel-menu-subheader">${t("modal.roles")}</div>
      ${items}`;
  })();
  return `
    <div class="channel-menu-backdrop" data-member-menu-close></div>
    <div class="channel-menu" style="left:${menu.x}px;top:${menu.y}px;" role="menu">
      <div class="channel-menu-header">${escapeHtml(name)}</div>
      <button class="channel-menu-item" data-member-action="profile" data-id="${m.userId}">${t("menu.profile")}</button>
      ${isSelf ? "" : `<button class="channel-menu-item" data-member-action="dm" data-id="${m.userId}">${t("menu.dm")}</button>`}
      ${isSelf ? "" : `<button class="channel-menu-item" data-member-action="call" data-id="${m.userId}">${t("menu.call")}</button>`}
      <button class="channel-menu-item" data-member-action="copy-id" data-id="${m.userId}">${t("menu.copyid")}</button>
      ${rolesSection}
    </div>
  `;
}

export function resolvePeerAvatarMediaId(
  userId: string | null,
): string | undefined {
  if (!userId) return undefined;
  if (uiContext.state.me && userId === uiContext.state.me.id)
    return uiContext.state.me.avatarMediaId;
  const member = membersById().get(userId);
  if (member) return member.avatarMediaId;
  const dm = dmsByPeer().get(userId);
  if (dm) return dm.peer.avatarMediaId;
  if (!uiContext.peerProfileCache.has(userId)) {
    uiContext.peerProfileCache.set(userId, null);
    void uiContext.httpClient
      .get<UserProfileData>(`/api/v1/users/${userId}`)
      .then((p) => {
        uiContext.peerProfileCache.set(userId, p);
        render();
      })
      .catch(() => {
        /* останется letter-placeholder */
      });
  }
  return uiContext.peerProfileCache.get(userId)?.avatarMediaId;
}
