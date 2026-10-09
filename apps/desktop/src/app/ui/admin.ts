import type { IceCheckResult } from "../../call/iceCheck";
import { runIceCheck } from "../../call/iceCheck";
import type { ApiError } from "../../network/httpClient";
import { confirmDialog, promptDialog } from "../dialogs";
import { bindEvent, delegate } from "../dom";
import { describeError } from "../errors";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type {
  AdminCreateState,
  AdminTab,
  AdminUser,
  RetentionStats,
  ServerMetrics,
  ServerSettings,
} from "../types";
import { bytesToMb, mbToBytes } from "../units";
import { formatTime } from "../util/format";
import { escapeHtml } from "../util/html";
import { setTransientStatus } from "./helpers";

// ============================================================
// D.2 — Admin panel
// ============================================================

export function renderAdminModal(): string {
  const a = uiContext.state.admin;
  const tabs: { key: AdminTab; label: string }[] = [
    { key: "settings", label: "Настройки" },
    { key: "users", label: "Пользователи" },
    { key: "metrics", label: "Метрики" },
  ];
  const tabsHtml = tabs
    .map(
      (t) =>
        `<button class="admin-tab ${a.tab === t.key ? "active" : ""}" data-admin-tab="${t.key}">${t.label}</button>`,
    )
    .join("");
  let body = "";
  if (a.tab === "settings") body = renderAdminSettings();
  else if (a.tab === "users") body = renderAdminUsers();
  else if (a.tab === "metrics") body = renderAdminMetrics();

  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide admin-modal" role="dialog">
        <div class="modal-header">
          <h3>Админ-панель</h3>
          <div class="modal-header-actions">
            <button class="ghost modal-close-btn" data-modal-close>✕</button>
          </div>
        </div>
        <div class="admin-tabs">${tabsHtml}</div>
        ${a.error ? `<div class="admin-error">${escapeHtml(a.error)}</div>` : ""}
        <div class="modal-body admin-body">${body}</div>
      </div>
    </div>
  `;
}

export function renderAdminSettings(): string {
  const a = uiContext.state.admin;
  if (!a.settings) return `<div class="search-empty">Загрузка…</div>`;
  const s = { ...a.settings, ...a.settingsDraft };
  const updatedAt = a.settings.updatedAt
    ? formatTime(a.settings.updatedAt)
    : "—";
  const numberField = (
    key: keyof ServerSettings,
    label: string,
    hint?: string,
  ) => `
    <label class="admin-field">
      <span class="admin-field-label">${escapeHtml(label)}</span>
      <input type="number" min="0" name="${String(key)}" value="${String(s[key] ?? 0)}" />
      ${hint ? `<span class="admin-field-hint">${escapeHtml(hint)}</span>` : ""}
    </label>
  `;
  // Размеры хранятся в байтах, а вводятся в мегабайтах (см. units.ts).
  const megabytesField = (
    key: "maxAttachmentBytes" | "storageQuotaBytes",
    name: string,
    label: string,
    hint: string,
  ) => `
    <label class="admin-field">
      <span class="admin-field-label">${escapeHtml(label)}</span>
      <input type="number" min="0" step="any" name="${name}" value="${bytesToMb(Number(s[key] ?? 0))}" />
      <span class="admin-field-hint">${escapeHtml(hint)}</span>
    </label>
  `;
  const saving = a.settingsSaving ? "Сохраняю…" : "Сохранить";
  return `
    <form id="admin-settings-form" class="admin-form">
      <div class="admin-grid">
        ${numberField("maxUsers", "Лимит пользователей", "0 = безлимит")}
        ${numberField("maxWorkspaces", "Лимит воркспейсов", "0 = безлимит")}
        ${numberField("maxChannelsPerWorkspace", "Каналов на воркспейс", "0 = безлимит")}
        ${numberField("maxMessageBytes", "Размер сообщения, байт", "0 = безлимит")}
        ${megabytesField("maxAttachmentBytes", "maxAttachmentMb", "Размер вложения, МБ", "0 = безлимит")}
        ${megabytesField("storageQuotaBytes", "storageQuotaMb", "Квота хранилища, МБ", "0 = безлимит")}
        ${numberField("messageRetentionDays", "Срок хранения сообщений, дни", "0 = бессрочно")}
        <label class="admin-field admin-field-bool">
          <input type="checkbox" name="registrationOpen" ${s.registrationOpen ? "checked" : ""} />
          <span>Открытая регистрация</span>
        </label>
      </div>
      <div class="admin-actions">
        <span class="admin-meta">Обновлено: ${escapeHtml(updatedAt)}</span>
        <button type="submit" class="primary" ${a.settingsSaving ? "disabled" : ""}>${saving}</button>
      </div>
      ${a.settingsError ? `<div class="admin-error">${escapeHtml(a.settingsError)}</div>` : ""}
    </form>
  `;
}

export function newAdminCreate(
  patch: Partial<AdminCreateState> = {},
): AdminCreateState {
  return {
    open: false,
    busy: false,
    error: null,
    result: null,
    draft: {
      email: "",
      username: "",
      displayName: "",
      password: "",
      workspace: null,
      mustChange: true,
    },
    ...patch,
  };
}

export function renderAdminCreateUser(): string {
  const c = uiContext._adminCreate;
  if (c.result) {
    const r = c.result;
    return `
      <div class="admin-create-result">
        <div><strong>Пользователь @${escapeHtml(r.username)} создан.</strong></div>
        ${
          r.temporaryPassword
            ? `
          <div class="admin-field-hint">Временный пароль показывается один раз. Передай его человеку: при первом входе он задаст свой.</div>
          <div class="admin-temp-password">
            <code id="admin-temp-password">${escapeHtml(r.temporaryPassword)}</code>
            <button type="button" class="ghost" id="admin-temp-password-copy">Скопировать</button>
          </div>
        `
            : `
          <div class="admin-field-hint">${r.mustChangePassword ? "При первом входе потребуется сменить пароль." : "Пароль постоянный."}</div>
        `
        }
        <div class="admin-actions">
          <button type="button" class="primary" id="admin-create-done">Готово</button>
        </div>
      </div>
    `;
  }
  if (!c.open) return "";
  const d = c.draft;
  const chosenWorkspace =
    d.workspace ?? uiContext.state.selectedWorkspaceId ?? "";
  const workspaceOptions = uiContext.state.workspaces
    .map(
      (w) =>
        `<option value="${escapeHtml(w.id)}"${w.id === chosenWorkspace ? " selected" : ""}>${escapeHtml(w.name)}</option>`,
    )
    .join("");
  return `
    <form id="admin-create-user-form" class="admin-form admin-create-user" autocomplete="off">
      <div class="admin-grid">
        <label class="admin-field">
          <span class="admin-field-label">Email</span>
          <input name="email" type="email" required value="${escapeHtml(d.email)}" />
        </label>
        <label class="admin-field">
          <span class="admin-field-label">Имя пользователя</span>
          <input name="username" required minlength="3" maxlength="32" pattern="[a-z0-9_]{3,32}" value="${escapeHtml(d.username)}" />
          <span class="admin-field-hint">a–z, 0–9, _; 3–32 символа</span>
        </label>
        <label class="admin-field">
          <span class="admin-field-label">Отображаемое имя</span>
          <input name="displayName" maxlength="64" value="${escapeHtml(d.displayName)}" />
        </label>
        <label class="admin-field">
          <span class="admin-field-label">Пароль</span>
          <input name="password" type="text" autocomplete="off" value="${escapeHtml(d.password)}" />
          <span class="admin-field-hint">Пусто: сервер создаст временный пароль</span>
        </label>
        <label class="admin-field">
          <span class="admin-field-label">Воркспейс</span>
          <select name="workspace">
            <option value="">Без воркспейса</option>
            ${workspaceOptions}
          </select>
        </label>
        <label class="admin-field admin-field-bool">
          <input type="checkbox" name="mustChange"${d.mustChange ? " checked" : ""} />
          <span>Сменить пароль при первом входе</span>
        </label>
      </div>
      ${c.error ? `<div class="admin-error">${escapeHtml(c.error)}</div>` : ""}
      <div class="admin-actions">
        <button type="button" class="ghost" id="admin-create-cancel">Отмена</button>
        <button type="submit" class="primary"${c.busy ? " disabled" : ""}>${c.busy ? "Создаю…" : "Создать"}</button>
      </div>
    </form>
  `;
}

export function attachAdminCreateUserHandlers(): void {
  uiContext.rootEl.querySelector<HTMLButtonElement>("#admin-create-toggle")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#admin-create-toggle",
        ),
        "click",
        () => {
          uiContext._adminCreate = newAdminCreate({ open: true });
          render();
        },
        "bind-532966",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#admin-create-cancel")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#admin-create-cancel",
        ),
        "click",
        () => {
          uiContext._adminCreate = newAdminCreate();
          render();
        },
        "bind-533138",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#admin-create-done")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#admin-create-done"),
        "click",
        () => {
          uiContext._adminCreate = newAdminCreate();
          render();
        },
        "bind-533296",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#admin-temp-password-copy")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#admin-temp-password-copy",
        ),
        "click",
        async () => {
          const value =
            uiContext.rootEl.querySelector<HTMLElement>("#admin-temp-password")
              ?.textContent ?? "";
          try {
            await navigator.clipboard.writeText(value);
            setTransientStatus("Временный пароль скопирован");
          } catch {
            setTransientStatus(
              "Не удалось скопировать: выдели пароль и скопируй вручную",
            );
          }
        },
        "bind-533452",
      )
    : undefined;

  const form = uiContext.rootEl.querySelector<HTMLFormElement>(
    "#admin-create-user-form",
  );
  const syncDraft = (): void => {
    if (!form) return;
    const data = new FormData(form);
    uiContext._adminCreate.draft = {
      email: String(data.get("email") ?? ""),
      username: String(data.get("username") ?? ""),
      displayName: String(data.get("displayName") ?? ""),
      password: String(data.get("password") ?? ""),
      workspace: String(data.get("workspace") ?? ""),
      mustChange: data.get("mustChange") === "on",
    };
  };
  form ? bindEvent(form, "input", syncDraft, "bind-534416") : undefined;
  form ? bindEvent(form, "change", syncDraft, "bind-534462") : undefined;
  form
    ? bindEvent(
        form,
        "submit",
        async (event) => {
          event.preventDefault();
          if (uiContext._adminCreate.busy) return;
          syncDraft();
          const data = new FormData(form);
          const password = String(data.get("password") ?? "");
          const workspace = String(data.get("workspace") ?? "");
          const body: Record<string, unknown> = {
            email: String(data.get("email") ?? "").trim(),
            username: String(data.get("username") ?? "")
              .trim()
              .toLowerCase(),
            displayName:
              String(data.get("displayName") ?? "").trim() || undefined,
          };
          if (workspace) body.joinWorkspaceId = workspace;
          // Флаг имеет смысл только с явным паролем: сгенерированный всегда временный.
          if (password) {
            body.password = password;
            body.mustChangePassword = data.get("mustChange") === "on";
          }
          uiContext._adminCreate.busy = true;
          uiContext._adminCreate.error = null;
          render();
          try {
            const created = await uiContext.httpClient.post<{
              username: string;
              mustChangePassword: boolean;
              temporaryPassword?: string;
            }>("/api/v1/server/users", body);
            uiContext._adminCreate = newAdminCreate({
              result: {
                username: created.username,
                mustChangePassword: created.mustChangePassword,
                temporaryPassword: created.temporaryPassword,
              },
            });
            render();
            void loadAdminUsers();
          } catch (err) {
            uiContext._adminCreate.busy = false;
            if ((err as ApiError | null)?.status === 0) {
              // Ответ не дошёл, но сервер мог создать пользователя (и его временный
              // пароль уже потерян): повторное «Создать» даст конфликт.
              uiContext._adminCreate.error = `${describeError(err)}. Пользователь мог быть создан: проверь список, прежде чем создавать снова.`;
              void loadAdminUsers();
            } else {
              uiContext._adminCreate.error = describeError(err);
            }
            render();
          }
        },
        "bind-534509",
      )
    : undefined;
}

export function renderAdminUsers(): string {
  const a = uiContext.state.admin;
  const meId = uiContext.state.me?.id;
  const rows = a.users
    .map((u) => {
      const isMe = u.id === meId;
      const status = u.bannedAt
        ? `<span class="badge banned">забанен</span>`
        : u.activeSession
          ? `<span class="badge active">активен</span>`
          : `<span class="badge">офлайн</span>`;
      const role = u.isRoot ? `<span class="badge root">root</span>` : "";
      const banBtn =
        u.isRoot || isMe
          ? ""
          : u.bannedAt
            ? `<button class="ghost admin-user-action" data-action="unban" data-user="${u.id}">Разбан</button>`
            : `<button class="ghost admin-user-action" data-action="ban" data-user="${u.id}">Бан</button>`;
      const delBtn =
        u.isRoot || isMe
          ? ""
          : `<button class="ghost danger admin-user-action" data-action="delete" data-user="${u.id}">Удалить</button>`;
      const display = u.displayName
        ? `${escapeHtml(u.displayName)} (@${escapeHtml(u.username)})`
        : `@${escapeHtml(u.username)}`;
      return `
      <tr>
        <td><div class="admin-user-cell"><div>${display}</div><div class="admin-user-email">${escapeHtml(u.email)}</div></div></td>
        <td>${role} ${status}</td>
        <td class="admin-user-meta">
          <div>Создан: ${escapeHtml(formatDate(u.createdAt))}</div>
          ${u.lastSeenAt ? `<div>Был: ${escapeHtml(formatTime(u.lastSeenAt))}</div>` : ""}
          ${u.bannedReason ? `<div class="admin-ban-reason">«${escapeHtml(u.bannedReason)}»</div>` : ""}
        </td>
        <td class="admin-user-actions">${banBtn}${delBtn}</td>
      </tr>
    `;
    })
    .join("");
  return `
    <div class="admin-users-toolbar">
      <input id="admin-users-search" type="search" placeholder="Поиск по email / username…" value="${escapeHtml(a.usersQuery)}" />
      <span class="admin-meta">Всего: ${a.usersTotal}</span>
      ${!uiContext._adminCreate.open && !uiContext._adminCreate.result ? `<button type="button" class="primary" id="admin-create-toggle">Создать пользователя</button>` : ""}
    </div>
    ${renderAdminCreateUser()}
    ${
      a.usersLoading
        ? `<div class="search-empty">Загрузка…</div>`
        : a.users.length === 0
          ? `<div class="search-empty">Никого не найдено</div>`
          : `<table class="admin-users-table">
          <thead><tr><th>Пользователь</th><th>Статус</th><th>Информация</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
    }
  `;
}

export function renderAdminMetrics(): string {
  const a = uiContext.state.admin;
  if (a.metricsLoading || !a.metrics)
    return `<div class="search-empty">Загрузка…</div>`;
  const m = a.metrics;
  const card = (label: string, value: string, sub?: string) => `
    <div class="admin-metric-card">
      <div class="admin-metric-label">${escapeHtml(label)}</div>
      <div class="admin-metric-value">${escapeHtml(value)}</div>
      ${sub ? `<div class="admin-metric-sub">${escapeHtml(sub)}</div>` : ""}
    </div>
  `;
  const storageSub =
    m.storageQuotaBytes > 0
      ? `Квота: ${formatBytesLarge(m.storageQuotaBytes)} (${Math.round((m.storageQuotaUsedRatio ?? 0) * 100)}%)`
      : `Без квоты`;
  return `
    <div class="admin-metric-grid">
      ${card("Пользователи", String(m.userCount), `Забанено: ${m.bannedUserCount}`)}
      ${card("Воркспейсы", String(m.workspaceCount))}
      ${card("Каналы", String(m.channelCount))}
      ${card("Сообщения", String(m.messageCount))}
      ${card("Активные сессии (24ч)", String(m.activeSessions24h))}
      ${card("Файлов", String(m.mediaObjectCount), `Размер: ${formatBytesLarge(m.storageBytes)}`)}
      ${card("Хранилище", formatBytesLarge(m.storageBytes), storageSub)}
      ${card("Размер БД", formatBytesLarge(m.databaseSizeBytes))}
    </div>
    <div class="admin-actions">
      <button id="admin-metrics-refresh" class="ghost">Обновить</button>
      <button id="admin-retention-run" class="ghost" ${a.retentionRunning ? "disabled" : ""}>
        ${a.retentionRunning ? "Чищу…" : "Запустить очистку"}
      </button>
      <button id="admin-ice-check" class="ghost" ${a.iceCheckRunning ? "disabled" : ""}>
        ${a.iceCheckRunning ? "Проверяю…" : "Проверить STUN/TURN"}
      </button>
    </div>
    ${
      a.retentionLast
        ? `
      <div class="admin-meta admin-retention-result">
        Удалено: ${a.retentionLast.messagesDeleted} сообщ., ${a.retentionLast.mediaDeleted} файлов
        (${formatBytesLarge(a.retentionLast.bytesFreed)})
      </div>
    `
        : ""
    }
    ${renderIceCheckResult(a.iceCheckResult)}
  `;
}

// Wave 0: панель результата ICE/TURN-диагностики под метриками.
export function renderIceCheckResult(r: IceCheckResult | null): string {
  if (!r) return "";
  const row = (ok: boolean, label: string, detail?: string) => `
    <div class="ice-check-row ${ok ? "ok" : "fail"}">
      <span class="ice-check-dot"></span>
      <span>${escapeHtml(label)}</span>
      ${detail ? `<span class="ice-check-detail">${escapeHtml(detail)}</span>` : ""}
    </div>
  `;
  if (r.error && r.serverUrls.length === 0) {
    return `<div class="ice-check-panel">${row(false, r.error)}</div>`;
  }
  const turnRow = !r.turnConfigured
    ? row(
        false,
        "TURN не сконфигурирован",
        "в /ice-servers нет turn:-URL — звонки между NAT не соединятся",
      )
    : r.relayOk
      ? row(
          true,
          "TURN-релей работает",
          r.relayAddress ? `relay ${r.relayAddress}` : undefined,
        )
      : row(
          false,
          "TURN не отвечает",
          "аллокация не прошла — проверь coturn, проброс портов (3478 + UDP relay-диапазон) и credentials",
        );
  return `
    <div class="ice-check-panel">
      ${row(r.stunOk, r.stunOk ? "STUN работает (внешний адрес получен)" : "STUN не отвечает")}
      ${turnRow}
      ${r.error ? row(false, r.error) : ""}
      <div class="ice-check-meta">
        Серверы: ${escapeHtml(r.serverUrls.join(", ") || "—")} · ${(r.elapsedMs / 1000).toFixed(1)}с
      </div>
    </div>
  `;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString();
}

export function formatBytesLarge(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export async function loadAdminTab(tab: AdminTab): Promise<void> {
  uiContext.state.admin.error = null;
  if (tab === "settings") await loadAdminSettings();
  else if (tab === "users") await loadAdminUsers();
  else if (tab === "metrics") await loadAdminMetrics();
}

export async function loadAdminSettings(): Promise<void> {
  try {
    const s = await uiContext.httpClient.get<ServerSettings>(
      "/api/v1/server/settings",
    );
    uiContext.state.admin.settings = s;
    uiContext.state.admin.settingsDraft = null;
    uiContext.state.admin.settingsError = null;
    render();
  } catch (err) {
    uiContext.state.admin.error = describeError(err);
    render();
  }
}

export async function loadAdminUsers(): Promise<void> {
  uiContext.state.admin.usersLoading = true;
  render();
  try {
    const q = uiContext.state.admin.usersQuery.trim();
    const url = q
      ? `/api/v1/server/users?q=${encodeURIComponent(q)}&limit=100`
      : `/api/v1/server/users?limit=100`;
    const resp = await uiContext.httpClient.get<{
      items: AdminUser[];
      total: number;
    }>(url);
    uiContext.state.admin.users = resp.items;
    uiContext.state.admin.usersTotal = resp.total;
  } catch (err) {
    uiContext.state.admin.error = describeError(err);
  } finally {
    uiContext.state.admin.usersLoading = false;
    render();
  }
}

export async function loadAdminMetrics(): Promise<void> {
  uiContext.state.admin.metricsLoading = true;
  render();
  try {
    uiContext.state.admin.metrics =
      await uiContext.httpClient.get<ServerMetrics>("/api/v1/server/metrics");
  } catch (err) {
    uiContext.state.admin.error = describeError(err);
  } finally {
    uiContext.state.admin.metricsLoading = false;
    render();
  }
}

export function attachAdminHandlers(): void {
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".admin-tab",
    "click",
    (_event, btn) => {
      const next = btn.dataset.adminTab as AdminTab;
      if (!next || uiContext.state.admin.tab === next) return;
      uiContext.state.admin.tab = next;
      uiContext.state.admin.error = null;
      render();
      void loadAdminTab(next);
    },
    "delegate-545533",
  );

  const settingsForm = uiContext.rootEl.querySelector<HTMLFormElement>(
    "#admin-settings-form",
  );
  if (settingsForm) {
    bindEvent(
      settingsForm,
      "submit",
      async (e) => {
        e.preventDefault();
        if (!uiContext.state.admin.settings) return;
        const data = new FormData(settingsForm);
        const numKeys: (keyof ServerSettings)[] = [
          "maxUsers",
          "maxWorkspaces",
          "maxChannelsPerWorkspace",
          "maxMessageBytes",
          "messageRetentionDays",
        ];
        const payload: Record<string, unknown> = {};
        for (const k of numKeys) {
          const raw = data.get(String(k));
          if (raw == null) continue;
          const v = Number(raw);
          if (Number.isFinite(v) && v >= 0) payload[k] = v;
        }
        // Размеры вводятся в МБ, на сервер уходят байты.
        for (const [field, key] of [
          ["maxAttachmentMb", "maxAttachmentBytes"],
          ["storageQuotaMb", "storageQuotaBytes"],
        ] as const) {
          const raw = String(data.get(field) ?? "");
          const bytes = mbToBytes(raw);
          // Поле показывает округлённое значение: нетронутое не отправляем, иначе
          // «Сохранить» молча меняло бы лимит (1 000 000 байт стали бы 996 147,
          // а значение меньше 5 КБ превратилось бы в 0, то есть в безлимит).
          const untouched =
            raw.trim().replace(",", ".") ===
            bytesToMb(Number(uiContext.state.admin.settings?.[key] ?? 0));
          if (bytes !== null && !untouched) payload[key] = bytes;
        }
        payload.registrationOpen = data.get("registrationOpen") === "on";
        uiContext.state.admin.settingsSaving = true;
        uiContext.state.admin.settingsError = null;
        render();
        try {
          uiContext.state.admin.settings =
            await uiContext.httpClient.put<ServerSettings>(
              "/api/v1/server/settings",
              payload,
            );
          uiContext.state.admin.settingsDraft = null;
        } catch (err) {
          uiContext.state.admin.settingsError = describeError(err);
        } finally {
          uiContext.state.admin.settingsSaving = false;
          render();
        }
      },
      "bind-544601",
    );
  }

  attachAdminCreateUserHandlers();

  const searchInput = uiContext.rootEl.querySelector<HTMLInputElement>(
    "#admin-users-search",
  );
  if (searchInput) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    bindEvent(
      searchInput,
      "input",
      () => {
        if (timer) clearTimeout(timer);
        const value = searchInput.value;
        timer = setTimeout(() => {
          uiContext.state.admin.usersQuery = value;
          void loadAdminUsers();
        }, 250);
      },
      "bind-546608",
    );
  }

  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".admin-user-action",
    "click",
    (_event, btn) => {
      const userId = btn.dataset.user;
      const action = btn.dataset.action;
      if (!userId || !action) return;
      void runAdminUserAction(userId, action);
    },
    "delegate-548257",
  );

  uiContext.rootEl.querySelector<HTMLButtonElement>("#admin-metrics-refresh")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#admin-metrics-refresh",
        ),
        "click",
        () => {
          void loadAdminMetrics();
        },
        "bind-547155",
      )
    : undefined;

  uiContext.rootEl.querySelector<HTMLButtonElement>("#admin-retention-run")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#admin-retention-run",
        ),
        "click",
        async () => {
          const ok = await confirmDialog({
            title: "Очистка по retention",
            body: "Старые сообщения и orphan-файлы будут удалены безвозвратно. Запустить сейчас?",
            confirmLabel: "Запустить",
            danger: true,
          });
          if (!ok) return;
          void runRetentionSweep();
        },
        "bind-547294",
      )
    : undefined;

  uiContext.rootEl.querySelector<HTMLButtonElement>("#admin-ice-check")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#admin-ice-check"),
        "click",
        () => {
          void runAdminIceCheck();
        },
        "bind-547686",
      )
    : undefined;
}

