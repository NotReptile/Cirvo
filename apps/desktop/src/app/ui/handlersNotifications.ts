import { bindEvent, delegate } from "../dom";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import { attachAdminHandlers, loadAdminTab, newAdminCreate } from "./admin";
import { attachChannelSettingsHandlers } from "./channelSettings";
import {
  loadNotifications,
  markAllNotificationsRead,
  openNotification,
} from "./loaders";

export function attachNotificationsRegion(): void {
  uiContext.rootEl.querySelector<HTMLButtonElement>("#open-notifications")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#open-notifications",
        ),
        "click",
        () => {
          uiContext.state.modal = "notifications";
          render();
          void loadNotifications();
        },
        "bind-434271",
      )
    : undefined;

  uiContext.rootEl.querySelector<HTMLButtonElement>("#open-admin")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#open-admin"),
        "click",
        () => {
          uiContext.state.modal = "admin";
          uiContext.state.admin.tab = "settings";
          uiContext.state.admin.error = null;
          // Временный пароль из прошлого создания не должен всплывать при повторном открытии.
          uiContext._adminCreate = newAdminCreate();
          render();
          void loadAdminTab("settings");
        },
        "bind-434457",
      )
    : undefined;

  attachAdminHandlers();

  // J.2: открытие настроек канала переехало на hover-кнопку
  // [data-ch-settings] прямо на канале в sidebar. Handler ниже
  // в блоке "[data-ch]"-обработчиков.
  attachChannelSettingsHandlers();

  uiContext.rootEl.querySelector<HTMLButtonElement>("#notif-mark-all")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#notif-mark-all"),
        "click",
        () => {
          void markAllNotificationsRead();
        },
        "bind-435048",
      )
    : undefined;

  delegate<HTMLElement, "click">(
    uiContext.rootEl,
    ".notif-item",
    "click",
    (_event, el) => {
      const id = el.dataset.notifId;
      if (!id) return;
      const item = uiContext.state.notifications.find((n) => n.id === id);
      if (item) void openNotification(item);
    },
    "delegate-435595",
  );
}
