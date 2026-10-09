import { describeError } from "../errors";
import { t } from "../i18n";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type {
  AuditEntry,
  NotificationItem,
  SearchHit,
  SettingsSearchEntry,
  SettingsTab,
  SettingsTabDef,
  SettingsTabGroup,
} from "../types";
import { formatTime, formatTimeSmart } from "../util/format";
import { escapeHtml } from "../util/html";
import { describeAuditEntry, describePeer } from "./callView";
import { setTransientStatus } from "./helpers";
import { notificationBody, notificationTitle } from "./loaders";

export function renderNotificationsModal(): string {
  const items = uiContext.state.notifications;
  const body = (() => {
    if (uiContext.state.notificationsLoading)
      return `<div class="search-empty">${t("common.loading")}</div>`;
    if (items.length === 0)
      return `<div class="search-empty">${t("notifmodal.empty")}</div>`;
    return `<ul class="notif-list">
      ${items.map(renderNotificationItem).join("")}
    </ul>`;
  })();
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide" role="dialog">
        <div class="modal-header">
          <h3>${t("modal.notifications")}</h3>
          <div class="modal-header-actions">
            ${
              uiContext.state.notificationsUnread > 0
                ? `<button id="notif-mark-all" class="ghost">${t("notifmodal.markall")}</button>`
                : ""
            }
            <button class="ghost modal-close-btn" data-modal-close>✕</button>
          </div>
        </div>
        <div class="modal-body">${body}</div>
      </div>
    </div>
  `;
}

export function renderNotificationItem(n: NotificationItem): string {
  const unread = !n.readAt;
  const title = notificationTitle(n);
  const body = notificationBody(n);
  const kindIcon =
    n.kind === "call_incoming"
      ? "📞"
      : n.kind === "reply"
        ? "↩"
        : n.kind === "mention_everyone"
          ? "📣"
          : n.kind === "friend_request" || n.kind === "friend_accept"
            ? "👥"
            : "@";
  return `
    <li class="notif-item ${unread ? "unread" : ""}" data-notif-id="${n.id}">
      <span class="notif-kind">${kindIcon}</span>
      <div class="notif-body">
        <div class="notif-title">${escapeHtml(title)}</div>
        ${body ? `<div class="notif-snippet">${escapeHtml(body)}</div>` : ""}
        <div class="notif-time" data-tooltip="${escapeHtml(formatTime(n.createdAt))}">${escapeHtml(formatTimeSmart(n.createdAt))}</div>
      </div>
    </li>
  `;
}

export function renderSearchModal(): string {
  const ws = uiContext.state.workspaces.find(
    (w) => w.id === uiContext.state.selectedWorkspaceId,
  );
  if (!ws) return "";
  const { query, loading, hits, error } = uiContext.state.search;
  const body = (() => {
    if (error)
      return `<div class="search-empty error">${escapeHtml(error)}</div>`;
    if (loading)
      return `<div class="search-empty">${t("search.searching")}</div>`;
    if (query.trim().length < 2)
      return `<div class="search-empty">${t("search.minchars")}</div>`;
    if (hits.length === 0)
      return `<div class="search-empty">${t("search.none")}</div>`;
    return `<ul class="search-results">
      ${hits.map(renderSearchHit).join("")}
    </ul>`;
  })();
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide" role="dialog">
        <div class="modal-header">
          <h3>${t("modal.search")} · ${escapeHtml(ws.name)}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="modal-body">
          <input id="search-input" class="search-input" type="text" autocomplete="off"
                 placeholder="${t("search.placeholder")}" value="${escapeHtml(query)}" />
          ${body}
        </div>
      </div>
    </div>
  `;
}

export function renderSearchHit(hit: SearchHit): string {
  const author = describePeer(hit.authorId);
  // ts_headline вернул body с sentinel'ами ⟨MARK⟩…⟨/MARK⟩. Экранируем
  // ВСЁ как обычный текст, потом превращаем sentinel'ы в <mark>. Так в
  // <mark> попадают только escape'нутые куски пользовательского ввода.
  const safe = escapeHtml(hit.highlight || hit.body);
  const highlighted = safe
    .replace(/⟨MARK⟩/g, '<mark class="search-mark">')
    .replace(/⟨\/MARK⟩/g, "</mark>");
  return `
    <li class="search-hit" data-hit-id="${hit.id}" data-hit-channel="${hit.channelId}">
      <div class="search-hit-head">
        <span class="search-hit-channel">#${escapeHtml(hit.channelName)}</span>
        <span class="search-hit-author">${escapeHtml(author)}</span>
        <span class="search-hit-time" data-tooltip="${escapeHtml(formatTime(hit.createdAt))}">${escapeHtml(formatTimeSmart(hit.createdAt))}</span>
      </div>
      <div class="search-hit-body">${highlighted}</div>
    </li>
  `;
}

