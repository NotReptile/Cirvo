import type { Density, GifAvatarsMode, ThemeMode } from "../appearance";

import { getAppearance, updateAppearance } from "../appearance";

import { bindEvent, delegate } from "../dom";

import { t } from "../i18n";

import { icon } from "../icons";

import { requestRender as render } from "../runtime";

import { uiContext } from "../state";

import { escapeHtml } from "../util/html";

// I.5: тема, accent, density, группировка, цвета ролей. Все изменения —
// сразу пишутся через updateAppearance() (которое триггерит applyAppearance()
// → outline на <html>). Затем render() — чтобы UI таба и весь chat-list
// обновились с новым `grouped`/`roleColors` режимом.
export function renderSettingsAppearanceTab(): string {
  const s = getAppearance();
  // Wave 6: map-параметр нарочно не `t` — не шейдить функцию перевода.
  const themeOpts: { id: ThemeMode; label: string; sub: string }[] = [
    { id: "dark", label: t("ap.theme.dark"), sub: t("ap.theme.dark.sub") },
    { id: "light", label: t("ap.theme.light"), sub: t("ap.theme.light.sub") },
    { id: "auto", label: t("ap.theme.auto"), sub: t("ap.theme.auto.sub") },
  ];
  const themeCards = themeOpts
    .map(
      (opt) => `
      <label class="vs-denoiser-option ${s.theme === opt.id ? "active" : ""}">
        <input type="radio" name="ap-theme" value="${opt.id}" ${s.theme === opt.id ? "checked" : ""} />
        <div class="vs-denoiser-option-body">
          <div class="vs-denoiser-option-head">
            <span class="vs-denoiser-option-label">${escapeHtml(opt.label)}</span>
          </div>
          <div class="vs-denoiser-option-sub">${escapeHtml(opt.sub)}</div>
        </div>
      </label>
    `,
    )
    .join("");

  const densityOpts: { id: Density; label: string; sub: string }[] = [
    { id: "cozy", label: t("ap.density.cozy"), sub: t("ap.density.cozy.sub") },
    {
      id: "compact",
      label: t("ap.density.compact"),
      sub: t("ap.density.compact.sub"),
    },
  ];
  const densityCards = densityOpts
    .map(
      (opt) => `
      <label class="vs-denoiser-option ${s.density === opt.id ? "active" : ""}">
        <input type="radio" name="ap-density" value="${opt.id}" ${s.density === opt.id ? "checked" : ""} />
        <div class="vs-denoiser-option-body">
          <div class="vs-denoiser-option-head">
            <span class="vs-denoiser-option-label">${escapeHtml(opt.label)}</span>
          </div>
          <div class="vs-denoiser-option-sub">${escapeHtml(opt.sub)}</div>
        </div>
      </label>
    `,
    )
    .join("");

  const accentValue = s.accent || "#5865f2";
  const accentDisplay = s.accent || t("ap.accent.default");

  return `
    <div class="settings-section">
      <h3>${t("ap.theme.title")}</h3>
      <div class="vs-denoiser-list">${themeCards}</div>
    </div>

    <div class="settings-section">
      <h3>${t("ap.accent.title")}</h3>
      <div class="settings-row">
        <label for="ap-accent">${t("ap.accent.label")}</label>
        <div class="settings-slider-wrap" style="gap: 12px;">
          <input id="ap-accent" type="color" value="${escapeHtml(accentValue)}" />
          <span id="ap-accent-val" class="settings-slider-val" style="min-width: 120px;">${escapeHtml(accentDisplay)}</span>
          <button id="ap-accent-reset" class="ghost" data-tooltip="${t("ap.accent.reset")}">${icon("x", { size: 14 })}</button>
        </div>
        <small class="settings-hint">${t("ap.accent.hint")}</small>
      </div>
    </div>

    <div class="settings-section">
      <h3>${t("ap.density.title")}</h3>
      <div class="vs-denoiser-list">${densityCards}</div>
    </div>

    <div class="settings-section">
      <h3>${t("ap.messages.title")}</h3>
      <label class="settings-check">
        <input type="checkbox" id="ap-group" ${s.groupMessages ? "checked" : ""} />
        <span>${t("ap.messages.group")}</span>
      </label>
      <label class="settings-check">
        <input type="checkbox" id="ap-role-colors" ${s.roleColors ? "checked" : ""} />
        <span>${t("ap.messages.rolecolors")}</span>
      </label>
    </div>

    <div class="settings-section">
      <h3>${t("ap.gif.title")}</h3>
      <div class="settings-row" style="display:flex; gap:8px; align-items:center;">
        <select id="ap-gif-avatars" class="settings-select">
          <option value="always" ${s.gifAvatars === "always" ? "selected" : ""}>${t("ap.gif.always")}</option>
          <option value="hover" ${s.gifAvatars === "hover" ? "selected" : ""}>${t("ap.gif.hover")}</option>
          <option value="never" ${s.gifAvatars === "never" ? "selected" : ""}>${t("ap.gif.never")}</option>
        </select>
      </div>
      <small class="settings-hint">
        ${t("ap.gif.hint")}
      </small>
    </div>
  `;
}

export function attachSettingsAppearanceHandlers(): void {
  if (
    uiContext.state.modal !== "settings" ||
    uiContext.state.settings.tab !== "appearance"
  )
    return;
  delegate<HTMLInputElement, "change">(
    uiContext.rootEl,
    'input[name="ap-theme"]',
    "change",
    (_event, r) => {
      if (r.checked) {
        updateAppearance({ theme: r.value as ThemeMode });
        render();
      }
    },
    "delegate-355740",
  );
  delegate<HTMLInputElement, "change">(
    uiContext.rootEl,
    'input[name="ap-density"]',
    "change",
    (_event, r) => {
      if (r.checked) {
        updateAppearance({ density: r.value as Density });
        render();
      }
    },
    "delegate-355990",
  );
  const accent = uiContext.rootEl.querySelector<HTMLInputElement>("#ap-accent");
  accent
    ? bindEvent(
        accent,
        "input",
        () => {
          updateAppearance({ accent: accent.value });
          const label =
            uiContext.rootEl.querySelector<HTMLSpanElement>("#ap-accent-val");
          if (label) label.textContent = accent.value;
        },
        "bind-356110",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#ap-accent-reset")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#ap-accent-reset"),
        "click",
        () => {
          updateAppearance({ accent: "" });
          render();
        },
        "bind-356332",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLInputElement>("#ap-group")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#ap-group"),
        "change",
        (e) => {
          updateAppearance({
            groupMessages: (e.currentTarget as HTMLInputElement).checked,
          });
          render();
        },
        "bind-356487",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLInputElement>("#ap-role-colors")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#ap-role-colors"),
        "change",
        (e) => {
          updateAppearance({
            roleColors: (e.currentTarget as HTMLInputElement).checked,
          });
          render();
        },
        "bind-356686",
      )
    : undefined;
  // I.14: режим анимации аватаров. render() пересоздаёт avatar-слоты —
  // attachAvatarSlots перезаполнит их уже в новом режиме.
  uiContext.rootEl.querySelector<HTMLSelectElement>("#ap-gif-avatars")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLSelectElement>("#ap-gif-avatars"),
        "change",
        (e) => {
          updateAppearance({
            gifAvatars: (e.currentTarget as HTMLSelectElement)
              .value as GifAvatarsMode,
          });
          render();
        },
        "bind-357019",
      )
    : undefined;
}
