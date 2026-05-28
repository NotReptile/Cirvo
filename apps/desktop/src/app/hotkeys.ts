// I.4: customizable hotkeys. Декларативный реестр action'ов + персист
// binding'ов в localStorage + единый dispatcher по `keydown`/`keyup`.
// Push-to-talk — особый тип action'а: парные `down`/`up` обработчики.

export type ActionId =
  | "toggle-mute"
  | "toggle-deafen"
  | "toggle-camera"
  | "toggle-screen-share"
  | "push-to-talk"
  | "voice-disconnect"
  | "next-channel-unread"
  | "prev-channel-unread"
  | "mark-server-read"
  | "quick-switcher"
  | "search"
  | "edit-last-message";

export type ActionType = "tap" | "hold";

export interface KeyChord {
  // ev.code (KeyA, Digit1, F1, Backquote, Tab, ArrowUp). Стабилен между
  // раскладками — в отличие от ev.key, который меняется на ЙЦУКЕН.
  code: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export interface ActionDef {
  id: ActionId;
  label: string;
  category: "voice" | "channels" | "messages" | "general";
  type: ActionType;
  defaultChord: KeyChord | null;
  description?: string;
}

interface Binding {
  chord: KeyChord | null;
  enabled: boolean;
}

type TapHandler = () => void | Promise<void>;
interface HoldHandler {
  down: () => void;
  up: () => void;
}

const LS_KEY = "rucord:hotkeys";

const ACTIONS: ActionDef[] = [
  {
    id: "toggle-mute",
    label: "Микрофон вкл/выкл",
    category: "voice",
    type: "tap",
    defaultChord: { code: "KeyM", ctrl: true, shift: true, alt: false, meta: false }
  },
  {
    id: "toggle-deafen",
    label: "Заглушить (deafen)",
    category: "voice",
    type: "tap",
    defaultChord: { code: "KeyD", ctrl: true, shift: true, alt: false, meta: false },
    description: "Заглушает все входящие голосовые стримы и микрофон."
  },
  {
    id: "toggle-camera",
    label: "Камера вкл/выкл",
    category: "voice",
    type: "tap",
    defaultChord: { code: "KeyE", ctrl: true, shift: true, alt: false, meta: false }
  },
  {
    id: "toggle-screen-share",
    label: "Демонстрация экрана",
    category: "voice",
    type: "tap",
    defaultChord: null
  },
  {
    id: "push-to-talk",
    label: "Push-to-talk",
    category: "voice",
    type: "hold",
    defaultChord: { code: "Backquote", ctrl: false, shift: false, alt: false, meta: false },
    description: "Зажми клавишу, чтобы говорить. По умолчанию — клавиша ~."
  },
  {
    id: "voice-disconnect",
    label: "Выйти из голосового канала",
    category: "voice",
    type: "tap",
    defaultChord: { code: "KeyL", ctrl: true, shift: true, alt: false, meta: false }
  },
  {
    id: "next-channel-unread",
    label: "Следующий непрочитанный канал",
    category: "channels",
    type: "tap",
    defaultChord: { code: "ArrowDown", ctrl: false, shift: true, alt: true, meta: false }
  },
  {
    id: "prev-channel-unread",
    label: "Предыдущий непрочитанный канал",
    category: "channels",
    type: "tap",
    defaultChord: { code: "ArrowUp", ctrl: false, shift: true, alt: true, meta: false }
  },
  {
    id: "mark-server-read",
    label: "Отметить все каналы прочитанными",
    category: "channels",
    type: "tap",
    defaultChord: { code: "Escape", ctrl: false, shift: true, alt: false, meta: false }
  },
  {
    id: "quick-switcher",
    label: "Быстрый переход (Quick Switcher)",
    category: "general",
    type: "tap",
    defaultChord: { code: "KeyK", ctrl: true, shift: false, alt: false, meta: false }
  },
  {
    id: "search",
    label: "Поиск по сообщениям",
    category: "general",
    type: "tap",
    defaultChord: { code: "KeyF", ctrl: true, shift: false, alt: false, meta: false }
  },
  {
    id: "edit-last-message",
    label: "Редактировать последнее сообщение",
    category: "messages",
    type: "tap",
    defaultChord: { code: "ArrowUp", ctrl: false, shift: false, alt: false, meta: false },
    description: "Работает в композере, когда тело пустое."
  }
];

const ACTIONS_MAP = new Map(ACTIONS.map((a) => [a.id, a] as const));

let bindings: Map<ActionId, Binding> = new Map();
let tapHandlers = new Map<ActionId, TapHandler>();
let holdHandlers = new Map<ActionId, HoldHandler>();
// Активные hold-action'ы (для PTT) — чтобы keyup корректно сработал даже
// если фокус сменился между keydown и keyup.
let activeHold = new Set<ActionId>();

function loadBindings(): void {
  bindings = new Map();
  for (const a of ACTIONS) {
    bindings.set(a.id, { chord: a.defaultChord, enabled: true });
  }
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, Partial<Binding>>;
    for (const [id, b] of Object.entries(parsed)) {
      if (!ACTIONS_MAP.has(id as ActionId)) continue;
      const def = bindings.get(id as ActionId)!;
      bindings.set(id as ActionId, {
        chord: b.chord === null ? null : (b.chord as KeyChord | undefined) ?? def.chord,
        enabled: b.enabled ?? true
      });
    }
  } catch {
    /* corrupt JSON — fallback на defaults */
  }
}

