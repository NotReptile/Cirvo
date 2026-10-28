import { participantVolumes } from "../../call/participantVolumes";
import { remoteAudioRouter } from "../../call/remoteAudio";
import { getOutputVolume } from "../../call/voiceSettings";
import { bindEvent, delegate } from "../dom";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type { VoiceVolumeMenuState } from "../types";
import { describePeer } from "./callView";

const MENU_WIDTH = 280;
const MENU_HEIGHT = 260;

// ПКМ открывает меню громкости для участника voice-канала (плитка) и для
// 1-к-1 собеседника (call-video-tile.remote). Делегирование с корня, а не
// привязка к каждой плитке: не зависит от порядка перерисовки и флагов на
// узлах, которые переживают morphdom.
function openVolumeMenu(ev: MouseEvent, menu: Omit<VoiceVolumeMenuState, "x" | "y">): void {
  ev.preventDefault();
  const x = Math.min(ev.clientX, window.innerWidth - MENU_WIDTH);
  const y = Math.min(ev.clientY, window.innerHeight - MENU_HEIGHT);
  uiContext.state.voiceVolumeMenu = { ...menu, x, y };
  render();
}

export function attachVoiceVolumeRegion(): void {
  const closeBtn = uiContext.rootEl.querySelector<HTMLElement>("[data-voice-volume-close]");
  if (closeBtn) {
    bindEvent(
      closeBtn,
      "click",
      () => {
        uiContext.state.voiceVolumeMenu = null;
        render();
      },
      "bind-467454",
    );
  }

  delegate<HTMLElement, "contextmenu">(
    uiContext.rootEl,
    ".voice-tile[data-voice-user][data-voice-tile]:not(.self)",
    "contextmenu",
    (ev, tile) => {
      const userId = tile.dataset.voiceUser;
      const sid = tile.dataset.voiceTile;
      if (!userId || !sid) return;
      const p = uiContext.state.voiceSnapshot?.participants.find((x) => x.sessionId === sid);
      const label = p ? p.displayName || p.username || sid.slice(0, 8) : "Участник";
      openVolumeMenu(ev, { key: sid, label, userId });
    },
    "delegate-voice-tile-menu",
  );

  delegate<HTMLElement, "contextmenu">(
    uiContext.rootEl,
    ".call-video-tile.remote",
    "contextmenu",
    (ev) => {
      const snapshot = uiContext.state.callSnapshot;
      const label = snapshot ? describePeer(snapshot.peerUserId) : "Собеседник";
      openVolumeMenu(ev, { key: "call-remote", label, userId: null });
    },
    "delegate-call-tile-menu",
  );

  // Слайдеры обновляют громкость напрямую — без render(), иначе слайдер
  // пересоздавался бы на каждом движении и терял захват указателя.
  for (const slider of uiContext.rootEl.querySelectorAll<HTMLInputElement>("input[data-volume-kind]")) {
    const kind = slider.dataset.volumeKind;
    if (kind !== "voice" && kind !== "screen" && kind !== "call") continue;
    bindEvent(
      slider,
      "input",
      () => {
        const menu = uiContext.state.voiceVolumeMenu;
        if (!menu) return;
        const value = Math.max(0, Math.min(200, Number(slider.value))) / 100;
        const valueEl = slider.closest(".voice-volume-group")?.querySelector<HTMLElement>(".voice-volume-value");
        if (valueEl) valueEl.textContent = `${Math.round(value * 100)}%`;
        if (kind === "call") {
          uiContext.state.voiceVolumes[menu.key] = value;
          const out = getOutputVolume();
          for (const el of uiContext.rootEl.querySelectorAll<HTMLVideoElement>("video[data-call-remote]")) {
            el.volume = Math.min(1, value * out);
          }
          return;
        }
        if (!menu.userId) return;
        participantVolumes.set(menu.userId, kind, value);
        remoteAudioRouter.setVolume(`${kind}:${menu.key}`, value);
      },
      `bind-volume-${kind}`,
    );
  }

  const resetBtn = uiContext.rootEl.querySelector<HTMLElement>("[data-voice-volume-reset]");
  if (resetBtn) {
    bindEvent(
      resetBtn,
      "click",
      () => {
        const menu = uiContext.state.voiceVolumeMenu;
        if (!menu) return;
        if (menu.userId) {
          participantVolumes.reset(menu.userId);
          remoteAudioRouter.setVolume(`voice:${menu.key}`, 1);
          remoteAudioRouter.setVolume(`screen:${menu.key}`, 1);
        } else {
          delete uiContext.state.voiceVolumes[menu.key];
        }
        uiContext.state.voiceVolumeMenu = null;
        render();
      },
      "bind-468635",
    );
  }
}
