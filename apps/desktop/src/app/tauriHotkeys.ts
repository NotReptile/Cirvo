// K.2: глобальные хоткеи через `tauri-plugin-global-shortcut`. Работают
// когда окно Cirvo не в фокусе — это необходимо для PTT (нажатие mute-
// клавиши в игре должно сработать). Только voice-action'ы регистрируются
// глобально; tap'ы поиска/switcher'а оставляем на window-listener'е (в
// фоне их не имеет смысла дёргать).
//
// Web-сборка / mobile / ошибка регистрации: тихо фоллбэчимся на window-
// listener (dispatcher из `hotkeys.ts` обработает событие из инпута фокуса).
//
// Известное ограничение: глобальный хоткей не пробрасывается в фокусное
// приложение. Если PTT-клавиша = `T` и юзер пишет в игре чат, нажатие T
// в игре всё равно даст звук микрофона, но игра тоже получит букву.
// Это поведение Discord — пользователь обычно использует `Mouse5` или
// `~` для PTT, что в играх не используется.

import type { ActionId, KeyChord } from "./hotkeys";

let pluginPromise: Promise<typeof import("@tauri-apps/plugin-global-shortcut") | null> | null = null;

// Лениво грузим плагин: на web-сборке `__TAURI_INTERNALS__` отсутствует и
// импорт упадёт. Кешируем результат — повторные попытки не нужны.
async function loadPlugin(): Promise<typeof import("@tauri-apps/plugin-global-shortcut") | null> {
  if (pluginPromise) return pluginPromise;
  pluginPromise = (async () => {
    if (typeof window === "undefined") return null;
    const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
    if (!w.__TAURI_INTERNALS__) {
      console.info("[global-shortcut] не Tauri-окружение — глобальные хоткеи недоступны (фоллбэк на window-listener)");
      return null;
    }
    try {
      return await import("@tauri-apps/plugin-global-shortcut");
    } catch (err) {
      console.warn("[global-shortcut] плагин не загрузился:", err);
      return null;
    }
  })();
  return pluginPromise;
}

// Конвертация KeyChord в строку-accelerator, которую понимает плагин.
// Формат: `Ctrl+Shift+M`, `Alt+F4`, `CommandOrControl+K`. Mac-modifier
// CommandOrControl не используем — наши binding'и уже знают про Ctrl vs Meta.
// Для кодов клавиш: KeyM → M, Digit1 → 1, ArrowUp → Up, Backquote → `,
// F1..F12 → как есть.
function chordToAccelerator(chord: KeyChord): string | null {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  if (chord.meta) parts.push("Super");
  const key = codeToKey(chord.code);
  if (!key) return null;
  parts.push(key);
  return parts.join("+");
}

function codeToKey(code: string): string | null {
  if (code.startsWith("Key") && code.length === 4) return code.slice(3); // KeyM → M
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5); // Digit1 → 1
  if (code.startsWith("F") && /^F[1-9][0-9]?$/.test(code)) return code; // F1..F12
  if (code.startsWith("Arrow")) return code.slice(5); // ArrowUp → Up
  const map: Record<string, string> = {
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Space: "Space",
    Enter: "Enter",
    Escape: "Escape",
    Tab: "Tab",
    Backspace: "Backspace"
  };
  return map[code] ?? null;
}

// Какие action'ы пытаемся регистрировать глобально. Tap-only action'ы
// сейчас работают только на нажатие; PTT (hold) — на Pressed/Released.
const GLOBAL_ACTION_IDS = new Set<ActionId>([
  "toggle-mute",
  "toggle-deafen",
  "toggle-camera",
  "toggle-screen-share",
  "voice-disconnect",
  "push-to-talk"
]);

export function isGlobalEligible(id: ActionId): boolean {
  return GLOBAL_ACTION_IDS.has(id);
}

interface ActionHandlers {
  tap?: () => void;
  down?: () => void;
  up?: () => void;
}

// #5c root cause: одиночная клавиша без модификатора (например `` ` `` для
// PTT). На Windows RegisterHotKey с голой клавишей либо отклоняется ОС, либо
// «съедает» её системно — каждый backtick в ЛЮБОМ приложении уходил бы нам и
// не печатался у пользователя. Дискорд решает это низкоуровневым keyboard-
// hook'ом, которого у плагина нет. Поэтому голые клавиши глобально не
// регистрируем вовсе — честный статус "bare" + подсказка в UI добавить
// модификатор. F-клавиши — исключение: они конвенционально глобальные и не
// конфликтуют с набором текста.
function isBareChord(chord: KeyChord): boolean {
  if (chord.ctrl || chord.alt || chord.shift || chord.meta) return false;
  return !/^F[1-9][0-9]?$/.test(chord.code);
}