function saveBindings(): void {
  const out: Record<string, Binding> = {};
  for (const [id, b] of bindings) out[id] = b;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(out));
  } catch {
    /* quota / disabled */
  }
  for (const fn of changeListeners) fn();
}

// K.2: после любой смены binding'а уведомляем подписчиков (ui.ts перерегает
// глобальные хоткеи через tauriHotkeys.ts). Чистка listener'ов не нужна —
// они живут весь lifetime приложения.
const changeListeners: Array<() => void> = [];
export function onBindingChange(fn: () => void): void {
  changeListeners.push(fn);
}

loadBindings();

export function getActions(): readonly ActionDef[] {
  return ACTIONS;
}

export function getBinding(id: ActionId): Binding {
  return bindings.get(id) ?? { chord: null, enabled: true };
}

export function setBindingChord(id: ActionId, chord: KeyChord | null): void {
  const cur = getBinding(id);
  bindings.set(id, { ...cur, chord });
  saveBindings();
}

export function setBindingEnabled(id: ActionId, enabled: boolean): void {
  const cur = getBinding(id);
  bindings.set(id, { ...cur, enabled });
  saveBindings();
}

export function resetBinding(id: ActionId): void {
  const def = ACTIONS_MAP.get(id);
  if (!def) return;
  bindings.set(id, { chord: def.defaultChord, enabled: true });
  saveBindings();
}

export function registerHotkey(id: ActionId, h: TapHandler | HoldHandler): void {
  if (typeof h === "function") {
    tapHandlers.set(id, h);
  } else {
    holdHandlers.set(id, h);
  }
}

// Сравнение chord ↔ KeyboardEvent. ev.repeat игнорируем для tap'ов
// (один нажим = один dispatch), для hold'ов — тоже (keydown сработает
// один раз на первый нажим, keyup один раз на физический отпуск).
function matches(chord: KeyChord | null, ev: KeyboardEvent): boolean {
  if (!chord) return false;
  if (chord.code !== ev.code) return false;
  if (!!chord.ctrl !== ev.ctrlKey) return false;
  if (!!chord.shift !== ev.shiftKey) return false;
  if (!!chord.alt !== ev.altKey) return false;
  if (!!chord.meta !== ev.metaKey) return false;
  return true;
}

