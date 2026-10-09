import { confirmDialog } from "../dialogs";
import { bindEvent } from "../dom";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import { setNsfwAck } from "./channelView";
import { attachSettingsHandlers } from "./profileSettings";

export function attachPreferencesRegion(): void {
  // J.3: NSFW gate — клик «Продолжить» сохраняет ack и перерисовывает чат-вид;
  // «Назад» сбрасывает выбранный канал.
  uiContext.rootEl.querySelector<HTMLButtonElement>("#nsfw-accept")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#nsfw-accept"),
        "click",
        (e) => {
          const channelId = (e.currentTarget as HTMLButtonElement).dataset
            .channelId;
          if (!channelId) return;
          setNsfwAck(channelId);
          render();
        },
        "bind-429214",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#nsfw-decline")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#nsfw-decline"),
        "click",
        () => {
          uiContext.state.selectedChannelId = null;
          render();
        },
        "bind-429463",
      )
    : undefined;

  uiContext.rootEl.querySelector<HTMLButtonElement>("#profile-logout-btn")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#profile-logout-btn",
        ),
        "click",
        async () => {
          const ok = await confirmDialog({
            title: "Выйти из аккаунта?",
            confirmLabel: "Выйти",
            danger: true,
          });
          if (!ok) return;
          void uiContext.httpClient.logout();
        },
        "bind-429614",
      )
    : undefined;

  uiContext.rootEl.querySelector<HTMLButtonElement>("#open-profile")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#open-profile"),
        "click",
        () => {
          uiContext.state.modal = "settings";
          uiContext.state.settings.tab = "profile";
          uiContext.state.profileEdit.field = null;
          uiContext.state.profileEdit.error = null;
          uiContext.state.profileEdit.okMessage = null;
          render();
        },
        "bind-429906",
      )
    : undefined;

  attachSettingsHandlers();
}
