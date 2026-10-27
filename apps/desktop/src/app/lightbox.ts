// Wave 2: lightbox для превью изображений. Клик по картинке в чате →
// полноэкранное затемнение с оригиналом, «Скачать» и закрытие по
// Esc / клику мимо / ✕. Self-contained DOM-контейнер как dialogs.ts —
// живёт вне render()-цикла ui.ts, ре-рендеры чата его не трогают.
//
// Загрузка полного изображения — через переданный loadFull() (object-URL):
// media-endpoint'ы требуют Authorization-header, голый <img src="/api/...">
// получил бы 401. Пока оригинал едет, показываем уже загруженный thumb.

export interface LightboxOpts {
  /** object-URL превью для мгновенного показа (null — сразу спиннер). */
  thumbUrl: string | null;
  /** Загрузчик оригинала → object-URL (кешируется снаружи). */
  loadFull: () => Promise<string>;
  filename: string;
}

let containerEl: HTMLDivElement | null = null;
let keydownHandler: ((ev: KeyboardEvent) => void) | null = null;

function ensureContainer(): HTMLDivElement {
  if (containerEl && document.body.contains(containerEl)) return containerEl;
  containerEl = document.createElement("div");
  containerEl.id = "cirvo-lightbox";
  document.body.appendChild(containerEl);
  return containerEl;
}

export function closeLightbox(): void {
  if (keydownHandler) {
    window.removeEventListener("keydown", keydownHandler, true);
    keydownHandler = null;
  }
  containerEl?.replaceChildren();
}

export function openLightbox(opts: LightboxOpts): void {
  const root = ensureContainer();
  root.innerHTML = `
    <div class="lb-backdrop">
      <figure class="lb-figure">
        <div class="lb-stage">
          ${opts.thumbUrl
            ? `<img class="lb-img loading" src="${opts.thumbUrl}" alt="" draggable="false" />`
            : `<div class="lb-spinner"></div>`}
        </div>
        <figcaption class="lb-caption">
          <span class="lb-filename" data-tooltip="${escapeAttr(opts.filename)}">${escapeText(opts.filename)}</span>
          <button class="lb-download" disabled>Скачать</button>
          <button class="lb-close" aria-label="Закрыть">✕</button>
        </figcaption>
      </figure>
    </div>
  `;

  const backdrop = root.querySelector<HTMLDivElement>(".lb-backdrop")!;
  const stage = root.querySelector<HTMLDivElement>(".lb-stage")!;
  const downloadBtn = root.querySelector<HTMLButtonElement>(".lb-download")!;

  // Клик мимо картинки (по backdrop или пустой части figure) — закрытие.
  backdrop.addEventListener("mousedown", (ev) => {
    const t = ev.target as HTMLElement;
    if (!t.closest(".lb-img") && !t.closest(".lb-caption")) closeLightbox();
  });
  root.querySelector<HTMLButtonElement>(".lb-close")!.addEventListener("click", closeLightbox);

  keydownHandler = (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      closeLightbox();
    }
  };
  // capture=true — Esc не должен долетать до hotkey-dispatcher'а / модалок ui.ts.
  window.addEventListener("keydown", keydownHandler, true);

  let fullUrl: string | null = null;
  void opts
    .loadFull()
    .then((url) => {
      fullUrl = url;
      // Лайтбокс могли уже закрыть, пока оригинал ехал.
      if (!root.querySelector(".lb-stage")) return;
      stage.innerHTML = `<img class="lb-img" src="${url}" alt="" draggable="false" />`;
      downloadBtn.disabled = false;
    })
    .catch(() => {
      const st = root.querySelector(".lb-stage");
      if (st) {
        // Хотя бы thumb остаётся, если был; иначе — текст ошибки.
        if (!st.querySelector("img")) st.innerHTML = `<div class="lb-error">Не удалось загрузить изображение</div>`;
        else st.querySelector("img")?.classList.remove("loading");
      }
    });

  downloadBtn.addEventListener("click", () => {
    if (!fullUrl) return;
    const a = document.createElement("a");
    a.href = fullUrl;
    a.download = opts.filename;
    a.click();
  });
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}