// Игнорим хоткеи, когда фокус в редактируемом контроле — иначе K в
// сообщении триггерил бы quick-switcher. Исключения: Ctrl/Meta-комбинации
// разрешены (Ctrl+K, Ctrl+F даже из инпута), и hold-action'ы для PTT.
function shouldIgnore(ev: KeyboardEvent, def: ActionDef): boolean {
  const target = ev.target as HTMLElement | null;
  if (!target) return false;
  const isEditable =
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable;
  if (!isEditable) return false;
  // Hold-action (PTT) — разрешаем из инпутов, иначе нельзя говорить
  // во время набора сообщения.
  if (def.type === "hold") return false;
  // Tap с модификатором — разрешаем (Ctrl+K из любого инпута).
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
  return true;
}

// Возвращает true если событие было обработано — caller может пропустить
// дальнейшую обработку (например, дефолтный Esc-handler).
export function dispatchKeyDown(ev: KeyboardEvent): boolean {
  for (const def of ACTIONS) {
    const b = getBinding(def.id);
    if (!b.enabled || !b.chord) continue;
    if (!matches(b.chord, ev)) continue;
    if (shouldIgnore(ev, def)) continue;
    if (def.type === "hold") {
      const h = holdHandlers.get(def.id);
      if (!h || activeHold.has(def.id)) continue;
      activeHold.add(def.id);
      ev.preventDefault();
      h.down();
      return true;
    }
    const h = tapHandlers.get(def.id);
    if (!h) continue;
    if (ev.repeat) return true;
    ev.preventDefault();
    void h();
    return true;
  }
  return false;
}

export function dispatchKeyUp(ev: KeyboardEvent): void {
  // На keyup чек выполняется только для hold'ов. Если модификатор
  // отпустили раньше клавиши — chord уже не «совпадает», но action
  // ВСЁ ЕЩЁ активен в activeHold — отпускаем его по физическому коду.
  for (const id of Array.from(activeHold)) {
    const b = getBinding(id);
    if (!b.chord) {
      activeHold.delete(id);
      continue;
    }
    if (ev.code === b.chord.code) {
      activeHold.delete(id);
      const h = holdHandlers.get(id);
      h?.up();
    }
  }
}

// Window blur — отпускаем все hold'ы, чтобы PTT не залип «включённым»
// при alt-tab'е.
export function releaseAllHold(): void {
  for (const id of Array.from(activeHold)) {
    activeHold.delete(id);
    holdHandlers.get(id)?.up();
  }
}

export function formatChord(c: KeyChord | null): string {
  if (!c) return "Не назначено";
  const parts: string[] = [];
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
  if (c.ctrl) parts.push(isMac ? "Ctrl" : "Ctrl");
  if (c.meta) parts.push(isMac ? "⌘" : "Win");
  if (c.alt) parts.push(isMac ? "⌥" : "Alt");
  if (c.shift) parts.push(isMac ? "⇧" : "Shift");
  parts.push(prettyCode(c.code));
  return parts.join("+");
}

function prettyCode(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Arrow")) {
    const dir = code.slice(5);
    return { Up: "↑", Down: "↓", Left: "←", Right: "→" }[dir] ?? dir;
  }
  const map: Record<string, string> = {
    Backquote: "~",
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
    Escape: "Esc",
    Tab: "Tab",
    Backspace: "Backspace"
  };
  return map[code] ?? code;
}

// Helper для UI capture: ловит первый keydown с модификаторами и
// возвращает KeyChord. Возвращает null если юзер нажал только модификатор
// (Shift сам по себе — не chord).
export function chordFromEvent(ev: KeyboardEvent): KeyChord | null {
  const code = ev.code;
  if (code === "ControlLeft" || code === "ControlRight") return null;
  if (code === "ShiftLeft" || code === "ShiftRight") return null;
  if (code === "AltLeft" || code === "AltRight") return null;
  if (code === "MetaLeft" || code === "MetaRight") return null;
  return {
    code,
    ctrl: ev.ctrlKey,
    shift: ev.shiftKey,
    alt: ev.altKey,
    meta: ev.metaKey
  };
}
