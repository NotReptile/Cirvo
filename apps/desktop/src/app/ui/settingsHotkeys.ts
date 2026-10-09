import { confirmDialog } from "../dialogs";

import { delegate } from "../dom";

import type { ActionDef, ActionId } from "../hotkeys";

import {
  chordFromEvent,
  formatChord,
  getActions as getHotkeyActions,
  getBinding as getHotkeyBinding,
  resetBinding as resetHotkeyBinding,
  setBindingChord as setHotkeyChord,
  setBindingEnabled as setHotkeyEnabled,
} from "../hotkeys";

import { t } from "../i18n";

import { icon } from "../icons";

import { requestRender as render } from "../runtime";

import { uiContext } from "../state";

import type { GlobalStatus } from "../tauriHotkeys";

import { getGlobalStatus, isGlobalSupported } from "../tauriHotkeys";

import { escapeHtml } from "../util/html";

// Wave 6: лейблы хоткеев. Сами defs живут в hotkeys.ts (самодостаточный
// модуль без i18n-зависимости) — переводим на рендере: t("hk.<id>") с
// fallback'ом на def.label, если ключа в словаре нет (новые action'ы
// не сломаются до добавления перевода).
export function hkLabel(def: ActionDef): string {
  const key = `hk.${def.id}`;
  const s = t(key);
  return s === key ? def.label : s;
}

export function hkDesc(def: ActionDef): string {
  if (!def.description) return "";
  const key = `hk.${def.id}.desc`;
  const s = t(key);
  return s === key ? def.description : s;
}

export function renderSettingsHotkeysTab(): string {
  const actions = getHotkeyActions();
  // K.3: предвычисляем словарь chord → ActionId[] чтобы подсветить
  // конфликты. Только enabled-binding'и с непустым chord'ом считаются.
  const conflictMap = new Map<string, ActionDef[]>();
  for (const a of actions) {
    const b = getHotkeyBinding(a.id);
    if (!b.enabled || !b.chord) continue;
    const sig = formatChord(b.chord);
    const list = conflictMap.get(sig) ?? [];
    list.push(a);
    conflictMap.set(sig, list);
  }
  const byCategory = new Map<ActionDef["category"], ActionDef[]>();
  for (const a of actions) {
    const list = byCategory.get(a.category) ?? [];
    list.push(a);
    byCategory.set(a.category, list);
  }
  const sections = Array.from(byCategory.entries())
    .map(([cat, list]) => {
      const rows = list.map((a) => renderHotkeyRow(a, conflictMap)).join("");
      return `
        <div class="settings-section">
          <h3>${escapeHtml(t(`hk.cat.${cat}`))}</h3>
          <div class="hotkeys-list">${rows}</div>
        </div>
      `;
    })
    .join("");
  // #5c: статус глобальных хоткеев. Если плагин не загрузился (web) или
  // часть биндингов не зарегистрировалась — показываем баннер, чтобы было
  // видно, почему хоткеи не работают в свёрнутом окне.
  const globalBanner = (() => {
    if (!isGlobalSupported()) {
      return `<div class="settings-hint settings-hint-warn">${t("hk.global.unsupported")}</div>`;
    }
    const failed = getHotkeyActions().filter(
      (a) => getGlobalStatus(a.id) === "failed",
    );
    const bare = getHotkeyActions().filter(
      (a) => getGlobalStatus(a.id) === "bare",
    );
    const parts: string[] = [];
    if (bare.length > 0) {
      parts.push(
        `<div class="settings-hint settings-hint-warn">${t("hk.global.bare", { list: escapeHtml(bare.map(hkLabel).join(", ")) })}</div>`,
      );
    }
    if (failed.length > 0) {
      parts.push(
        `<div class="settings-hint settings-hint-warn">${t("hk.global.failed", { list: escapeHtml(failed.map(hkLabel).join(", ")) })}</div>`,
      );
    }
    return parts.join("");
  })();
  return `
    <div class="settings-hint" style="margin-bottom: 16px;">
      ${t("hk.intro")}
    </div>
    ${globalBanner}
    ${sections}
  `;
}

// #5c: бейдж статуса глобальной регистрации для voice-action'ов.
export function globalStatusBadge(id: ActionId): string {
  const st: GlobalStatus = getGlobalStatus(id);
  if (st === "registered") {
    return `<span class="hotkeys-global ok" data-tooltip="${t("hk.badge.ok")}">🌐</span>`;
  }
  if (st === "failed") {
    return `<span class="hotkeys-global fail" data-tooltip="${t("hk.badge.fail")}">🌐✕</span>`;
  }
  if (st === "bare") {
    return `<span class="hotkeys-global fail" data-tooltip="${t("hk.badge.bare")}">🌐✕</span>`;
  }
  return "";
}

