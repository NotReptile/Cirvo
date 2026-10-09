import { confirmDialog } from "../dialogs";

import { bindEvent, delegate } from "../dom";

import { describeError } from "../errors";

import { t } from "../i18n";

import { requestRender as render } from "../runtime";

import { uiContext } from "../state";

import type { SessionView } from "../types";

import { describeDeviceLabel, describeUserAgent } from "../userAgent";

import { formatTimeSmart } from "../util/format";

import { escapeHtml } from "../util/html";

import { setTransientStatus } from "./helpers";

export function ensureSessionsLoaded(): void {
  if (uiContext._sessions !== null || uiContext._sessionsLoading) return;
  uiContext._sessionsLoading = true;
  void uiContext.httpClient
    .get<{ items: SessionView[] }>("/api/v1/users/me/sessions")
    .then((r) => {
      uiContext._sessions = r.items ?? [];
      uiContext._sessionsLoading = false;
      uiContext._sessionsError = null;
      if (
        uiContext.state.modal === "settings" &&
        uiContext.state.settings.tab === "privacy"
      )
        render();
    })
    .catch((err) => {
      uiContext._sessionsLoading = false;
      uiContext._sessionsError = describeError(err);
      if (
        uiContext.state.modal === "settings" &&
        uiContext.state.settings.tab === "privacy"
      )
        render();
    });
}

export function renderSettingsPrivacyTab(): string {
  ensureSessionsLoaded();
  const list = uiContext._sessions ?? [];
  const sessionsBlock = uiContext._sessionsLoading
    ? `<div class="settings-hint">${t("pv.sessions.loading")}</div>`
    : uiContext._sessionsError
      ? `<div class="modal-error">${escapeHtml(uiContext._sessionsError)}</div>`
      : list.length === 0
        ? `<div class="settings-hint">${t("pv.sessions.none")}</div>`
        : `<ul class="sessions-list">
            ${list
              .map(
                (s) => `
              <li class="sessions-item${s.current ? " current" : ""}">
                <div class="sessions-item-info">
                  <div class="sessions-item-label">
                    ${escapeHtml(describeDeviceLabel(s.deviceLabel) || t("pv.sessions.device"))}
                    ${s.current ? `<span class="sessions-current-badge">${t("pv.sessions.current")}</span>` : ""}
                  </div>
                  ${describeUserAgent(s.userAgent) ? `<div class="sessions-item-ua">${escapeHtml(describeUserAgent(s.userAgent))}</div>` : ""}
                  <div class="sessions-item-meta">
                    ${t("pv.sessions.meta", { created: formatTimeSmart(s.createdAt), seen: formatTimeSmart(s.lastSeenAt) })}
                  </div>
                </div>
                ${
                  s.current
                    ? ""
                    : `<button class="danger session-revoke" data-session-id="${escapeHtml(s.id)}">${t("pv.sessions.revoke")}</button>`
                }
              </li>
            `,
              )
              .join("")}
          </ul>`;
  return `
    <div class="settings-section">
      <h3>${t("pv.sessions.title")}</h3>
      <small class="settings-hint">
        ${t("pv.sessions.hint")}
      </small>
      ${sessionsBlock}
    </div>
    <div class="settings-section">
      <h3>${t("pv.logoutall.title")}</h3>
      <small class="settings-hint">
        ${t("pv.logoutall.hint")}
      </small>
      <div class="admin-actions">
        <button id="privacy-logout-all" class="danger">${t("pv.logoutall.title")}</button>
      </div>
    </div>
    <div class="settings-section">
      <h3>${t("pv.export.title")}</h3>
      <small class="settings-hint">
        ${t("pv.export.hint")}
      </small>
    </div>
  `;
}

export function attachSettingsPrivacyHandlers(): void {
  if (
    uiContext.state.modal !== "settings" ||
    uiContext.state.settings.tab !== "privacy"
  )
    return;
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".session-revoke",
    "click",
    async (_event, btn) => {
      const sid = btn.dataset.sessionId;
      if (!sid) return;
      const ok = await confirmDialog({
        title: "Завершить сеанс",
        body: "Refresh-токен этой сессии будет отозван. Устройство выйдет из аккаунта.",
        confirmLabel: "Завершить",
        danger: true,
      });
      if (!ok) return;
      try {
        await uiContext.httpClient.del(`/api/v1/users/me/sessions/${sid}`);
        uiContext._sessions = (uiContext._sessions ?? []).filter(
          (s) => s.id !== sid,
        );
        render();
      } catch (err) {
        uiContext._sessionsError = describeError(err);
        render();
      }
    },
    "delegate-367062",
  );
  uiContext.rootEl.querySelector<HTMLButtonElement>("#privacy-logout-all")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#privacy-logout-all",
        ),
        "click",
        async () => {
          const ok = await confirmDialog({
            title: "Выйти со всех устройств?",
            body: "Все сессии кроме текущей будут завершены.",
            confirmLabel: "Выйти со всех",
            danger: true,
          });
          if (!ok) return;
          try {
            const resp = await uiContext.httpClient.post<{ revoked: number }>(
              "/api/v1/auth/logout-all",
              {},
            );
            uiContext._sessions = (uiContext._sessions ?? []).filter(
              (s) => s.current,
            );
            setTransientStatus(`Завершено сеансов: ${resp.revoked}`);
            render();
          } catch (err) {
            uiContext._sessionsError = describeError(err);
            render();
          }
        },
        "bind-367558",
      )
    : undefined;
}
