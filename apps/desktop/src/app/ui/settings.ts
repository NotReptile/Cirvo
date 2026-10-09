import { t } from "../i18n";
import { icon } from "../icons";
import { uiContext } from "../state";
import type { SettingsTab, SettingsTabDef, SettingsTabGroup } from "../types";
import { escapeHtml } from "../util/html";
import { findSettingsTab, settingsTabGroups } from "./activity";
import { renderSettingsProfileTab } from "./profileSettings";
import { renderSettingsAppearanceTab } from "./settingsAppearance";
import { renderSettingsHotkeysTab } from "./settingsHotkeys";
import { renderSettingsLanguageTab } from "./settingsLanguage";
import { renderSettingsNotificationsTab } from "./settingsNotifications";
import { renderSettingsPrivacyTab } from "./settingsPrivacy";
import { renderSettingsServerTab } from "./settingsServer";
import { renderAvatar } from "./shell";
import { renderSettingsVoiceTab } from "./voiceSettings";

export function renderSettingsModal(): string {
  const me = uiContext.state.me;
  if (!me) return "";
  const activeTab = uiContext.state.settings.tab;
  const activeDef = findSettingsTab(activeTab);
  const displayName = me.displayName || me.username;

  const sidebar = `
    <aside class="settings-sidebar">
      <button class="settings-user" data-settings-tab="profile" data-tooltip="Открыть профиль">
        ${renderAvatar({
          avatarMediaId: me.avatarMediaId,
          fallbackText: displayName,
          sizePx: 36,
          className: "settings-user-avatar",
        })}
        <div class="settings-user-body">
          <div class="settings-user-name">${escapeHtml(displayName)}</div>
          <div class="settings-user-hint">${escapeHtml(t("settings.user.edit"))}</div>
        </div>
      </button>
      <div class="settings-search-wrap">
        <input id="settings-search" class="settings-search" type="text"
               placeholder="${escapeHtml(t("settings.search"))}"
               value="${escapeHtml(uiContext.state.settings.search)}"
               autocomplete="off" spellcheck="false" />
        <div id="settings-search-results" class="settings-search-results" hidden></div>
      </div>
      <nav class="settings-nav">
        ${settingsTabGroups().map(renderSettingsGroup).join("")}
      </nav>
      <button id="settings-logout-btn" class="settings-logout">
        ${icon("log-out", { size: 16 })} <span>${escapeHtml(t("settings.logout"))}</span>
      </button>
    </aside>
  `;

  const content = `
    <section class="settings-content">
      <header class="settings-content-header">
        <h2>${escapeHtml(activeDef.label)}</h2>
        <button class="ghost settings-close" data-modal-close aria-label="Закрыть">✕</button>
      </header>
      <div class="settings-content-body">
        <div class="settings-content-inner">
          ${renderSettingsTabContent(activeTab)}
        </div>
      </div>
    </section>
  `;

  return `
    <input id="profile-avatar-input" type="file" accept="image/*" hidden />
    <div class="settings-modal" data-modal-close role="dialog">
      ${sidebar}
      ${content}
    </div>
  `;
}

export function renderSettingsGroup(group: SettingsTabGroup): string {
  return `
    <div class="settings-group">
      <div class="settings-group-title">${escapeHtml(group.title)}</div>
      ${group.tabs.map(renderSettingsTabButton).join("")}
    </div>
  `;
}

export function renderSettingsTabButton(tab: SettingsTabDef): string {
  const active = uiContext.state.settings.tab === tab.id ? " active" : "";
  return `
    <button class="settings-tab${active}" data-settings-tab="${tab.id}">
      ${escapeHtml(tab.label)}
    </button>
  `;
}

export function renderSettingsTabContent(tab: SettingsTab): string {
  if (tab === "profile") return renderSettingsProfileTab();
  if (tab === "voice") return renderSettingsVoiceTab();
  if (tab === "hotkeys") return renderSettingsHotkeysTab();
  if (tab === "appearance") return renderSettingsAppearanceTab();
  if (tab === "notifications") return renderSettingsNotificationsTab();
  if (tab === "privacy") return renderSettingsPrivacyTab();
  if (tab === "language") return renderSettingsLanguageTab();
  return renderSettingsServerTab();
}
