import { bindEvent } from "../dom";

import { t } from "../i18n";

import type { NotificationSoundKind } from "../notificationSettings";

import {
  getNotificationSettings,
  playNotificationSound,
  SOUND_LABELS,
  updateNotificationSettings,
} from "../notificationSettings";

import { requestRender as render } from "../runtime";

import { uiContext } from "../state";

import { requestBrowserNotificationPermission } from "./loaders";
import {
  checkNotificationPermission,
  getCachedNotificationPermission,
  usesNativeNotifications,
} from "../tauriNotifications";

let permissionLoaded = false;
let permissionPending = false;

function loadPermission(): void {
  if (permissionLoaded || permissionPending) return;
  permissionPending = true;
  void checkNotificationPermission().finally(() => {
    permissionLoaded = true;
    permissionPending = false;
    if (uiContext.state.modal === "settings" && uiContext.state.settings.tab === "notifications") render();
  });
}

// I.8: вкладка «Уведомления». Toggle desktop-уведомлений (с кнопкой
// «Разрешить» если permission=default), toggle звука + кнопка «Прослушать»,
// toggle подавления @everyone/@here.
export function renderSettingsNotificationsTab(): string {
  const s = getNotificationSettings();
  if (!uiContext.rootEl.querySelector("#notif-desktop")) permissionLoaded = false;
  if (s.desktopEnabled) loadPermission();
  const permission = getCachedNotificationPermission();
  const permissionLabel =
    permissionPending
      ? `<span class="settings-hint">${t("nt.perm.loading")}</span>`
      : permission === "granted"
      ? `<span class="settings-hint" style="color:#43b581">${t("nt.perm.granted")}</span>`
      : permission === "denied"
        ? `<span class="settings-hint" style="color:#d6453a">${t(usesNativeNotifications() ? "nt.perm.denied.native" : "nt.perm.denied")}</span>`
        : permission === "unsupported"
          ? `<span class="settings-hint">${t("nt.perm.unsupported")}</span>`
        : permission === "error"
          ? `<span class="settings-hint">${t("nt.perm.error")}</span><button id="notif-request-permission">${t("nt.perm.request")}</button>`
        : `<button id="notif-request-permission" class="primary">${t("nt.perm.request")}</button>`;

  return `
    <div class="settings-section">
      <h3>${t("nt.desktop.title")}</h3>
      <label class="settings-check">
        <input type="checkbox" id="notif-desktop" ${s.desktopEnabled ? "checked" : ""} />
        <span>${t("nt.desktop.toggle")}</span>
      </label>
      <small class="settings-hint">
        ${t("nt.desktop.hint")}
      </small>
      ${s.desktopEnabled ? `<div class="settings-row" style="margin-top: 8px;">${permissionLabel}</div>` : ""}
    </div>

    <div class="settings-section">
      <h3>${t("nt.sound.title")}</h3>
      <label class="settings-check">
        <input type="checkbox" id="notif-sound" ${s.soundEnabled ? "checked" : ""} />
        <span>${t("nt.sound.toggle")}</span>
      </label>
      <div class="settings-row" style="margin-top: 8px; display: flex; gap: 8px; align-items: center;">
        <select id="notif-sound-kind" class="settings-select">
          ${(Object.keys(SOUND_LABELS) as NotificationSoundKind[])
            .map(
              (k) =>
                `<option value="${k}"${s.sound === k ? " selected" : ""}>${t(`sound.${k}`)}</option>`,
            )
            .join("")}
        </select>
        <button id="notif-sound-test" class="primary">${t("nt.sound.test")}</button>
      </div>
      <small class="settings-hint">
        ${t("nt.sound.hint")}
      </small>
    </div>

    <div class="settings-section">
      <h3>${t("nt.suppress.title")}</h3>
      <label class="settings-check">
        <input type="checkbox" id="notif-mute-everyone" ${s.muteEveryone ? "checked" : ""} />
        <span>${t("nt.suppress.everyone")}</span>
      </label>
      <small class="settings-hint">
        ${t("nt.suppress.hint")}
      </small>
    </div>
  `;
}

export function attachSettingsNotificationsHandlers(): void {
  if (
    uiContext.state.modal !== "settings" ||
    uiContext.state.settings.tab !== "notifications"
  )
    return;
  uiContext.rootEl.querySelector<HTMLInputElement>("#notif-desktop")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#notif-desktop"),
        "change",
        async (e) => {
          const enabled = (e.currentTarget as HTMLInputElement).checked;
          updateNotificationSettings({ desktopEnabled: enabled });
          if (enabled) {
            permissionPending = true;
            render();
            await requestBrowserNotificationPermission();
            permissionLoaded = true;
            permissionPending = false;
          }
          render();
        },
        "bind-359783",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLInputElement>("#notif-sound")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#notif-sound"),
        "change",
        (e) => {
          updateNotificationSettings({
            soundEnabled: (e.currentTarget as HTMLInputElement).checked,
          });
        },
        "bind-360192",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLInputElement>("#notif-mute-everyone")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>(
          "#notif-mute-everyone",
        ),
        "change",
        (e) => {
          updateNotificationSettings({
            muteEveryone: (e.currentTarget as HTMLInputElement).checked,
          });
        },
        "bind-360389",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLSelectElement>("#notif-sound-kind")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLSelectElement>("#notif-sound-kind"),
        "change",
        (e) => {
          const kind = (e.currentTarget as HTMLSelectElement)
            .value as NotificationSoundKind;
          updateNotificationSettings({ sound: kind });
          playNotificationSound(kind); // сразу даём услышать выбор
        },
        "bind-360594",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#notif-sound-test")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#notif-sound-test"),
        "click",
        () => {
          // preview-аргумент игнорирует soundEnabled — юзер услышит даже при выключенном.
          playNotificationSound(getNotificationSettings().sound);
        },
        "bind-360899",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#notif-request-permission")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#notif-request-permission",
        ),
        "click",
        async () => {
          if (permissionPending) return;
          permissionPending = true;
          render();
          await requestBrowserNotificationPermission();
          permissionPending = false;
          permissionLoaded = true;
          render();
        },
        "bind-361148",
      )
    : undefined;
}