const handlers = new Map<ActionId, ActionHandlers>();
// Текущая зарегистрированная accelerator-строка per action — чтобы при
// смене chord'а корректно unregister'нуть старую.
const registered = new Map<ActionId, string>();

// Статус глобальной регистрации per action — для индикатора в settings.
// "registered" — OS приняла accelerator (работает в фоне);
// "failed" — register бросил (конфликт/нет разрешения);
// "bare" — одиночная клавиша без модификатора: глобально не регистрируем
//          (см. isBareChord ниже), работает только в фокусе;
// "unsupported" — не Tauri-десктоп (web) или плагин не загрузился;
// "off" — биндинг выключен или не global-eligible.
export type GlobalStatus = "registered" | "failed" | "bare" | "unsupported" | "off";
const statusMap = new Map<ActionId, GlobalStatus>();
let pluginLoaded: boolean | null = null; // null = ещё не проверяли

export function getGlobalStatus(id: ActionId): GlobalStatus {
  if (!GLOBAL_ACTION_IDS.has(id)) return "off";
  if (pluginLoaded === false) return "unsupported";
  return statusMap.get(id) ?? "off";
}

export function isGlobalSupported(): boolean {
  return pluginLoaded === true;
}

export function setHandlers(id: ActionId, h: ActionHandlers): void {
  handlers.set(id, h);
}

// Полная синхронизация: для каждого global-eligible action'а взять
// текущий chord из getBinding и (пере)зарегистрировать. Вызывается из
// `installGlobalKeyboardShortcuts` после `registerHotkeyActions` и из
// rebind-handler'ов в hotkeys-табе.
export async function syncGlobalShortcuts(
  getBinding: (id: ActionId) => { chord: KeyChord | null; enabled: boolean }
): Promise<void> {
  const plugin = await loadPlugin();
  pluginLoaded = !!plugin;
  if (!plugin) {
    // web / non-Tauri: помечаем все eligible как unsupported.
    for (const id of GLOBAL_ACTION_IDS) statusMap.set(id, "unsupported");
    onStatusChange?.();
    return;
  }

  for (const id of GLOBAL_ACTION_IDS) {
    const b = getBinding(id);
    const prev = registered.get(id);

    // Голая клавиша: снимаем старую регистрацию (если была) и помечаем
    // статусом "bare" — UI подскажет добавить модификатор.
    if (b.enabled && b.chord && isBareChord(b.chord)) {
      if (prev) {
        try {
          await plugin.unregister(prev);
        } catch {
          /* ignore */
        }
        registered.delete(id);
      }
      statusMap.set(id, "bare");
      console.info(`[global-shortcut] ${id}: одиночная клавиша без модификатора — глобально не регистрируем`);
      continue;
    }

    const next = b.enabled && b.chord ? chordToAccelerator(b.chord) : null;
    if (prev === next) {
      // Статус мог быть не выставлен на старте (prev===next===зарегистрировано).
      if (next && !statusMap.has(id)) statusMap.set(id, "registered");
      if (!next) statusMap.set(id, "off");
      continue;
    }

    if (prev) {
      try {
        await plugin.unregister(prev);
      } catch {
        /* возможно accelerator уже не зарегистрирован — игнорим */
      }
      registered.delete(id);
    }
    if (!next) {
      statusMap.set(id, "off");
      continue;
    }

    try {
      await plugin.register(next, (event) => {
        const h = handlers.get(id);
        if (!h) return;
        // Tauri 2 plugin emits state: "Pressed" | "Released".
        const state = (event as { state?: string }).state;
        if (state === "Released") {
          h.up?.();
          return;
        }
        // По умолчанию (state="Pressed" или undefined в старых версиях) — tap/down.
        if (h.tap) h.tap();
        else if (h.down) h.down();
      });
      registered.set(id, next);
      statusMap.set(id, "registered");
      console.info(`[global-shortcut] registered ${id} → ${next}`);
    } catch (err) {
      // Конфликт с системным хоткеем, голая клавиша без модификатора,
      // которую OS не отдаёт глобально, или Tauri не дал разрешение —
      // фоллбэк на window-listener (работает только в фокусе).
      statusMap.set(id, "failed");
      console.warn(`[global-shortcut] FAILED to register ${id} → ${next}:`, err);
    }
  }
  onStatusChange?.();
}

// Колбэк для перерисовки settings-индикатора после async-регистрации.
let onStatusChange: (() => void) | null = null;
export function setStatusChangeListener(fn: () => void): void {
  onStatusChange = fn;
}

export async function unregisterAllGlobalShortcuts(): Promise<void> {
  const plugin = await loadPlugin();
  if (!plugin) return;
  try {
    await plugin.unregisterAll();
  } catch {
    /* ignore */
  }
  registered.clear();
}

export async function isTauriDesktop(): Promise<boolean> {
  return (await loadPlugin()) !== null;
}
