import { confirmDialog } from "../dialogs";
import { bindEvent, delegate } from "../dom";
import { describeError } from "../errors";
import { inviteExpiresAt } from "../invites";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type {
  Channel,
  ChannelPermissionsView,
  ChannelSettingsTab,
  ChannelUserPermissionsView,
  Invite,
  PermDraft,
  RoleOverride,
} from "../types";
import { escapeHtml } from "../util/html";
import { permDraftToList } from "../util/permissions";
import { describePeer } from "./callView";
import {
  channelPrefix,
  renderInviteRow,
  renderInviteTtlSelect,
} from "./channelView";
import { setTransientStatus } from "./helpers";
import { loadInvites } from "./loaders";
import { canWorkspace, unavailablePermissionsModal } from "./capabilities";

export function renderChannelSettingsModal(): string {
  const cs = uiContext.state.channelSettings;
  const channel = uiContext.state.channels.find((c) => c.id === cs.channelId);
  if (channel && !canWorkspace("channel.update", channel.workspaceId)) return unavailablePermissionsModal();
  const title = channel
    ? `Настройки · ${channelPrefix(channel)} ${escapeHtml(channel.name)}`
    : "Настройки канала";
  const allowedTabs = uiContext.CHANNEL_SETTINGS_TABS.filter((tab) => !channel ||
    canWorkspace(tab.id === "delete" ? "channel.delete" : tab.id === "invites" ? "invite.manage" : "channel.update", channel.workspaceId));
  if (!allowedTabs.some((tab) => tab.id === cs.tab)) cs.tab = "overview";
  const tabsHtml = allowedTabs.map(
    (t) => `
    <button class="ws-settings-tab ${cs.tab === t.id ? "active" : ""} ${t.danger ? "danger" : ""}"
            data-cs-tab="${t.id}">
      ${escapeHtml(t.label)}
    </button>
  `,
  ).join("");

  let body = "";
  if (cs.tab === "overview") body = renderChannelSettingsOverview();
  else if (cs.tab === "permissions")
    body = cs.loading
      ? `<div class="search-empty">Загрузка…</div>`
      : cs.data
        ? renderChannelPermissionsTable()
        : `<div class="search-empty">Нет данных</div>`;
  else if (cs.tab === "invites") body = renderChannelSettingsInvites();
  else if (cs.tab === "delete") body = renderChannelSettingsDelete();

  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide channel-settings-modal ws-settings" role="dialog">
        <div class="modal-header">
          <h3>${title}</h3>
          <div class="modal-header-actions">
            <button class="ghost modal-close-btn" data-modal-close>✕</button>
          </div>
        </div>
        ${cs.error ? `<div class="admin-error">${escapeHtml(cs.error)}</div>` : ""}
        <div class="ws-settings-shell">
          <aside class="ws-settings-tabs">${tabsHtml}</aside>
          <div class="ws-settings-body">${body}</div>
        </div>
      </div>
    </div>
  `;
}

export function renderChannelSettingsOverview(): string {
  const cs = uiContext.state.channelSettings;
  const draft = cs.overviewDraft;
  const channel = uiContext.state.channels.find((c) => c.id === cs.channelId);
  if (!channel) return `<div class="search-empty">Канал не найден</div>`;
  const slowOpts = uiContext.SLOW_MODE_OPTIONS.map(
    (o) =>
      `<option value="${o.value}" ${draft.slowMode === o.value ? "selected" : ""}>${escapeHtml(o.label)}</option>`,
  ).join("");
  return `
    <div class="settings-section">
      <h3>Имя</h3>
      <input id="cs-name" type="text" maxlength="64" value="${escapeHtml(draft.name)}" placeholder="имя-канала" />
      <small class="settings-hint">1–64 символа. Изменение запостит system-сообщение в чат.</small>
    </div>
    <div class="settings-section">
      <h3>Тема канала</h3>
      <textarea id="cs-topic" maxlength="256" rows="2" placeholder="чем занимается канал…">${escapeHtml(draft.topic)}</textarea>
      <small class="settings-hint"><span id="cs-topic-counter">${draft.topic.length}</span>/256</small>
    </div>
    <div class="settings-section">
      <h3>Категория</h3>
      <select id="cs-category" class="settings-select">
        <option value="" ${draft.categoryId === "" ? "selected" : ""}>Без категории</option>
        ${[...uiContext.state.categories]
          .sort(
            (a, b) => a.position - b.position || a.name.localeCompare(b.name),
          )
          .map(
            (c) =>
              `<option value="${escapeHtml(c.id)}" ${draft.categoryId === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`,
          )
          .join("")}
      </select>
      <small class="settings-hint">Группа в sidebar'е. Каналы без категории идут отдельным блоком сверху.</small>
    </div>
    <div class="settings-section">
      <h3>Цвет названия</h3>
      <div class="cs-color-row">
        <input id="cs-color" type="color" value="${escapeHtml(draft.nameColor || "#8e9297")}" />
        <button id="cs-color-reset" class="ghost" ${draft.nameColor ? "" : "disabled"}>Сбросить</button>
      </div>
      <small class="settings-hint">Цвет имени канала в списке слева. «Сбросить» вернёт цвет темы.</small>
    </div>
    <div class="settings-section">
      <h3>Медленный режим</h3>
      <select id="cs-slowmode" class="settings-select">${slowOpts}</select>
      <small class="settings-hint">
        Пауза между сообщениями одного автора. Модераторы (право «Удалять чужие сообщения») не затрагиваются.
      </small>
    </div>
    <div class="settings-section">
      <h3>18+ канал</h3>
      <label class="settings-check">
        <input type="checkbox" id="cs-nsfw" ${draft.isNsfw ? "checked" : ""} />
        <span>Контент 18+ — клиент покажет предупреждение при входе</span>
      </label>
      <small class="settings-hint">Per-channel подтверждение хранится локально в браузере участника.</small>
    </div>
    <div class="admin-actions">
      <button id="cs-overview-save" class="primary" ${cs.saving ? "disabled" : ""}>
        ${cs.saving ? "Сохраняю…" : "Сохранить"}
      </button>
    </div>
  `;
}

// J.3(a): таб «Приглашения» в channel-settings — отдельные инвайты,
// привязанные именно к этому каналу. accept приватного канала добавит
// юзера в channel_members; для публичного просто откроет канал.
export function renderChannelSettingsInvites(): string {
  const cs = uiContext.state.channelSettings;
  if (!cs.channelId) return `<div class="search-empty">Канал не найден</div>`;
  const channelInvites = uiContext.state.invites.filter(
    (i) => i.channelId === cs.channelId && !i.revokedAt,
  );
  const list =
    channelInvites.length === 0
      ? `<div class="invites-empty">Нет персональных инвайтов на этот канал.</div>`
      : `<ul class="invite-list">${channelInvites.map(renderInviteRow).join("")}</ul>`;
  return `
    <div class="settings-section">
      <h3>Инвайты на этот канал</h3>
      <small class="settings-hint">
        Код ведёт прямо в канал. Если канал приватный, приглашённый
        автоматически добавляется в channel_members.
      </small>
      <form id="cs-create-channel-invite" class="inline-form" style="margin-top:12px">
        <input name="maxUses" type="number" min="0" max="10000" placeholder="макс. использований (0 = ∞)" />
        ${renderInviteTtlSelect()}
        <button type="submit" class="primary">Создать инвайт</button>
      </form>
      <div style="margin-top:12px">${list}</div>
    </div>
  `;
}

export function renderChannelSettingsDelete(): string {
  const cs = uiContext.state.channelSettings;
  const ch = uiContext.state.channels.find((c) => c.id === cs.channelId);
  if (!ch) return `<div class="search-empty">Канал не найден</div>`;
  return `
    <div class="settings-section">
      <h3 style="color:#ed4245">Опасная зона</h3>
      <p class="settings-hint">
        История сообщений и вложений канала <strong>#${escapeHtml(ch.name)}</strong>
        удалится безвозвратно. Восстановить нельзя.
      </p>
      <div class="admin-actions">
        <button id="cs-delete-btn" class="danger">Удалить канал</button>
      </div>
    </div>
  `;
}

// Лейбл роли: системные — из словаря, кастомные — имя из wsRoles.
export function roleLabel(code: string): string {
  return (
    uiContext.ROLE_LABELS_RU[code] ??
    uiContext.state.wsRoles.find((r) => r.code === code)?.name ??
    code
  );
}

// Универсальная таблица «действия × колонки» с inherit/grant/deny селектами.
// selClass различает таблицы (роли канала / юзеры канала / роли категории)
// в обработчиках; data-key — roleCode либо userId.
export function renderPermGrid(
  actions: string[],
  columns: Array<{ key: string; label: string }>,
  draft: PermDraft,
  selClass: string,
): string {
  const head = `<tr>
    <th class="perm-action-col">Действие</th>
    ${columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("")}
  </tr>`;
  const body = actions
    .map((a) => {
      const cells = columns
        .map((c) => {
          const value = draft[c.key]?.[a] ?? "inherit";
          return `
        <td data-permission-label="${escapeHtml(c.label)}">
          <select class="${selClass}" aria-label="${escapeHtml(uiContext.ACTION_LABELS_RU[a] ?? a)}: ${escapeHtml(c.label)}" data-key="${escapeHtml(c.key)}" data-action="${escapeHtml(a)}">
            <option value="inherit" ${value === "inherit" ? "selected" : ""}>Наследовать</option>
            <option value="grant" ${value === "grant" ? "selected" : ""}>Разрешить</option>
            <option value="deny" ${value === "deny" ? "selected" : ""}>Запретить</option>
          </select>
        </td>
      `;
        })
        .join("");
      return `<tr><td class="perm-action-col">${escapeHtml(uiContext.ACTION_LABELS_RU[a] ?? a)}</td>${cells}</tr>`;
    })
    .join("");
  return `<div class="perm-grid-container"><table class="perm-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

export function renderChannelPermissionsTable(): string {
  const cs = uiContext.state.channelSettings;
  if (!cs.data) return "";
  const { actions, roles } = cs.data;

  // Wave 5: секция точечных прав участников. Колонки — юзеры из userDraft
  // (существующие overrides + добавленные в этом сеансе).
  const overriddenIds = Object.keys(cs.userDraft);
  const userColumns = overriddenIds.map((uid) => ({
    key: uid,
    label: describePeer(uid),
  }));
  const addable = uiContext.state.members.filter(
    (m) => !overriddenIds.includes(m.userId),
  );
  const userSection = `
    <div class="perm-help" style="margin-top:18px">
      <strong>Права участников.</strong> Точечные правила для конкретного юзера —
      высший приоритет: его «Запретить» бьёт разрешения ролей, «Разрешить» —
      их запреты.
    </div>
    ${userColumns.length > 0 ? renderPermGrid(actions, userColumns, cs.userDraft, "perm-user-select") : `<div class="settings-hint" style="margin:8px 0">Пока нет точечных правил.</div>`}
    ${userColumns.length > 0 ? `<div class="admin-actions" style="margin-top:4px">${overriddenIds.map((uid) => `<button class="ghost" data-cs-user-remove="${uid}">✕ ${escapeHtml(describePeer(uid))}</button>`).join("")}</div>` : ""}
    ${
      addable.length > 0
        ? `
      <select id="cs-user-add" class="perm-select" style="margin-top:8px">
        <option value="">+ Добавить участника…</option>
        ${addable.map((m) => `<option value="${m.userId}">${escapeHtml(m.displayName || m.username)}</option>`).join("")}
      </select>`
        : ""
    }
  `;

  return `
    <div class="perm-help">
      «Наследовать» оставляет право от workspace-роли (и прав категории,
      если заданы). «Разрешить» даёт право, даже если базовая роль его не
      имеет. «Запретить» отнимает. Owner не подчиняется overrides.
    </div>
    ${renderPermGrid(
      actions,
      roles.map((r) => ({ key: r, label: roleLabel(r) })),
      cs.draft,
      "perm-select",
    )}
    ${userSection}
    <div class="admin-actions">
      <button id="channel-perm-save" class="primary" ${cs.saving ? "disabled" : ""}>
        ${cs.saving ? "Сохраняю…" : "Сохранить"}
      </button>
    </div>
  `;
}

export async function loadChannelPermissions(): Promise<void> {
  const cs = uiContext.state.channelSettings;
  if (!cs.channelId) return;
  try {
    // Wave 5: роль- и юзер-overrides тянем параллельно.
    const [data, userData] = await Promise.all([
      uiContext.httpClient.get<ChannelPermissionsView>(
        `/api/v1/channels/${cs.channelId}/permissions`,
      ),
      uiContext.httpClient.get<ChannelUserPermissionsView>(
        `/api/v1/channels/${cs.channelId}/user-permissions`,
      ),
    ]);
    if (uiContext.state.channelSettings !== cs) return;
    uiContext.state.channelSettings.data = data;
    uiContext.state.channelSettings.draft = buildDraftFromOverrides(data);
    uiContext.state.channelSettings.userData = userData;
    uiContext.state.channelSettings.userDraft = buildUserDraft(userData);
    uiContext.state.channelSettings.loading = false;
    uiContext.state.channelSettings.error = null;
  } catch (err) {
    if (uiContext.state.channelSettings !== cs) return;
    uiContext.state.channelSettings.loading = false;
    uiContext.state.channelSettings.error = describeError(err);
  }
  render();
}

// userDraft: ключи — только юзеры с override'ами (или добавленные в UI),
// в отличие от ролевого draft'а, где колонки фиксированы списком ролей.
export function buildUserDraft(data: ChannelUserPermissionsView): PermDraft {
  const draft: PermDraft = {};
  for (const ov of data.overrides) {
    draft[ov.userId] = {};
    for (const action of data.actions) draft[ov.userId][action] = "inherit";
    for (const a of ov.granted) draft[ov.userId][a] = "grant";
    for (const a of ov.denied) draft[ov.userId][a] = "deny";
  }
  return draft;
}

export function buildDraftFromOverrides(
  data: ChannelPermissionsView,
): Record<string, Record<string, "inherit" | "grant" | "deny">> {
  const draft: Record<
    string,
    Record<string, "inherit" | "grant" | "deny">
  > = {};
  for (const role of data.roles) {
    draft[role] = {};
    for (const action of data.actions) {
      draft[role][action] = "inherit";
    }
  }
  for (const ov of data.overrides) {
    if (!draft[ov.roleCode]) continue;
    for (const a of ov.granted) draft[ov.roleCode][a] = "grant";
    for (const a of ov.denied) draft[ov.roleCode][a] = "deny";
  }
  return draft;
}

export function draftToOverrides(): RoleOverride[] {
  const out: RoleOverride[] = [];
  const draft = uiContext.state.channelSettings.draft;
  for (const role of Object.keys(draft)) {
    const granted: string[] = [];
    const denied: string[] = [];
    for (const action of Object.keys(draft[role])) {
      const v = draft[role][action];
      if (v === "grant") granted.push(action);
      else if (v === "deny") denied.push(action);
    }
    if (granted.length === 0 && denied.length === 0) continue;
    out.push({ roleCode: role, granted, denied });
  }
  return out;
}

export function attachChannelSettingsHandlers(): void {
  // J.3: переключение табов внутри модалки. Loading permissions — лениво,
  // при первом заходе на «Права доступа».
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-cs-tab]",
    "click",
    (_event, btn) => {
      const tab = btn.dataset.csTab as ChannelSettingsTab | undefined;
      if (!tab) return;
      uiContext.state.channelSettings.tab = tab;
      uiContext.state.channelSettings.error = null;
      if (
        tab === "permissions" &&
        !uiContext.state.channelSettings.data &&
        !uiContext.state.channelSettings.loading
      ) {
        uiContext.state.channelSettings.loading = true;
        render();
        void loadChannelPermissions();
        return;
      }
      if (
        tab === "invites" &&
        uiContext.state.invites.length === 0 &&
        !uiContext.state.invitesLoading
      ) {
        // J.3(a): ленивая подгрузка ws-инвайтов чтобы отфильтровать
        // канал-скоупные. Дёргаем тот же loadInvites — он наполняет
        // state.invites; рендер отфильтрует.
        void loadInvites();
      }
      render();
    },
    "delegate-565256",
  );

  // J.3(a): per-channel invite create form.
  uiContext.rootEl.querySelector<HTMLFormElement>("#cs-create-channel-invite")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLFormElement>(
          "#cs-create-channel-invite",
        ),
        "submit",
        async (e) => {
          e.preventDefault();
          const wsId = uiContext.state.selectedWorkspaceId;
          const chId = uiContext.state.channelSettings.channelId;
          if (!wsId || !chId) return;
          const form = e.currentTarget as HTMLFormElement;
          const maxUsesRaw = (
            form.elements.namedItem("maxUses") as HTMLInputElement
          )?.value;
          const maxUses = Math.max(0, parseInt(maxUsesRaw ?? "0", 10) || 0);
          const expiresAt = inviteExpiresAt(
            (form.elements.namedItem("ttl") as HTMLSelectElement | null)?.value,
          );
          try {
            const created = await uiContext.httpClient.post<Invite>(
              `/api/v1/workspaces/${wsId}/invites`,
              { maxUses, channelId: chId, ...(expiresAt ? { expiresAt } : {}) },
            );
            uiContext.state.invites = [created, ...uiContext.state.invites];
            form.reset();
            render();
          } catch (err) {
            uiContext.state.channelSettings.error = describeError(err);
            render();
          }
        },
        "bind-564736",
      )
    : undefined;

  // Permissions <select>'ы — write напрямую без render() для сохранения фокуса.
  delegate<HTMLSelectElement, "change">(
    uiContext.rootEl,
    ".perm-select",
    "change",
    (_event, sel) => {
      const key = sel.dataset.key;
      const action = sel.dataset.action;
      if (!key || !action) return;
      const value = sel.value as "inherit" | "grant" | "deny";
      if (!uiContext.state.channelSettings.draft[key])
        uiContext.state.channelSettings.draft[key] = {};
      uiContext.state.channelSettings.draft[key][action] = value;
    },
    "delegate-567211",
  );
  // Wave 5: селекты точечных прав участников.
  delegate<HTMLSelectElement, "change">(
    uiContext.rootEl,
    ".perm-user-select",
    "change",
    (_event, sel) => {
      const key = sel.dataset.key;
      const action = sel.dataset.action;
      if (!key || !action) return;
      const value = sel.value as "inherit" | "grant" | "deny";
      if (!uiContext.state.channelSettings.userDraft[key])
        uiContext.state.channelSettings.userDraft[key] = {};
      uiContext.state.channelSettings.userDraft[key][action] = value;
    },
    "delegate-567709",
  );
  uiContext.rootEl.querySelector<HTMLSelectElement>("#cs-user-add")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLSelectElement>("#cs-user-add"),
        "change",
        (e) => {
          const uid = (e.currentTarget as HTMLSelectElement).value;
          if (!uid) return;
          const actions = uiContext.state.channelSettings.data?.actions ?? [];
          const row: Record<string, "inherit" | "grant" | "deny"> = {};
          for (const a of actions) row[a] = "inherit";
          uiContext.state.channelSettings.userDraft[uid] = row;
          render();
        },
        "bind-566715",
      )
    : undefined;
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-cs-user-remove]",
    "click",
    (_event, btn) => {
      const uid = btn.dataset.csUserRemove;
      if (!uid) return;
      delete uiContext.state.channelSettings.userDraft[uid];
      render();
    },
    "delegate-568602",
  );
  uiContext.rootEl.querySelector<HTMLButtonElement>("#channel-perm-save")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#channel-perm-save"),
        "click",
        () => {
          void saveChannelPermissions();
        },
        "bind-567402",
      )
    : undefined;

  // J.3: Overview tab handlers. Live-update draft без render() кроме save.
  const draft = uiContext.state.channelSettings.overviewDraft;
  uiContext.rootEl.querySelector<HTMLInputElement>("#cs-name")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#cs-name"),
        "input",
        (e) => {
          draft.name = (e.currentTarget as HTMLInputElement).value;
        },
        "bind-567672",
      )
    : undefined;
  const topicEl =
    uiContext.rootEl.querySelector<HTMLTextAreaElement>("#cs-topic");
  topicEl
    ? bindEvent(
        topicEl,
        "input",
        () => {
          draft.topic = topicEl.value;
          const counter =
            uiContext.rootEl.querySelector<HTMLSpanElement>(
              "#cs-topic-counter",
            );
          if (counter) counter.textContent = String(topicEl.value.length);
        },
        "bind-567903",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLSelectElement>("#cs-slowmode")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLSelectElement>("#cs-slowmode"),
        "change",
        (e) => {
          draft.slowMode = Number((e.currentTarget as HTMLSelectElement).value);
        },
        "bind-568136",
      )
    : undefined;
  // Wave 8: цвет имени. input — live в draft без render(); reset — draft=""
  // (DOM-mutate кнопки/пикера, чтобы не терять открытый picker).
  const colorEl = uiContext.rootEl.querySelector<HTMLInputElement>("#cs-color");
  const colorResetEl =
    uiContext.rootEl.querySelector<HTMLButtonElement>("#cs-color-reset");
  colorEl
    ? bindEvent(
        colorEl,
        "input",
        () => {
          draft.nameColor = colorEl.value;
          if (colorResetEl) colorResetEl.disabled = false;
        },
        "bind-568609",
      )
    : undefined;
  colorResetEl
    ? bindEvent(
        colorResetEl,
        "click",
        () => {
          draft.nameColor = "";
          if (colorEl) colorEl.value = "#8e9297";
          colorResetEl.disabled = true;
        },
        "bind-568750",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLSelectElement>("#cs-category")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLSelectElement>("#cs-category"),
        "change",
        (e) => {
          draft.categoryId = (e.currentTarget as HTMLSelectElement).value;
        },
        "bind-568910",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLInputElement>("#cs-nsfw")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#cs-nsfw"),
        "change",
        (e) => {
          draft.isNsfw = (e.currentTarget as HTMLInputElement).checked;
        },
        "bind-569080",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#cs-overview-save")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#cs-overview-save"),
        "click",
        () => {
          void saveChannelOverview();
        },
        "bind-569242",
      )
    : undefined;

  // J.3: delete tab — typed-confirm через dialogs.ts.
  uiContext.rootEl.querySelector<HTMLButtonElement>("#cs-delete-btn")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#cs-delete-btn"),
        "click",
        async () => {
          const cs = uiContext.state.channelSettings;
          const ch = uiContext.state.channels.find(
            (c) => c.id === cs.channelId,
          );
          if (!ch) return;
          const ok = await confirmDialog({
            title: "Удалить канал",
            body: `История сообщений и вложения канала #${ch.name} удалятся безвозвратно.`,
            confirmText: ch.name,
            confirmLabel: "Удалить",
            danger: true,
          });
          if (!ok) return;
          try {
            await uiContext.httpClient.del(`/api/v1/channels/${ch.id}`);
            uiContext.state.channels = uiContext.state.channels.filter(
              (c) => c.id !== ch.id,
            );
            if (uiContext.state.selectedChannelId === ch.id) {
              uiContext.state.selectedChannelId = null;
              uiContext.state.messages = [];
            }
            uiContext.state.modal = null;
          } catch (err) {
            uiContext.state.channelSettings.error = describeError(err);
          }
          render();
        },
        "bind-569434",
      )
    : undefined;
}

