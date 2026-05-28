// K.5: Discord-like picker для screen-share. Если есть Tauri-side capture
// (`tauriScreenCapture.isAvailable()`), показываем собственный modal с
// thumbnail'ами окон и экранов через `screen_list_sources` Rust-команду,
// после выбора стартуем pipeline через `startCapture` (без getDisplayMedia,
// без браузерной плашки — K.9). Если Tauri недоступен (web-сборка,
// Firefox/Safari, ошибка плагина) — фоллбэк на стандартный
// `navigator.mediaDevices.getDisplayMedia` с системным picker'ом.
//
// Модуль работает по тому же self-contained DOM-паттерну, что и dialogs.ts —
// ему не нужен access к render()-циклу основного приложения.

import {
  isAvailable as isTauriCaptureAvailable,
  listSources,
  startCapture,
  type ScreenSource
} from "./tauriScreenCapture";

export interface ScreenShareQuality {
  width: number;
  height: number;
  frameRate: number;
}

interface AcquireResult {
  stream: MediaStream;
  // true если стрим пришёл из Tauri-pipeline (нужно явно stopCapture'нуть
  // при выключении screen-share); false если из getDisplayMedia (стрим
  // останавливается через track.stop() как раньше).
  fromTauri: boolean;
}

export async function acquireScreenShareStream(quality?: ScreenShareQuality): Promise<AcquireResult> {
  if (await isTauriCaptureAvailable()) {
    let sources: ScreenSource[];
    try {
      sources = await listSources();
    } catch (err) {
      console.warn("[screen-share] Tauri listSources failed, fallback to getDisplayMedia", err);
      return acquireDisplayMedia(quality);
    }
    if (sources.length === 0) {
      return acquireDisplayMedia(quality);
    }
    const picked = await showPicker(sources);
    if (!picked) {
      throw new Error("screen share cancelled");
    }
    // K.5(a): quality preset → fps + JPEG quality. Resolution = native размер
    // источника (нельзя апскейлить экран без encoder-side), но frameRate
    // и JPEG-качество можно подстроить под выбранный пресет:
    //   SD (≤540p) — quality 50, низкая нагрузка
    //   HD (≤720p) — quality 60
    //   FHD (≤1080p) — quality 70 (default)
    //   4K (>1080p) — quality 80, для статичных скринов
    const fps = quality?.frameRate ?? 15;
    const jpegQuality = quality ? presetToJpegQuality(quality.height) : 65;
    const stream = await startCapture(picked.id, fps, jpegQuality);
    return { stream, fromTauri: true };
  }
  return acquireDisplayMedia(quality);
}

function presetToJpegQuality(height: number): number {
  if (height <= 540) return 50;
  if (height <= 720) return 60;
  if (height <= 1080) return 70;
  return 80;
}

async function acquireDisplayMedia(quality?: ScreenShareQuality): Promise<AcquireResult> {
  const videoConstraints: MediaTrackConstraints = quality
    ? {
        width: { ideal: quality.width },
        height: { ideal: quality.height },
        frameRate: { ideal: quality.frameRate }
      }
    : {};
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints });
  return { stream, fromTauri: false };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Tab = "screen" | "window";

function showPicker(sources: ScreenSource[]): Promise<ScreenSource | null> {
  return new Promise((resolve) => {
    let tab: Tab = "screen";
    let selectedId: string | null = sources.find((s) => s.kind === "screen")?.id ?? sources[0]?.id ?? null;

    const host = document.createElement("div");
    host.className = "ssp-backdrop";
    document.body.appendChild(host);

    let finished = false;
    const finish = (v: ScreenSource | null): void => {
      if (finished) return;
      finished = true;
      host.classList.add("dlg-fade-out");
      setTimeout(() => {
        host.remove();
        document.removeEventListener("keydown", onKey, true);
        resolve(v);
      }, 120);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      } else if (e.key === "Enter" && selectedId) {
        e.preventDefault();
        const picked = sources.find((s) => s.id === selectedId);
        if (picked) finish(picked);
      }
    };
    document.addEventListener("keydown", onKey, true);

    const renderGrid = (): string => {
      const visible = sources.filter((s) => s.kind === tab);
      if (visible.length === 0) {
        return `<div class="ssp-empty">Нет источников для этого таба.</div>`;
      }
      return visible
        .map(
          (s) => `
            <button class="ssp-source ${selectedId === s.id ? "selected" : ""}" data-source-id="${escapeHtml(s.id)}">
              <div class="ssp-thumb">
                <img src="data:image/jpeg;base64,${s.thumbnail}" alt="" />
              </div>
              <div class="ssp-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</div>
            </button>
          `
        )
        .join("");
    };

    const renderAll = (): void => {
      host.innerHTML = `
        <div class="ssp-card" role="dialog" aria-modal="true">
          <header class="ssp-header">
            <h2>Поделиться экраном</h2>
            <button class="ssp-close" aria-label="Закрыть">✕</button>
          </header>
          <div class="ssp-tabs">
            <button class="ssp-tab ${tab === "screen" ? "active" : ""}" data-tab="screen">Экраны</button>
            <button class="ssp-tab ${tab === "window" ? "active" : ""}" data-tab="window">Окна</button>
          </div>
          <div class="ssp-grid">${renderGrid()}</div>
          <footer class="ssp-footer">
            <button class="ssp-cancel">Отмена</button>
            <button class="ssp-confirm primary" ${selectedId ? "" : "disabled"}>Поделиться</button>
          </footer>
        </div>
      `;
      host.querySelector<HTMLButtonElement>(".ssp-close")?.addEventListener("click", () => finish(null));
      host.querySelector<HTMLButtonElement>(".ssp-cancel")?.addEventListener("click", () => finish(null));
      host.querySelector<HTMLButtonElement>(".ssp-confirm")?.addEventListener("click", () => {
        if (!selectedId) return;
        const picked = sources.find((s) => s.id === selectedId);
        if (picked) finish(picked);
      });
      host.querySelectorAll<HTMLButtonElement>(".ssp-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          tab = btn.dataset.tab as Tab;
          const firstInTab = sources.find((s) => s.kind === tab);
          selectedId = firstInTab?.id ?? null;
          renderAll();
        });
      });
      host.querySelectorAll<HTMLButtonElement>(".ssp-source").forEach((btn) => {
        btn.addEventListener("click", () => {
          selectedId = btn.dataset.sourceId ?? null;
          renderAll();
        });
        btn.addEventListener("dblclick", () => {
          const id = btn.dataset.sourceId;
          const picked = sources.find((s) => s.id === id);
          if (picked) finish(picked);
        });
      });
      host.addEventListener("click", (e) => {
        if (e.target === host) finish(null);
      });
    };

    renderAll();
  });
}
