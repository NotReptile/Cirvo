// Настройки демонстрации экрана во вкладке «Голос и видео»: приоритет
// «плавность / чёткость», кодек, способ захвата и живая диагностика
// (FPS, битрейт, потери, RTT, буфер джиттера, причина ограничения качества).
import {
  getVoiceSettings,
  updateVoiceSettings,
} from "../../call/voiceSettings";
import type {
  ScreenCaptureMethod,
  ScreenShareCodec,
  ScreenShareMode,
} from "../../call/screenShareTuning";
import {
  diagnose,
  formatInbound,
  formatOutbound,
} from "../../call/videoStats";
import { delegate } from "../dom";
import { t } from "../i18n";
import { uiContext } from "../state";
import { escapeHtml } from "../util/html";

function radioGroup<T extends string>(
  name: string,
  current: T,
  items: Array<[T, string]>,
): string {
  return `<div class="settings-radio-group">${items
    .map(
      ([v, label]) => `
        <label class="settings-radio">
          <input type="radio" name="${name}" value="${v}" ${current === v ? "checked" : ""} />
          <span>${label}</span>
        </label>`,
    )
    .join("")}</div>`;
}

export function renderScreenShareSettingsBlock(): string {
  const s = getVoiceSettings();
  return `
    <div class="settings-section">
      <h3>${t("vs.ss.title")}</h3>
      <div class="settings-row">
        <label>${t("vs.ss.mode")}</label>
        ${radioGroup<ScreenShareMode>("vs-ss-mode", s.screenShareMode, [
          ["auto", t("vs.ss.mode.auto")],
          ["smooth", t("vs.ss.mode.smooth")],
          ["sharp", t("vs.ss.mode.sharp")],
        ])}
        <small class="settings-hint">${t("vs.ss.mode.hint")}</small>
      </div>
      <div class="settings-row">
        <label>${t("vs.ss.codec")}</label>
        ${radioGroup<ScreenShareCodec>("vs-ss-codec", s.screenShareCodec, [
          ["auto", t("vs.ss.codec.auto")],
          ["h264", "H.264"],
          ["vp9", "VP9"],
          ["vp8", "VP8"],
        ])}
        <small class="settings-hint">${t("vs.ss.codec.hint")}</small>
      </div>
      <div class="settings-row">
        <label>${t("vs.ss.capture")}</label>
        ${radioGroup<ScreenCaptureMethod>("vs-ss-capture", s.screenCaptureMethod, [
          ["auto", t("vs.ss.capture.auto")],
          ["native", t("vs.ss.capture.native")],
          ["compat", t("vs.ss.capture.compat")],
        ])}
        <small class="settings-hint">${t("vs.ss.capture.hint")}</small>
      </div>
      <div class="settings-row">
        <label>${t("vs.ss.stats")}</label>
        <div id="vs-ss-stats" class="settings-hint" aria-live="off">${t("vs.ss.stats.idle")}</div>
      </div>
    </div>
  `;
}

let statsTimer: ReturnType<typeof setInterval> | null = null;
let statsBusy = false;

function stopStats(): void {
  if (statsTimer !== null) clearInterval(statsTimer);
  statsTimer = null;
}

async function refreshStats(): Promise<void> {
  const el = uiContext.rootEl.querySelector<HTMLElement>("#vs-ss-stats");
  // Вкладку закрыли или перерисовали без блока — опрос больше не нужен.
  if (!el) {
    stopStats();
    return;
  }
  if (statsBusy) return;
  statsBusy = true;
  try {
    const snap = await uiContext.voiceMgr.collectVideoStats();
    if (!snap.out && snap.inbound.length === 0) {
      el.textContent = t("vs.ss.stats.idle");
      return;
    }
    const preset =
      uiContext.SCREEN_SHARE_PRESETS[uiContext.state.screenShareQuality];
    const hints = diagnose(snap, preset.frameRate, preset.maxBitrate / 1000);
    const lines: string[] = [];
    if (snap.out) lines.push(`${t("vs.ss.stats.out")}: ${formatOutbound(snap.out)}`);
    for (const i of snap.inbound)
      lines.push(`${t("vs.ss.stats.in")}: ${formatInbound(i)}`);
    if (snap.rttMs !== null) lines.push(`RTT: ${snap.rttMs} ${t("vs.ss.stats.ms")}`);
    el.innerHTML =
      lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("") +
      hints.map((h) => `<div><b>${escapeHtml(h)}</b></div>`).join("");
  } catch {
    el.textContent = t("vs.ss.stats.idle");
  } finally {
    statsBusy = false;
  }
}

// Обновляет только текст блока диагностики: перерисовывать вкладку раз в
// секунду нельзя, это сбрасывало бы фокус и выбранные элементы.
export function attachScreenShareSettingsHandlers(): void {
  delegate<HTMLInputElement, "change">(
    uiContext.rootEl,
    'input[name="vs-ss-mode"]',
    "change",
    (_e, r) => {
      if (r.checked) {
        updateVoiceSettings({ screenShareMode: r.value as ScreenShareMode });
        // Идёт демонстрация — применяем сразу, без переподключения.
        if (uiContext.voiceMgr.getSnapshot().screenSharing) {
          void uiContext.voiceMgr.applyScreenShareQuality(
            uiContext.SCREEN_SHARE_PRESETS[uiContext.state.screenShareQuality],
          );
        }
      }
    },
    "vs-ss-mode",
  );
  delegate<HTMLInputElement, "change">(
    uiContext.rootEl,
    'input[name="vs-ss-codec"]',
    "change",
    (_e, r) => {
      if (r.checked)
        updateVoiceSettings({ screenShareCodec: r.value as ScreenShareCodec });
    },
    "vs-ss-codec",
  );
  delegate<HTMLInputElement, "change">(
    uiContext.rootEl,
    'input[name="vs-ss-capture"]',
    "change",
    (_e, r) => {
      if (r.checked)
        updateVoiceSettings({
          screenCaptureMethod: r.value as ScreenCaptureMethod,
        });
    },
    "vs-ss-capture",
  );
  if (statsTimer === null) {
    statsTimer = setInterval(() => void refreshStats(), 1000);
  }
  void refreshStats();
}
