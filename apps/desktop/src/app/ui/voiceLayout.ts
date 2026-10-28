// Раскладка и полноэкранный режим плиток голосового канала.
// Состояние живёт на уровне модуля, чтобы переживать перерисовку
// (render() заменяет DOM целиком).

export interface StreamLayoutInput {
  sessionId: string;
  sharing: boolean;
}

export type StreamLayout =
  | { mode: "grid" }
  | { mode: "single"; primary: string }
  | { mode: "pinned"; primary: string }
  | { mode: "multi"; streams: string[]; columns: number };

let pinnedSessionId: string | null = null;
let fullscreenSessionId: string | null = null;

export function getPinnedSession(): string | null {
  return pinnedSessionId;
}

export function getFullscreenSession(): string | null {
  return fullscreenSessionId;
}

export function setFullscreenSession(sessionId: string | null): void {
  fullscreenSessionId = sessionId;
}

// Повторное закрепление того же стрима снимает закрепление.
export function togglePinnedSession(sessionId: string): void {
  pinnedSessionId = pinnedSessionId === sessionId ? null : sessionId;
}

// Сбрасывает ссылки на участников, которые вышли или перестали делиться.
export function pruneLayoutState(sharingIds: string[], allIds: string[]): void {
  if (pinnedSessionId && !sharingIds.includes(pinnedSessionId)) pinnedSessionId = null;
  if (fullscreenSessionId && !allIds.includes(fullscreenSessionId)) fullscreenSessionId = null;
}

export function resetLayoutState(): void {
  pinnedSessionId = null;
  fullscreenSessionId = null;
}

// Выбор раскладки: один стрим — крупно; закреплённый — крупно, остальные
// в полосе; несколько стримов — сетка равных плиток.
export function planStreamLayout(participants: StreamLayoutInput[]): StreamLayout {
  const streams = participants.filter((p) => p.sharing).map((p) => p.sessionId);
  if (streams.length === 0) return { mode: "grid" };
  if (pinnedSessionId && streams.includes(pinnedSessionId)) {
    return { mode: "pinned", primary: pinnedSessionId };
  }
  if (streams.length === 1) return { mode: "single", primary: streams[0]! };
  return { mode: "multi", streams, columns: Math.ceil(Math.sqrt(streams.length)) };
}

const FS_IDLE_MS = 3000;
let idleTimer: number | undefined;
let controllerInstalled = false;

function room(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".voice-room");
}

function wake(): void {
  const el = room();
  if (!el || !el.classList.contains("tile-fs")) return;
  el.classList.remove("fs-idle");
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    const r = room();
    // Панель не прячем, пока на ней курсор.
    if (r?.querySelector(".voice-room-actions:hover, .voice-fs-exit:hover")) {
      wake();
      return;
    }
    r?.classList.add("fs-idle");
  }, FS_IDLE_MS);
}

// Применяет текущее состояние полного экрана к DOM (после render и после переключения).
export function applyFullscreenState(): void {
  const el = room();
  if (!el) return;
  const sid = fullscreenSessionId;
  let found = false;
  for (const tile of el.querySelectorAll<HTMLElement>(".voice-tile[data-voice-tile]")) {
    const on = !!sid && tile.dataset.voiceTile === sid;
    tile.classList.toggle("fullscreen", on);
    if (on) found = true;
  }
  if (sid && !found) fullscreenSessionId = null;
  el.classList.toggle("tile-fs", found);
  if (found) wake();
  else {
    window.clearTimeout(idleTimer);
    el.classList.remove("fs-idle");
  }
}

export function toggleTileFullscreen(sessionId: string): void {
  fullscreenSessionId = fullscreenSessionId === sessionId ? null : sessionId;
  applyFullscreenState();
}

// Глобальные слушатели: Esc выходит из полного экрана, движение мыши показывает панель.
export function installFullscreenController(): void {
  if (controllerInstalled) return;
  controllerInstalled = true;
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && fullscreenSessionId) {
      fullscreenSessionId = null;
      applyFullscreenState();
    }
  });
  window.addEventListener("mousemove", wake, { passive: true });
  window.addEventListener("mousedown", wake, { passive: true });
  window.addEventListener("keydown", wake, { passive: true });
}