export async function saveChannelOverview(): Promise<void> {
  const cs = uiContext.state.channelSettings;
  if (!cs.channelId) return;
  const channel = uiContext.state.channels.find((c) => c.id === cs.channelId);
  if (!channel) return;
  const draft = cs.overviewDraft;
  const trimName = draft.name.trim();
  if (!trimName) {
    uiContext.state.channelSettings.error = "Имя канала не может быть пустым";
    render();
    return;
  }
  uiContext.state.channelSettings.saving = true;
  uiContext.state.channelSettings.error = null;
  render();
  // Patch только изменённые поля — иначе мы перетёрли бы concurrent-правки.
  const patch: Record<string, unknown> = {};
  if (trimName !== channel.name) patch.name = trimName;
  if ((draft.topic ?? "") !== (channel.topic ?? "")) patch.topic = draft.topic;
  if (draft.slowMode !== (channel.slowModeSeconds ?? 0))
    patch.slowModeSeconds = draft.slowMode;
  if (draft.isNsfw !== !!channel.isNsfw) patch.isNsfw = draft.isNsfw;
  // J.5: categoryId: "" = снять привязку (backend получит "" → NULL); UUID = переместить.
  if ((draft.categoryId || "") !== (channel.categoryId ?? ""))
    patch.categoryId = draft.categoryId;
  // Wave 8: nameColor: "" = сброс на цвет темы (backend получит "" → NULL).
  if ((draft.nameColor || "") !== (channel.nameColor ?? ""))
    patch.nameColor = draft.nameColor;
  if (Object.keys(patch).length === 0) {
    uiContext.state.channelSettings.saving = false;
    setTransientStatus("Без изменений");
    render();
    return;
  }
  try {
    const updated = await uiContext.httpClient.patch<Channel>(
      `/api/v1/channels/${cs.channelId}`,
      patch,
    );
    uiContext.state.channels = uiContext.state.channels.map((c) =>
      c.id === updated.id ? updated : c,
    );
    uiContext.state.channelSettings.saving = false;
    setTransientStatus("Сохранено");
  } catch (err) {
    uiContext.state.channelSettings.saving = false;
    uiContext.state.channelSettings.error = describeError(err);
  }
  render();
}

