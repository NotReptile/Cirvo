import type {
  CameraEffect,
  CameraResolution,
  DenoiserMode,
  VoiceSettings,
} from "../../call/voiceSettings";
import {
  buildAudioConstraints,
  buildVideoConstraints,
  getVoiceSettings,
  updateVoiceSettings,
} from "../../call/voiceSettings";
import { bindEvent, delegate } from "../dom";
import { describeError } from "../errors";
import { t } from "../i18n";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import { escapeHtml } from "../util/html";
import { applyPttModeToActiveSessions, updatePttIndicator } from "./loaders";
import {
  attachScreenShareSettingsHandlers,
  renderScreenShareSettingsBlock,
} from "./settingsScreenShare";

let micGeneration = 0;
let camGeneration = 0;
let deviceGeneration = 0;
let micPending = false;
let camPending = false;
let permissionPending = false;
let permissionGeneration = 0;
let deviceEventsAttached = false;
const voiceTabActive = () =>
  uiContext.state.modal === "settings" && uiContext.state.settings.tab === "voice";
const stopStream = (stream: MediaStream) =>
  stream.getTracks().forEach((track) => track.stop());

// This explicit action requests microphone consent only; it never starts a test.
export async function revealVoiceDeviceNames(): Promise<void> {
  if (permissionPending) return;
  const generation = ++permissionGeneration;
  permissionPending = true;
  render();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stopStream(stream);
    if (generation === permissionGeneration && voiceTabActive())
      refreshSettingsDevices();
  } catch (err) {
    if (generation === permissionGeneration && voiceTabActive())
      uiContext.state.status = describeError(err);
  } finally {
    if (generation === permissionGeneration) {
      permissionPending = false;
      if (voiceTabActive()) render();
    }
  }
}

