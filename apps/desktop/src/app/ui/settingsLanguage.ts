import {
  getLocale,
  getTimeFormat,
  hour12Setting,
  intlLocale,
  t,
} from "../i18n";

import { escapeHtml } from "../util/html";

// I.7: «Язык и время». RU/EN селект + radio time-format (auto/12/24).
// Изменения применяются мгновенно: setLocale/setTimeFormat пишут в
// localStorage и дёргают listeners → render() обновляет UI без перезагрузки.
export function renderSettingsLanguageTab(): string {
  const locale = getLocale();
  const fmt = getTimeFormat();
  const sample = new Date();
  // Превью: формат времени с текущей настройкой, чтобы юзер видел эффект.
  const samplePreview = sample.toLocaleTimeString(intlLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: hour12Setting(),
  });
  return `
    <div class="settings-section">
      <h3>${escapeHtml(t("settings.language.title"))}</h3>
      <div class="settings-hint">${escapeHtml(t("settings.language.hint"))}</div>
      <select id="settings-locale" class="settings-select">
        <option value="ru"${locale === "ru" ? " selected" : ""}>${escapeHtml(t("settings.language.option.ru"))}</option>
        <option value="en"${locale === "en" ? " selected" : ""}>${escapeHtml(t("settings.language.option.en"))}</option>
      </select>
    </div>
    <div class="settings-section">
      <h3>${escapeHtml(t("settings.timeformat.title"))}</h3>
      <div class="settings-hint">${escapeHtml(t("settings.timeformat.hint"))}</div>
      <div class="settings-radio-group">
        <label class="settings-radio">
          <input type="radio" name="settings-time-format" value="auto" ${fmt === "auto" ? "checked" : ""} />
          <span>${escapeHtml(t("settings.timeformat.option.auto"))}</span>
        </label>
        <label class="settings-radio">
          <input type="radio" name="settings-time-format" value="h24" ${fmt === "h24" ? "checked" : ""} />
          <span>${escapeHtml(t("settings.timeformat.option.h24"))}</span>
        </label>
        <label class="settings-radio">
          <input type="radio" name="settings-time-format" value="h12" ${fmt === "h12" ? "checked" : ""} />
          <span>${escapeHtml(t("settings.timeformat.option.h12"))}</span>
        </label>
      </div>
      <div class="settings-hint" style="margin-top:8px">Сейчас: <strong>${escapeHtml(samplePreview)}</strong></div>
    </div>
  `;
}
