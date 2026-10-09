import { bindEvent } from "../dom";

import { describeError } from "../errors";

import { t } from "../i18n";

import { requestRender as render } from "../runtime";

import {
  checkServerReachable,
  getStoredServerUrl,
  INSECURE_SERVER_WARNING,
  isInsecureServerUrl,
  isProductionShell,
  ServerCheckError,
} from "../serverConfig";

import { uiContext } from "../state";

import { escapeHtml } from "../util/html";

import { switchServer } from "./authentication";

export function renderSettingsServerTab(): string {
  const production = isProductionShell();
  const serverUrl = production
    ? (getStoredServerUrl() ?? "")
    : uiContext.httpClient.baseUrl || window.location.origin;
  const check = uiContext._serverCheck;
  const checkResult =
    check.status === "checking"
      ? `<div class="settings-hint">${t("sv.check.running")}</div>`
      : check.status === "ok"
        ? `<div class="settings-hint settings-server-ok">${t("sv.check.ok")}</div>`
        : check.status === "error"
          ? `<div class="modal-error">${escapeHtml(check.message)}</div>`
          : "";
  return `
    <div class="settings-section">
      <h3>${t("sv.title")}</h3>
      <small class="settings-hint">${production ? t("sv.hint") : t("sv.hint.dev")}</small>
      <div class="settings-server-url"><code>${escapeHtml(serverUrl)}</code></div>
      ${production && isInsecureServerUrl(serverUrl) ? `<div class="settings-server-warning" role="status">${escapeHtml(INSECURE_SERVER_WARNING)}</div>` : ""}
      ${checkResult}
      ${
        production
          ? `
        <div class="admin-actions settings-server-actions">
          <button id="server-check"${check.status === "checking" ? " disabled" : ""}>${t("sv.check.button")}</button>
          <button id="server-switch" class="danger">${t("sv.switch.button")}</button>
        </div>
      `
          : ""
      }
    </div>
  `;
}

export function attachSettingsServerHandlers(): void {
  if (
    uiContext.state.modal !== "settings" ||
    uiContext.state.settings.tab !== "server"
  )
    return;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#server-check")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#server-check"),
        "click",
        async () => {
          const url = getStoredServerUrl();
          if (!url) return;
          uiContext._serverCheck = { status: "checking" };
          render();
          try {
            await checkServerReachable(url);
            uiContext._serverCheck = { status: "ok" };
          } catch (err) {
            uiContext._serverCheck = {
              status: "error",
              message:
                err instanceof ServerCheckError
                  ? err.message
                  : describeError(err),
            };
          }
          render();
        },
        "bind-341739",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#server-switch")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#server-switch"),
        "click",
        () => {
          void switchServer();
        },
        "bind-342209",
      )
    : undefined;
}
