import { bindEvent } from "../dom";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";

export function attachVoiceVolumeRegion(): void {
  uiContext.rootEl.querySelector<HTMLElement>("[data-voice-volume-close]")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLElement>(
          "[data-voice-volume-close]",
        ),
        "click",
        () => {
          uiContext.state.voiceVolumeMenu = null;
          render();
        },
        "bind-467454",
      )
    : undefined;

  // Слайдер обновляет state и громкость <video> напрямую — без render(),
  // иначе сам слайдер пересоздался бы на каждом движении и терял
  // captured pointer (drag прервался бы).
  const volSlider = uiContext.rootEl.querySelector<HTMLInputElement>(
    "#voice-volume-slider",
  );
  if (volSlider && uiContext.state.voiceVolumeMenu) {
    const key = uiContext.state.voiceVolumeMenu.key;
    const applyVolume = (raw: number) => {
      const v = Math.max(0, Math.min(2, raw / 100));
      uiContext.state.voiceVolumes[key] = v;
      const selector =
        key === "call-remote"
          ? `video[data-call-remote]`
          : `video[data-voice-peer="${CSS.escape(key)}"]`;
      for (const el of uiContext.rootEl.querySelectorAll<HTMLVideoElement>(
        selector,
      )) {
        el.volume = Math.min(1, v); // HTMLMediaElement.volume cap = 1.0
      }
      const valueEl = uiContext.rootEl.querySelector<HTMLElement>(
        ".voice-volume-value",
      );
      if (valueEl) valueEl.textContent = `${Math.round(v * 100)}%`;
    };
    bindEvent(
      volSlider,
      "input",
      () => applyVolume(Number(volSlider.value)),
      "bind-468548",
    );
  }
  uiContext.rootEl.querySelector<HTMLElement>("[data-voice-volume-reset]")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLElement>(
          "[data-voice-volume-reset]",
        ),
        "click",
        () => {
          if (!uiContext.state.voiceVolumeMenu) return;
          const key = uiContext.state.voiceVolumeMenu.key;
          delete uiContext.state.voiceVolumes[key];
          uiContext.state.voiceVolumeMenu = null;
          render();
        },
        "bind-468635",
      )
    : undefined;
}