export async function runAdminIceCheck(): Promise<void> {
  if (uiContext.state.admin.iceCheckRunning) return;
  uiContext.state.admin.iceCheckRunning = true;
  uiContext.state.admin.iceCheckResult = null;
  render();
  try {
    uiContext.state.admin.iceCheckResult = await runIceCheck(
      uiContext.httpClient,
    );
  } finally {
    uiContext.state.admin.iceCheckRunning = false;
    render();
  }
}

export async function runRetentionSweep(): Promise<void> {
  uiContext.state.admin.retentionRunning = true;
  uiContext.state.admin.error = null;
  render();
  try {
    uiContext.state.admin.retentionLast =
      await uiContext.httpClient.post<RetentionStats>(
        "/api/v1/server/retention/run",
        {},
      );
    await loadAdminMetrics();
  } catch (err) {
    uiContext.state.admin.error = describeError(err);
  } finally {
    uiContext.state.admin.retentionRunning = false;
    render();
  }
}

export async function runAdminUserAction(
  userId: string,
  action: string,
): Promise<void> {
  try {
    if (action === "ban") {
      const reasonRaw = await promptDialog({
        title: "Бан пользователя",
        label: "Причина (необязательно)",
        placeholder: "будет показана в audit-логе",
        multiline: true,
      });
      if (reasonRaw === null) return;
      const reason = reasonRaw.trim();
      await uiContext.httpClient.post(
        `/api/v1/server/users/${userId}/ban`,
        reason ? { reason } : {},
      );
    } else if (action === "unban") {
      await uiContext.httpClient.post(
        `/api/v1/server/users/${userId}/unban`,
        {},
      );
    } else if (action === "delete") {
      const ok = await confirmDialog({
        title: "Удалить пользователя",
        body: "Аккаунт, его сообщения и медиа исчезнут. Восстановить нельзя.",
        confirmLabel: "Удалить",
        danger: true,
      });
      if (!ok) return;
      await uiContext.httpClient.del(`/api/v1/server/users/${userId}`);
    } else {
      return;
    }
    await loadAdminUsers();
  } catch (err) {
    uiContext.state.admin.error = describeError(err);
    render();
  }
}