export async function saveChannelPermissions(): Promise<void> {
  const cs = uiContext.state.channelSettings;
  if (!cs.channelId || cs.saving) return;
  uiContext.state.channelSettings.saving = true;
  uiContext.state.channelSettings.error = null;
  render();
  try {
    // Wave 5: сохраняем оба слоя — роли и точечные права участников.
    const [data, userData] = await Promise.all([
      uiContext.httpClient.put<ChannelPermissionsView>(
        `/api/v1/channels/${cs.channelId}/permissions`,
        { overrides: draftToOverrides() },
      ),
      uiContext.httpClient.put<ChannelUserPermissionsView>(
        `/api/v1/channels/${cs.channelId}/user-permissions`,
        {
          overrides: permDraftToList(cs.userDraft).map(
            ({ key, granted, denied }) => ({ userId: key, granted, denied }),
          ),
        },
      ),
    ]);
    if (uiContext.state.channelSettings !== cs) return;
    uiContext.state.channelSettings.data = data;
    uiContext.state.channelSettings.draft = buildDraftFromOverrides(data);
    uiContext.state.channelSettings.userData = userData;
    uiContext.state.channelSettings.userDraft = buildUserDraft(userData);
    setTransientStatus("Права канала сохранены");
  } catch (err) {
    cs.error = describeError(err);
  } finally {
    cs.saving = false;
    if (uiContext.state.channelSettings === cs) render();
  }
}