export function renderSettingsVoiceTab(): string {
  ensureSettingsDevicesLoaded();
  ensureVoiceSettingsSubscribed();
  const s = getVoiceSettings();
  const devices = uiContext._settingsDevices;
  const sinkSupported =
    typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId ===
    "function";
  const micTesting = uiContext._micTestStream !== null;
  const camTesting = uiContext._camTestStream !== null;
  const needPerm =
    !devices ||
    (devices.audioInputs.length === 0 && devices.videoInputs.length === 0) ||
    devices.audioInputs.some((d) => !d.label);

  const audioInOptions = renderDeviceOptions(
    devices?.audioInputs ?? [],
    s.audioInputId,
  );
  const audioOutOptions = renderDeviceOptions(
    devices?.audioOutputs ?? [],
    s.audioOutputId,
  );
  const videoInOptions = renderDeviceOptions(
    devices?.videoInputs ?? [],
    s.videoInputId,
  );

  return `
    <div class="settings-section">
      <h3>${t("vs.voice.title")}</h3>
      <div class="settings-row">
        <button id="vs-refresh-devices">${t("vs.devices.refresh")}</button>
        <button id="vs-device-permission" ${permissionPending ? "disabled" : ""}>${t("vs.devices.permission")}</button>
      </div>
      <div class="settings-row">
        <label for="vs-audio-in">${t("vs.mic")}</label>
        <select id="vs-audio-in" class="settings-select">
          <option value="" ${s.audioInputId ? "" : "selected"}>${t("vs.sysdefault.m")}</option>
          ${audioInOptions}
        </select>
      </div>
      <div class="settings-row">
        <label for="vs-audio-out">${t("vs.speakers")}</label>
        <select id="vs-audio-out" class="settings-select" ${sinkSupported ? "" : "disabled"}>
          <option value="" ${s.audioOutputId ? "" : "selected"}>${t("vs.sysdefault.m")}</option>
          ${audioOutOptions}
        </select>
        ${
          sinkSupported
            ? ""
            : `<small class="settings-hint">${t("vs.nosink")}</small>`
        }
      </div>
      <div class="settings-row settings-row-slider">
        <label for="vs-mic-gain">${t("vs.micgain")}</label>
        <div class="settings-slider-wrap">
          <input id="vs-mic-gain" type="range" min="0" max="200" step="1" value="${Math.round(s.micGain * 100)}" />
          <span id="vs-mic-gain-val" class="settings-slider-val">${Math.round(s.micGain * 100)}%</span>
        </div>
        <small class="settings-hint">${t("vs.micgain.hint")}</small>
      </div>
      <div class="settings-row settings-row-slider">
        <label for="vs-out-vol">${t("vs.outvol")}</label>
        <div class="settings-slider-wrap">
          <input id="vs-out-vol" type="range" min="0" max="100" step="1" value="${Math.round(s.outputVolume * 100)}" />
          <span id="vs-out-vol-val" class="settings-slider-val">${Math.round(s.outputVolume * 100)}%</span>
        </div>
      </div>
      <div class="settings-row">
        <button id="vs-test-mic" class="${micTesting ? "danger" : "primary"}" ${micPending ? "disabled" : ""}>
          ${micTesting ? t("vs.mictest.stop") : t("vs.mictest.start")}
        </button>
        <div class="vs-meter ${micTesting ? "active" : ""}">
          <div id="vs-meter-fill" class="vs-meter-fill"></div>
        </div>
      </div>
      ${
        needPerm && !micTesting
          ? `<small class="settings-hint">${t("vs.needperm")}</small>`
          : ""
      }
    </div>

    <div class="settings-section">
      <h3>${t("vs.cam.title")}</h3>
      <div class="settings-row">
        <label for="vs-video-in">${t("vs.cam.device")}</label>
        <select id="vs-video-in" class="settings-select">
          <option value="" ${s.videoInputId ? "" : "selected"}>${t("vs.sysdefault.n")}</option>
          ${videoInOptions}
        </select>
      </div>
      <div class="settings-row">
        <label>${t("vs.cam.res")}</label>
        <div class="settings-radio-group">
          ${(["360p", "720p", "1080p"] as CameraResolution[])
            .map(
              (r) => `
            <label class="settings-radio">
              <input type="radio" name="vs-res" value="${r}" ${s.cameraResolution === r ? "checked" : ""} />
              <span>${r}</span>
            </label>
          `,
            )
            .join("")}
        </div>
        <small class="settings-hint">${t("vs.cam.res.hint")}</small>
      </div>
      <div class="settings-row">
        <label>${t("vs.cam.effect")}</label>
        <div class="settings-radio-group">
          ${(
            [
              ["none", t("vs.cam.effect.none")],
              ["blur-light", t("vs.cam.effect.blurLight")],
              ["blur-strong", t("vs.cam.effect.blurStrong")],
            ] as [CameraEffect, string][]
          )
            .map(
              ([v, label]) => `
            <label class="settings-radio">
              <input type="radio" name="vs-cam-effect" value="${v}" ${s.cameraEffect === v ? "checked" : ""} />
              <span>${label}</span>
            </label>
          `,
            )
            .join("")}
        </div>
        <small class="settings-hint">${t("vs.cam.effect.hint")}</small>
      </div>
      <div class="settings-row">
        <button id="vs-test-cam" class="${camTesting ? "danger" : "primary"}" ${camPending ? "disabled" : ""}>
          ${camTesting ? t("vs.camtest.stop") : t("vs.camtest.start")}
        </button>
      </div>
      <video id="vs-cam-preview" class="vs-cam-preview" autoplay muted playsinline ${camTesting ? "" : "hidden"}></video>
    </div>

    ${renderScreenShareSettingsBlock()}

    <div class="settings-section">
      <h3>${t("vs.ptt.title")}</h3>
      <label class="settings-check">
        <input type="checkbox" id="vs-ptt-enable" ${s.pushToTalk ? "checked" : ""} />
        <span>${t("vs.ptt.enable")}</span>
      </label>
      <small class="settings-hint">
        ${t("vs.ptt.hint", { link: `<a href="#" data-settings-tab="hotkeys">${t("vs.ptt.hotkeys_link")}</a>` })}
      </small>
      <div class="settings-row settings-row-slider" ${s.pushToTalk ? "" : 'style="opacity:0.5;pointer-events:none"'}>
        <label for="vs-ptt-delay">${t("vs.ptt.delay")}</label>
        <div class="settings-slider-wrap">
          <input id="vs-ptt-delay" type="range" min="0" max="2000" step="50" value="${s.pttReleaseDelay}" />
          <span id="vs-ptt-delay-val" class="settings-slider-val">${t("vs.ptt.delay.ms", { v: s.pttReleaseDelay })}</span>
        </div>
        <small class="settings-hint">${t("vs.ptt.delay.hint")}</small>
      </div>
    </div>

    <div class="settings-section">
      <h3>${t("vs.denoise.title")}</h3>
      ${renderDenoiserBlock(s)}
    </div>

    <div class="settings-section">
      <h3>${t("vs.advanced.title")}</h3>
      <label class="settings-check">
        <input type="checkbox" id="vs-ec" ${s.echoCancellation ? "checked" : ""} />
        <span>${t("vs.ec")}</span>
      </label>
      <label class="settings-check">
        <input type="checkbox" id="vs-agc" ${s.autoGainControl ? "checked" : ""} />
        <span>${t("vs.agc")}</span>
      </label>
    </div>
  `;
}