export function renderHotkeyRow(
  def: ActionDef,
  conflicts: Map<string, ActionDef[]>,
): string {
  const b = getHotkeyBinding(def.id);
  const isCapturing = uiContext._capturingActionId === def.id;
  const chordLabel = isCapturing ? t("hk.capture") : formatChord(b.chord);
  // K.3: ищем тех, кто тоже сидит на этом chord'е. Если список >1 —
  // подсвечиваем warning + tooltip с именами других.
  const sig = b.chord ? formatChord(b.chord) : "";
  const others = sig
    ? (conflicts.get(sig) ?? []).filter((a) => a.id !== def.id)
    : [];
  const conflictBadge =
    others.length > 0
      ? `<span class="hotkeys-conflict" data-tooltip="${t("hk.conflict", { list: escapeHtml(others.map(hkLabel).join(", ")) })}">⚠</span>`
      : "";
  const desc = hkDesc(def);
  return `
    <div class="hotkeys-row ${b.enabled ? "" : "disabled"} ${others.length > 0 ? "has-conflict" : ""}" data-hotkey-row="${def.id}">
      <label class="hotkeys-toggle" data-tooltip="${b.enabled ? t("hk.toggle.off") : t("hk.toggle.on")}">
        <input type="checkbox" data-hotkey-toggle="${def.id}" ${b.enabled ? "checked" : ""} />
        <span class="hotkeys-toggle-track"></span>
      </label>
      <div class="hotkeys-info">
        <div class="hotkeys-label">${escapeHtml(hkLabel(def))} ${conflictBadge} ${globalStatusBadge(def.id)}</div>
        ${desc ? `<div class="hotkeys-desc">${escapeHtml(desc)}</div>` : ""}
      </div>
      <button class="hotkeys-chord ${isCapturing ? "capturing" : ""}" data-hotkey-capture="${def.id}">
        ${escapeHtml(chordLabel)}
      </button>
      <button class="ghost hotkeys-reset" data-hotkey-reset="${def.id}" data-tooltip="${t("hk.reset")}">
        ${icon("x", { size: 14 })}
      </button>
      <button class="ghost hotkeys-clear" data-hotkey-clear="${def.id}" data-tooltip="${t("hk.clear")}" ${b.chord ? "" : "disabled"}>
        ${icon("trash", { size: 14 })}
      </button>
    </div>
  `;
}

export function attachSettingsHotkeysHandlers(): void {
  if (
    uiContext.state.modal !== "settings" ||
    uiContext.state.settings.tab !== "hotkeys"
  ) {
    // Юзер ушёл с таба — отменяем capture, чтобы случайный keydown
    // не записался в чужой chord.
    uiContext._capturingActionId = null;
    return;
  }
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-hotkey-capture]",
    "click",
    (_event, btn) => {
      const id = btn.dataset.hotkeyCapture as ActionId | undefined;
      if (!id) return;
      uiContext._capturingActionId =
        uiContext._capturingActionId === id ? null : id;
      render();
    },
    "delegate-348175",
  );
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-hotkey-reset]",
    "click",
    (_event, btn) => {
      const id = btn.dataset.hotkeyReset as ActionId | undefined;
      if (!id) return;
      resetHotkeyBinding(id);
      render();
    },
    "delegate-348493",
  );
  // K.1: «Снять привязку» — ставит chord=null, оставляя action в списке.
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-hotkey-clear]",
    "click",
    (_event, btn) => {
      const id = btn.dataset.hotkeyClear as ActionId | undefined;
      if (!id) return;
      setHotkeyChord(id, null);
      render();
    },
    "delegate-348845",
  );
  delegate<HTMLInputElement, "change">(
    uiContext.rootEl,
    "[data-hotkey-toggle]",
    "change",
    (_event, cb) => {
      const id = cb.dataset.hotkeyToggle as ActionId | undefined;
      if (!id) return;
      setHotkeyEnabled(id, cb.checked);
      render();
    },
    "delegate-349125",
  );
}

// Listener в installGlobalKeyboardShortcuts перехватывает keydown во
// время capture'а ДО основного dispatcher'а — иначе нажатие, например,
// Ctrl+K в capture-режиме открыло бы Quick Switcher вместо привязки.
export function maybeCaptureKey(ev: KeyboardEvent): boolean {
  if (!uiContext._capturingActionId) return false;
  if (ev.key === "Escape") {
    uiContext._capturingActionId = null;
    ev.preventDefault();
    render();
    return true;
  }
  // K.1: Delete / Backspace в capture-режиме = «Не назначено».
  if (ev.code === "Delete" || ev.code === "Backspace") {
    ev.preventDefault();
    setHotkeyChord(uiContext._capturingActionId, null);
    uiContext._capturingActionId = null;
    render();
    return true;
  }
  const chord = chordFromEvent(ev);
  if (!chord) return true; // ждём не-модификаторную клавишу
  ev.preventDefault();
  const targetId = uiContext._capturingActionId;
  uiContext._capturingActionId = null;
  // I.4(4): если этот chord уже занят другим action'ом — спросим, заменить ли.
  // Без подтверждения молча перепривяжем, юзер потом удивится почему
  // оба action'а срабатывают.
  const sig = formatChord(chord);
  const conflicts = getHotkeyActions().filter((a) => {
    if (a.id === targetId) return false;
    const b = getHotkeyBinding(a.id);
    return b.enabled && b.chord && formatChord(b.chord) === sig;
  });
  if (conflicts.length > 0) {
    const names = conflicts.map((c) => c.label).join(", ");
    render();
    void (async () => {
      const ok = await confirmDialog({
        title: "Хоткей уже занят",
        body: `${sig} назначен на: ${names}. Заменить — снимет привязки с этих action'ов.`,
        confirmLabel: "Заменить",
        danger: true,
      });
      if (!ok) return;
      for (const c of conflicts) setHotkeyChord(c.id, null);
      setHotkeyChord(targetId, chord);
      render();
    })();
    return true;
  }
  setHotkeyChord(targetId, chord);
  render();
  return true;
}
