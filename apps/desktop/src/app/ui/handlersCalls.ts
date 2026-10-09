import { bindEvent } from "../dom";
import { describeError } from "../errors";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type { ScreenShareQualityKey } from "../types";
import { syncCallTimer } from "./callView";
import {
  applyPttModeToActiveSessions,
  manualToggleMute,
  selectChannel,
  toggleDeafen,
} from "./loaders";

export function attachCallsRegion(): void {
  uiContext.rootEl.querySelector<HTMLButtonElement>("#call-accept")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#call-accept"),
        "click",
        async () => {
          try {
            await uiContext.callMgr.acceptIncoming();
            applyPttModeToActiveSessions();
          } catch (err) {
            uiContext.state.status = describeError(err);
            render();
          }
        },
        "bind-449484",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#call-reject")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#call-reject"),
        "click",
        () => {
          uiContext.callMgr.rejectIncoming();
        },
        "bind-449758",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#call-hangup")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#call-hangup"),
        "click",
        () => {
          uiContext.callMgr.hangup();
        },
        "bind-449887",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#call-mute")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#call-mute"),
        "click",
        () => {
          manualToggleMute();
        },
        "bind-450008",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#call-deafen")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#call-deafen"),
        "click",
        () => {
          toggleDeafen();
        },
        "bind-450129",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#call-camera")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#call-camera"),
        "click",
        async () => {
          try {
            await uiContext.callMgr.toggleCamera();
          } catch (err) {
            uiContext.state.status = describeError(err);
            render();
          }
        },
        "bind-450248",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#call-screen")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#call-screen"),
        "click",
        async () => {
          try {
            await uiContext.callMgr.toggleScreenShare();
          } catch (err) {
            uiContext.state.status = describeError(err);
            render();
          }
        },
        "bind-450482",
      )
    : undefined;

  uiContext.rootEl.querySelector<HTMLButtonElement>("#voice-join")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#voice-join"),
        "click",
        async (e) => {
          const btn = e.currentTarget as HTMLButtonElement;
          const channelId = btn.dataset.channelId;
          if (!channelId) return;
          try {
            await uiContext.voiceMgr.join(channelId);
            applyPttModeToActiveSessions();
          } catch (err) {
            uiContext.state.status = describeError(err);
            render();
          }
        },
        "bind-450722",
      )
    : undefined;
  // voice-кнопки могут существовать одновременно в room (content) и в
  // strip (sidebar) — навешиваем хэндлер на все.
  for (const btn of uiContext.rootEl.querySelectorAll<HTMLButtonElement>(
    '[data-voice-action="mute"]',
  )) {
    bindEvent(btn, "click", () => manualToggleMute(), "bind-451327");
  }
  for (const btn of uiContext.rootEl.querySelectorAll<HTMLButtonElement>(
    '[data-voice-action="deafen"]',
  )) {
    bindEvent(btn, "click", () => toggleDeafen(), "bind-451475");
  }
  for (const btn of uiContext.rootEl.querySelectorAll<HTMLButtonElement>(
    '[data-voice-action="camera"]',
  )) {
    bindEvent(
      btn,
      "click",
      async () => {
        try {
          await uiContext.voiceMgr.toggleCamera();
        } catch (err) {
          uiContext.state.status = describeError(err);
          render();
        }
      },
      "bind-451619",
    );
  }
  for (const btn of uiContext.rootEl.querySelectorAll<HTMLButtonElement>(
    '[data-voice-action="screen"]',
  )) {
    bindEvent(
      btn,
      "click",
      async () => {
        try {
          const preset =
            uiContext.SCREEN_SHARE_PRESETS[uiContext.state.screenShareQuality];
          await uiContext.voiceMgr.toggleScreenShare(preset);
        } catch (err) {
          uiContext.state.status = describeError(err);
          render();
        }
      },
      "bind-451904",
    );
  }
  for (const sel of uiContext.rootEl.querySelectorAll<HTMLSelectElement>(
    ".screen-quality-select",
  )) {
    bindEvent(
      sel,
      "change",
      () => {
        const v = sel.value;
        if (v in uiContext.SCREEN_SHARE_PRESETS) {
          uiContext.state.screenShareQuality = v as ScreenShareQualityKey;
          try {
            localStorage.setItem("rucord:screenShareQuality", v);
          } catch {
            /* ignore */
          }
          // Если уже шарим — переприменяем encoding без переподключения.
          const snap = uiContext.voiceMgr.getSnapshot();
          if (snap.screenSharing) {
            void uiContext.voiceMgr.applyScreenShareQuality(
              uiContext.SCREEN_SHARE_PRESETS[v as ScreenShareQualityKey],
            );
          }
        }
      },
      "bind-452280",
    );
  }
  for (const btn of uiContext.rootEl.querySelectorAll<HTMLButtonElement>(
    '[data-voice-action="leave"]',
  )) {
    bindEvent(
      btn,
      "click",
      () => {
        void uiContext.voiceMgr.leave();
      },
      "bind-452907",
    );
  }
  uiContext.rootEl.querySelector<HTMLElement>("[data-voice-jump]")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLElement>("[data-voice-jump]"),
        "click",
        (e) => {
          const target = e.currentTarget as HTMLElement;
          const chId = target.dataset.voiceJump;
          if (chId && chId !== uiContext.state.selectedChannelId)
            void selectChannel(chId);
        },
        "bind-452988",
      )
    : undefined;

  syncCallTimer();
}