// I.3 + N.2/N.4: блок выбора режима шумоподавления. Опции:
// - off               — никакого NS, голос идёт «как есть» (полезно для
//                       музыкальных стримов / гитары — браузерный NS режет
//                       обертоны).
// - browser           — нативный WebRTC-стек Chromium (NS3). Дефолт.
//                       Хорошо чистит вентилятор/клавиатуру/эхо.
// - cirvo            — RNNoise (ML) через AudioWorklet, denoiser.ts.
//                       Слайдер интенсивности = dry/wet микс.
// - cirvo-aggressive — нативный NS + RNNoise на 100% поверх; для сложных
//                       шумов (кафе, улица, открытое окно).
//
// Slider intensity 0-100 виден всегда, но активен только для cirvo:
// browser-NS не принимает intensity, aggressive всегда работает на 100%.
// Смена режима применяется со следующего звонка; интенсивность — на лету.
export function renderDenoiserBlock(s: VoiceSettings): string {
  const modes: { id: DenoiserMode; label: string; sub: string }[] = [
    { id: "off", label: t("vs.dn.off"), sub: t("vs.dn.off.sub") },
    { id: "browser", label: t("vs.dn.browser"), sub: t("vs.dn.browser.sub") },
    { id: "cirvo", label: t("vs.dn.cirvo"), sub: t("vs.dn.cirvo.sub") },
    {
      id: "cirvo-aggressive",
      label: t("vs.dn.aggr"),
      sub: t("vs.dn.aggr.sub"),
    },
  ];
  const intensityActive = s.denoiserMode === "cirvo";
  const radios = modes
    .map((m) => {
      const checked = s.denoiserMode === m.id ? "checked" : "";
      return `
        <label class="vs-denoiser-option ${s.denoiserMode === m.id ? "active" : ""}">
          <input type="radio" name="vs-denoiser" value="${m.id}" ${checked} />
          <div class="vs-denoiser-option-body">
            <div class="vs-denoiser-option-head">
              <span class="vs-denoiser-option-label">${escapeHtml(m.label)}</span>
            </div>
            <div class="vs-denoiser-option-sub">${escapeHtml(m.sub)}</div>
          </div>
        </label>
      `;
    })
    .join("");
  return `
    <div class="vs-denoiser-list">${radios}</div>
    <div class="settings-row settings-row-slider">
      <label for="vs-denoiser-intensity">${t("vs.dn.intensity")}</label>
      <div class="settings-slider-wrap">
        <input id="vs-denoiser-intensity" type="range" min="0" max="100" step="1"
               value="${s.denoiserIntensity}" ${intensityActive ? "" : "disabled"} />
        <span id="vs-denoiser-intensity-val" class="settings-slider-val">${s.denoiserIntensity}%</span>
      </div>
      <small class="settings-hint">
        ${intensityActive ? t("vs.dn.intensity.active") : t("vs.dn.intensity.inactive")}
      </small>
    </div>
  `;
}