export function renderAuditModal(): string {
  const ws = uiContext.state.workspaces.find(
    (w) => w.id === uiContext.state.selectedWorkspaceId,
  );
  if (!ws) return "";
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide" role="dialog">
        <div class="modal-header">
          <h3>${t("modal.audit")} · ${escapeHtml(ws.name)}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="modal-body">
          ${renderAuditFilter()}
          ${
            uiContext.state.auditLoading
              ? `<div class="invites-empty">Загрузка…</div>`
              : (() => {
                  const filtered = applyAuditFilter(
                    uiContext.state.auditEntries,
                  );
                  if (uiContext.state.auditEntries.length === 0)
                    return `<div class="invites-empty">Событий пока нет</div>`;
                  if (filtered.length === 0)
                    return `<div class="invites-empty">Под фильтр ничего не подошло</div>`;
                  return `<ul class="audit-list">
                    ${filtered
                      .map((e) => {
                        const d = describeAuditEntry(e);
                        const verbHtml = d.raw
                          ? `<code>${escapeHtml(d.verb)}</code>`
                          : escapeHtml(d.verb);
                        return `
                          <li class="audit-item${d.raw ? " audit-raw" : ""}">
                            <span class="audit-icon" aria-hidden="true">${d.icon}</span>
                            <div class="audit-body">
                              <div class="audit-line">
                                <span class="audit-actor">${escapeHtml(d.actor)}</span>
                                <span class="audit-verb">${verbHtml}</span>
                                ${d.target ? `<span class="audit-target">${escapeHtml(d.target)}</span>` : ""}
                              </div>
                              <div class="audit-time">${formatTime(e.createdAt)}</div>
                            </div>
                          </li>
                        `;
                      })
                      .join("")}
                  </ul>`;
                })()
          }
        </div>
      </div>
    </div>
  `;
}

export function renderAuditFilter(): string {
  const f = uiContext.state.auditFilter;
  const opts = Object.entries(uiContext.AUDIT_ACTION_INFO)
    .map(
      ([code, info]) =>
        `<option value="${escapeHtml(code)}"${f.action === code ? " selected" : ""}>${escapeHtml(info.ru)}</option>`,
    )
    .join("");
  // I.12(b): targetType-фильтр. Собираем уникальные значения из текущих
  // entries (а не из захардкоженного списка) — список actions со временем
  // меняется, не хочется забыть обновить.
  const targetTypes = Array.from(
    new Set(
      uiContext.state.auditEntries.map((e) => e.targetType).filter(Boolean),
    ),
  ).sort();
  const targetOpts = targetTypes
    .map(
      (t) =>
        `<option value="${escapeHtml(t)}"${f.targetType === t ? " selected" : ""}>${escapeHtml(t)}</option>`,
    )
    .join("");
  const hasAnyFilter = !!(
    f.action ||
    f.actor ||
    f.from ||
    f.to ||
    f.targetType
  );
  return `
    <div class="audit-filter">
      <select id="audit-filter-action" class="listbox">
        <option value=""${!f.action ? " selected" : ""}>Все события</option>
        ${opts}
      </select>
      <select id="audit-filter-target" class="listbox">
        <option value=""${!f.targetType ? " selected" : ""}>Все типы объектов</option>
        ${targetOpts}
      </select>
      <input id="audit-filter-actor" type="text" placeholder="Имя автора…" value="${escapeHtml(f.actor)}" />
      <input id="audit-filter-from" type="date" data-tooltip="С" value="${escapeHtml(f.from)}" />
      <input id="audit-filter-to" type="date" data-tooltip="По" value="${escapeHtml(f.to)}" />
      ${hasAnyFilter ? `<button id="audit-filter-clear" class="ghost" data-tooltip="Сбросить">✕</button>` : ""}
      <button id="audit-export-csv" class="primary" data-tooltip="Скачать видимые записи (CSV, ru-метки)">Экспорт CSV</button>
      <button id="audit-export-full" class="ghost" data-tooltip="Полный экспорт с сервера: все записи под фильтр (раздел/период/тип/код), коды действий без перевода">Полный экспорт</button>
    </div>
  `;
}

export function applyAuditFilter(entries: AuditEntry[]): AuditEntry[] {
  const f = uiContext.state.auditFilter;
  const actorQ = f.actor.trim().toLowerCase();
  // I.12: from = начало дня в локальной TZ; to = конец дня (включительно).
  // Сравниваем createdAt как `new Date(...)`-таймстампы.
  const fromTs = f.from ? new Date(`${f.from}T00:00:00`).getTime() : null;
  const toTs = f.to ? new Date(`${f.to}T23:59:59.999`).getTime() : null;
  if (!f.action && !f.targetType && !actorQ && fromTs === null && toTs === null)
    return entries;
  return entries.filter((e) => {
    if (f.action && e.action !== f.action) return false;
    if (f.targetType && e.targetType !== f.targetType) return false;
    if (actorQ) {
      const actorName = e.actorId
        ? describePeer(e.actorId).toLowerCase()
        : "система";
      if (!actorName.includes(actorQ)) return false;
    }
    if (fromTs !== null || toTs !== null) {
      const ts = new Date(e.createdAt).getTime();
      if (fromTs !== null && ts < fromTs) return false;
      if (toTs !== null && ts > toTs) return false;
    }
    return true;
  });
}

// I.12: CSV-экспорт отфильтрованных записей. RFC 4180-совместимый escape —
// каждое поле в кавычках, внутренние `"` дублируются. Excel понимает
// UTF-8 BOM для русских заголовков. Filename — `audit-<slug>-<YYYY-MM-DD>.csv`.
export function exportAuditCsv(): void {
  const ws = uiContext.state.workspaces.find(
    (w) => w.id === uiContext.state.selectedWorkspaceId,
  );
  if (!ws) return;
  const rows = applyAuditFilter(uiContext.state.auditEntries);
  if (rows.length === 0) {
    setTransientStatus("Под фильтр ничего не попало — нечего экспортировать");
    return;
  }
  const header = [
    "Дата (ISO)",
    "Автор",
    "Действие",
    "Тип объекта",
    "ID объекта",
  ];
  const escape = (v: string): string => `"${v.replace(/"/g, '""')}"`;
  const lines = [header.map(escape).join(",")];
  for (const e of rows) {
    const actor = e.actorId ? describePeer(e.actorId) : "система";
    const info =
      uiContext.AUDIT_ACTION_INFO[
        e.action as keyof typeof uiContext.AUDIT_ACTION_INFO
      ];
    const action = info ? info.ru : e.action;
    lines.push(
      [e.createdAt, actor, action, e.targetType, e.targetId]
        .map(escape)
        .join(","),
    );
  }
  const csv = "﻿" + lines.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const today = new Date().toISOString().slice(0, 10);
  const slug = (ws.slug || ws.name || "workspace").replace(
    /[^a-z0-9_-]+/gi,
    "-",
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `audit-${slug}-${today}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  setTransientStatus(`Скачано: ${rows.length} событий`);
}

// I.12(a): полный экспорт через server-side endpoint. В отличие от
// exportAuditCsv (рендерит то что лежит в state.auditEntries, ≤200 записей,
// с ru-labels), это идёт за всеми записями под фильтр (период/код/тип) —
// сервер стримит CSV напрямую с UTF-8 BOM. На выходе action-коды без
// перевода — стабильный формат для архива/импорта в BI.
export async function exportAuditCsvFromServer(): Promise<void> {
  const ws = uiContext.state.workspaces.find(
    (w) => w.id === uiContext.state.selectedWorkspaceId,
  );
  if (!ws) return;
  const f = uiContext.state.auditFilter;
  const params = new URLSearchParams();
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  if (f.action) params.set("action", f.action);
  if (f.targetType) params.set("targetType", f.targetType);
  const qs = params.toString();
  const path = `/api/v1/workspaces/${ws.id}/audit/export${qs ? `?${qs}` : ""}`;
  setTransientStatus("Запрос полного экспорта…");
  try {
    const blob = await uiContext.httpClient.getBlob(path);
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0, 10);
    const slug = (ws.slug || ws.name || "workspace").replace(
      /[^a-z0-9_-]+/gi,
      "-",
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-${slug}-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setTransientStatus("Полный экспорт скачан");
  } catch (err) {
    uiContext.state.status = describeError(err);
    render();
  }
}

// I.7: списки локализуются через t() — пересоздаём при каждом рендере,
// чтобы смена locale в settings.language применялась мгновенно.
export function settingsTabGroups(): SettingsTabGroup[] {
  return [
    {
      title: t("settings.group.account"),
      tabs: [
        { id: "profile", label: t("settings.tab.profile") },
        { id: "privacy", label: t("settings.tab.privacy") },
      ],
    },
    {
      title: t("settings.group.interact"),
      tabs: [
        { id: "voice", label: t("settings.tab.voice") },
        { id: "notifications", label: t("settings.tab.notifications") },
        { id: "hotkeys", label: t("settings.tab.hotkeys") },
        { id: "language", label: t("settings.tab.language") },
      ],
    },
    {
      title: t("settings.group.appearance"),
      tabs: [{ id: "appearance", label: t("settings.tab.appearance") }],
    },
    {
      title: t("settings.group.connection"),
      tabs: [{ id: "server", label: t("settings.tab.server") }],
    },
  ];
}

// Wave 6: функция, а не const — label'ы должны совпадать с переведёнными
// h3-заголовками секций (по ним работает scrollIntoView после перехода).
export function settingsSearchIndex(): SettingsSearchEntry[] {
  return [
    {
      tab: "profile",
      label: t("settings.tab.profile"),
      keywords: [
        "аватар",
        "имя",
        "никнейм",
        "почта",
        "пароль",
        "биография",
        "баннер",
        "avatar",
        "password",
        "email",
        "bio",
        "banner",
      ],
    },
    {
      tab: "voice",
      label: t("vs.voice.title"),
      keywords: [
        "микрофон",
        "громкость",
        "вход",
        "audio",
        "input",
        "microphone",
      ],
    },
    {
      tab: "voice",
      label: t("vs.cam.title"),
      keywords: ["видео", "разрешение", "720p", "1080p", "webcam", "video"],
    },
    {
      tab: "voice",
      label: t("vs.ptt.title"),
      keywords: ["ptt", "рация", "зажать", "talkie", "push"],
    },
    {
      tab: "voice",
      label: t("vs.denoise.title"),
      keywords: ["denoiser", "rucord", "ns", "noise", "шум"],
    },
    {
      tab: "voice",
      label: t("vs.advanced.title"),
      keywords: ["ec", "agc", "эхо", "autogain", "усиление", "echo"],
    },
    {
      tab: "hotkeys",
      label: t("hk.cat.voice"),
      keywords: ["mute", "deafen", "горячие клавиши", "хоткей", "shortcut"],
    },
    {
      tab: "hotkeys",
      label: t("hk.cat.channels"),
      keywords: ["unread", "переход", "пометить прочитанным", "alt"],
    },
    {
      tab: "hotkeys",
      label: t("hk.cat.messages"),
      keywords: ["редактировать", "edit"],
    },
    {
      tab: "hotkeys",
      label: t("hk.cat.general"),
      keywords: ["quick switcher", "поиск", "ctrl k", "ctrl f"],
    },
    {
      tab: "privacy",
      label: t("pv.sessions.title"),
      keywords: ["сессии", "sessions", "устройства", "devices", "logout"],
    },
    {
      tab: "privacy",
      label: t("pv.logoutall.title"),
      keywords: ["logout", "logout-all", "revoke"],
    },
    {
      tab: "notifications",
      label: t("nt.desktop.title"),
      keywords: ["desktop", "popup", "разрешение", "permission"],
    },
    {
      tab: "notifications",
      label: t("nt.sound.title"),
      keywords: ["sound", "beep", "звук", "тишина"],
    },
    {
      tab: "notifications",
      label: t("nt.suppress.title"),
      keywords: ["everyone", "here", "mute", "глушить"],
    },
    {
      tab: "appearance",
      label: t("ap.theme.title"),
      keywords: ["dark", "light", "тёмная", "светлая", "auto"],
    },
    {
      tab: "appearance",
      label: t("ap.accent.title"),
      keywords: ["accent", "color", "цвет"],
    },
    {
      tab: "appearance",
      label: t("ap.density.title"),
      keywords: ["density", "cozy", "compact", "уютная", "компактная"],
    },
    {
      tab: "appearance",
      label: t("ap.messages.title"),
      keywords: ["группировка", "role", "цвет ролей", "group"],
    },
    {
      tab: "appearance",
      label: t("ap.gif.title"),
      keywords: ["gif", "apng", "анимация", "hover", "наведение"],
    },
    {
      tab: "language",
      label: t("settings.language.title"),
      keywords: [
        "locale",
        "language",
        "russian",
        "english",
        "ru",
        "en",
        "перевод",
      ],
    },
    {
      tab: "language",
      label: t("settings.timeformat.title"),
      keywords: ["12-часовой", "24-часовой", "am", "pm", "часы", "time format"],
    },
    {
      tab: "server",
      label: t("sv.title"),
      keywords: [
        "адрес",
        "подключение",
        "https",
        "сертификат",
        "address",
        "connection",
        "url",
        "tls",
      ],
    },
  ];
}

export function findSettingsTab(id: SettingsTab): SettingsTabDef {
  for (const group of settingsTabGroups()) {
    const tab = group.tabs.find((t) => t.id === id);
    if (tab) return tab;
  }
  // Не должно случиться — fallback на profile.
  return settingsTabGroups()[0].tabs[0];
}