export function renderDeviceOptions(
  devices: MediaDeviceInfo[],
  selectedId: string | null,
): string {
  const missing =
    selectedId && !devices.some((d) => d.deviceId === selectedId)
      ? `<option value="${escapeHtml(selectedId)}" selected>${escapeHtml(t("vs.devices.unavailable"))}</option>`
      : "";
  return missing + devices
    .map((d, i) => {
      const label = d.label || t("vs.device_n", { n: i + 1 });
      const selected = d.deviceId === selectedId ? " selected" : "";
      return `<option value="${escapeHtml(d.deviceId)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

export async function startMicTest(): Promise<void> {
  if (uiContext._micTestStream || micPending || !voiceTabActive()) return;
  const generation = ++micGeneration;
  micPending = true;
  render();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: buildAudioConstraints(),
    });
    if (generation !== micGeneration || !voiceTabActive()) {
      stopStream(stream);
      return;
    }
    uiContext._micTestStream = stream;
  } catch (err) {
    if (generation === micGeneration && voiceTabActive()) {
      uiContext.state.status = describeError(err);
      render();
    }
    return;
  } finally {
    if (generation === micGeneration) {
      micPending = false;
      if (voiceTabActive()) render();
    }
  }
  try {
    const AudioCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    uiContext._micTestAudioCtx = new AudioCtor();
    const source = uiContext._micTestAudioCtx.createMediaStreamSource(
      uiContext._micTestStream,
    );
    uiContext._micTestAnalyser = uiContext._micTestAudioCtx.createAnalyser();
    uiContext._micTestAnalyser.fftSize = 256;
    source.connect(uiContext._micTestAnalyser);
    const buf = new Uint8Array(uiContext._micTestAnalyser.frequencyBinCount);
    const loop = () => {
      if (!uiContext._micTestAnalyser) return;
      uiContext._micTestAnalyser.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i];
      const avg = sum / buf.length / 255; // 0..1
      const fill =
        uiContext.rootEl.querySelector<HTMLDivElement>("#vs-meter-fill");
      if (fill) fill.style.width = `${Math.min(100, avg * 200)}%`;
      uiContext._micTestRaf = requestAnimationFrame(loop);
    };
    uiContext._micTestRaf = requestAnimationFrame(loop);
    // Освежим имена устройств — теперь labels доступны.
    refreshSettingsDevices();
    render();
  } catch (err) {
    stopMicTest();
    uiContext.state.status = describeError(err);
    render();
  }
}

export async function startCamTest(): Promise<void> {
  if (uiContext._camTestStream || camPending || !voiceTabActive()) return;
  const generation = ++camGeneration;
  camPending = true;
  render();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: buildVideoConstraints(),
    });
    if (generation !== camGeneration || !voiceTabActive()) {
      stopStream(stream);
      return;
    }
    uiContext._camTestStream = stream;
  } catch (err) {
    if (generation === camGeneration && voiceTabActive()) {
      uiContext.state.status = describeError(err);
      render();
    }
    return;
  } finally {
    if (generation === camGeneration) {
      camPending = false;
      if (voiceTabActive()) render();
    }
  }
  refreshSettingsDevices();
  render();
  // srcObject ставим post-render, иначе element ещё не в DOM.
  requestAnimationFrame(() => {
    const v =
      uiContext.rootEl.querySelector<HTMLVideoElement>("#vs-cam-preview");
    if (v && generation === camGeneration && uiContext._camTestStream) v.srcObject = uiContext._camTestStream;
  });
}

export function attachSettingsVoiceHandlers(): void {
  if (
    uiContext.state.modal !== "settings" ||
    uiContext.state.settings.tab !== "voice"
  )
    return;

  attachScreenShareSettingsHandlers();
  bindEvent(uiContext.rootEl.querySelector("#vs-refresh-devices"), "click", refreshSettingsDevices, "vs-refresh");
  bindEvent(uiContext.rootEl.querySelector("#vs-device-permission"), "click", () => { void revealVoiceDeviceNames(); }, "vs-permission");

  uiContext.rootEl.querySelector<HTMLSelectElement>("#vs-audio-in")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLSelectElement>("#vs-audio-in"),
        "change",
        (e) => {
          stopMicTest();
          updateVoiceSettings({
            audioInputId: (e.currentTarget as HTMLSelectElement).value || null,
          });
          render();
        },
        "bind-382278",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLSelectElement>("#vs-audio-out")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLSelectElement>("#vs-audio-out"),
        "change",
        (e) => {
          updateVoiceSettings({
            audioOutputId: (e.currentTarget as HTMLSelectElement).value || null,
          });
        },
        "bind-382476",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLSelectElement>("#vs-video-in")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLSelectElement>("#vs-video-in"),
        "change",
        (e) => {
          stopCamTest();
          updateVoiceSettings({
            videoInputId: (e.currentTarget as HTMLSelectElement).value || null,
          });
          render();
        },
        "bind-382676",
      )
    : undefined;

  // Слайдеры: live-update value-label без render() (иначе слетит pointer-capture).
  const micGain =
    uiContext.rootEl.querySelector<HTMLInputElement>("#vs-mic-gain");
  micGain
    ? bindEvent(
        micGain,
        "input",
        () => {
          const pct = Number(micGain.value);
          const label =
            uiContext.rootEl.querySelector<HTMLSpanElement>("#vs-mic-gain-val");
          if (label) label.textContent = `${pct}%`;
          updateVoiceSettings({ micGain: pct / 100 });
        },
        "bind-383033",
      )
    : undefined;
  const outVol =
    uiContext.rootEl.querySelector<HTMLInputElement>("#vs-out-vol");
  outVol
    ? bindEvent(
        outVol,
        "input",
        () => {
          const pct = Number(outVol.value);
          const label =
            uiContext.rootEl.querySelector<HTMLSpanElement>("#vs-out-vol-val");
          if (label) label.textContent = `${pct}%`;
          updateVoiceSettings({ outputVolume: pct / 100 });
        },
        "bind-383367",
      )
    : undefined;

  delegate<HTMLInputElement, "change">(
    uiContext.rootEl,
    'input[name="vs-res"]',
    "change",
    (_event, r) => {
      if (r.checked)
        updateVoiceSettings({ cameraResolution: r.value as CameraResolution });
    },
    "delegate-383853",
  );

  // Wave 9: эффект камеры (размытие фона). Применится при следующем
  // включении камеры — активные треки не пересобираем.
  delegate<HTMLInputElement, "change">(
    uiContext.rootEl,
    'input[name="vs-cam-effect"]',
    "change",
    (_event, r) => {
      if (r.checked)
        updateVoiceSettings({ cameraEffect: r.value as CameraEffect });
    },
    "delegate-384212",
  );

  uiContext.rootEl.querySelector<HTMLInputElement>("#vs-ec")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#vs-ec"),
        "change",
        (e) => {
          updateVoiceSettings({
            echoCancellation: (e.currentTarget as HTMLInputElement).checked,
          });
        },
        "bind-384194",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLInputElement>("#vs-agc")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#vs-agc"),
        "change",
        (e) => {
          updateVoiceSettings({
            autoGainControl: (e.currentTarget as HTMLInputElement).checked,
          });
        },
        "bind-384382",
      )
    : undefined;
  // I.9: PTT-режим. Включение — auto-mute активные сессии (если PTT не зажат
  // сейчас). Выключение — оставляем mute как есть, юзер сам разрулит.
  uiContext.rootEl.querySelector<HTMLInputElement>("#vs-ptt-enable")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#vs-ptt-enable"),
        "change",
        (e) => {
          const enabled = (e.currentTarget as HTMLInputElement).checked;
          updateVoiceSettings({ pushToTalk: enabled });
          // applyPttModeToActiveSessions сам открывает/закрывает гейт по флагу.
          applyPttModeToActiveSessions();
          updatePttIndicator();
          render(); // toggle меняет disabled-state слайдера задержки
        },
        "bind-384719",
      )
    : undefined;
  const pttDelay =
    uiContext.rootEl.querySelector<HTMLInputElement>("#vs-ptt-delay");
  pttDelay
    ? bindEvent(
        pttDelay,
        "input",
        () => {
          const ms = Number(pttDelay.value) | 0;
          const label =
            uiContext.rootEl.querySelector<HTMLSpanElement>(
              "#vs-ptt-delay-val",
            );
          if (label) label.textContent = t("vs.ptt.delay.ms", { v: ms });
          updateVoiceSettings({ pttReleaseDelay: ms });
        },
        "bind-385215",
      )
    : undefined;
  // I.3: denoiser-режим (radio-кнопки) + intensity-слайдер.
  delegate<HTMLInputElement, "change">(
    uiContext.rootEl,
    'input[name="vs-denoiser"]',
    "change",
    (_event, r) => {
      if (r.checked) {
        updateVoiceSettings({ denoiserMode: r.value as DenoiserMode });
        render(); // intensity-slider дисэйблится/включается → перерисуем
      }
    },
    "delegate-385818",
  );
  const intensity = uiContext.rootEl.querySelector<HTMLInputElement>(
    "#vs-denoiser-intensity",
  );
  intensity
    ? bindEvent(
        intensity,
        "input",
        () => {
          const pct = Number(intensity.value);
          const label = uiContext.rootEl.querySelector<HTMLSpanElement>(
            "#vs-denoiser-intensity-val",
          );
          if (label) label.textContent = `${pct}%`;
          updateVoiceSettings({ denoiserIntensity: pct });
        },
        "bind-385960",
      )
    : undefined;

  uiContext.rootEl.querySelector<HTMLButtonElement>("#vs-test-mic")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#vs-test-mic"),
        "click",
        () => {
          if (uiContext._micTestStream) {
            stopMicTest();
            render();
          } else {
            void startMicTest();
          }
        },
        "bind-386241",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#vs-test-cam")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#vs-test-cam"),
        "click",
        () => {
          if (uiContext._camTestStream) {
            stopCamTest();
            render();
          } else {
            void startCamTest();
          }
        },
        "bind-386449",
      )
    : undefined;

  // На re-render с активным cam-test — переподцепить srcObject (innerHTML
  // нового тэга чистый).
  if (uiContext._camTestStream) {
    const v =
      uiContext.rootEl.querySelector<HTMLVideoElement>("#vs-cam-preview");
    if (v && v.srcObject !== uiContext._camTestStream)
      v.srcObject = uiContext._camTestStream;
  }
}

import {
  enumerateVoiceDevices,
  subscribeVoiceSettings,
} from "../../call/voiceSettings";

import { attachVoiceVideoStreams } from "./voiceView";

export function ensureSettingsDevicesLoaded(): void {
  if (!deviceEventsAttached && navigator.mediaDevices) {
    deviceEventsAttached = true;
    navigator.mediaDevices.addEventListener("devicechange", refreshSettingsDevices);
    if (navigator.permissions) {
      for (const name of ["microphone", "camera"]) {
        void navigator.permissions.query({ name: name as PermissionName }).then((status) => {
          status.addEventListener("change", refreshSettingsDevices);
        }).catch(() => {});
      }
    }
  }
  if (uiContext._settingsDevicesLoading || uiContext._settingsDevices) return;
  refreshSettingsDevices();
}

export function refreshSettingsDevices(): void {
  const generation = ++deviceGeneration;
  uiContext._settingsDevicesLoading = true;
  enumerateVoiceDevices()
    .then((d) => {
      if (generation === deviceGeneration) uiContext._settingsDevices = d;
    })
    .catch((err) => {
      if (generation !== deviceGeneration) return;
      uiContext.state.status = describeError(err);
      uiContext._settingsDevices ??= {
        audioInputs: [],
        audioOutputs: [],
        videoInputs: [],
      };
    })
    .finally(() => {
      if (generation !== deviceGeneration) return;
      uiContext._settingsDevicesLoading = false;
      if (
        uiContext.state.modal === "settings" &&
        uiContext.state.settings.tab === "voice"
      )
        render();
    });
}

// Любое изменение voiceSettings (например, юзер свайпнул output-volume —
// мы это сохраняем сразу) должно подтянуть громкость на active <video>
// без полного render() (он порвал бы юзер-controls).
export function ensureVoiceSettingsSubscribed(): void {
  if (uiContext._settingsVoiceSubscribed) return;
  uiContext._settingsVoiceSubscribed = true;
  subscribeVoiceSettings(() => {
    // setSinkId/volume применятся при следующем attachVoiceVideoStreams.
    // Если активного звонка нет — нечего обновлять.
    attachVoiceVideoStreams();
  });
}

export function stopMicTest(): void {
  ++micGeneration;
  micPending = false;
  if (uiContext._micTestRaf !== null) {
    cancelAnimationFrame(uiContext._micTestRaf);
    uiContext._micTestRaf = null;
  }
  uiContext._micTestAnalyser?.disconnect();
  uiContext._micTestAnalyser = null;
  if (uiContext._micTestAudioCtx) {
    void uiContext._micTestAudioCtx.close().catch(() => {});
    uiContext._micTestAudioCtx = null;
  }
  if (uiContext._micTestStream) {
    for (const t of uiContext._micTestStream.getTracks()) t.stop();
    uiContext._micTestStream = null;
  }
}

export function stopCamTest(): void {
  ++camGeneration;
  camPending = false;
  if (uiContext._camTestStream) {
    for (const t of uiContext._camTestStream.getTracks()) t.stop();
    uiContext._camTestStream = null;
  }
}

// Вызывается из attachSettingsHandlers когда модалка закрыта или таб
// сменился — иначе тесты бы продолжали жрать микрофон/камеру в фоне.
export function stopVoiceTestsIfNotActive(): void {
  if (
    uiContext.state.modal !== "settings" ||
    uiContext.state.settings.tab !== "voice"
  ) {
    ++permissionGeneration;
    permissionPending = false;
    stopMicTest();
    stopCamTest();
  }
}
