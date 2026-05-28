// K.8: стилизованные confirm/prompt вместо browser-нативных. Живут в
// отдельном DOM-контейнере поверх всего приложения, не требуют
// перерисовки основного render()-цикла. Async-API: caller получает
// Promise<boolean> или Promise<string | null>.

let container: HTMLDivElement | null = null;

function ensureContainer(): HTMLDivElement {
  if (container) return container;
  container = document.createElement("div");
  container.id = "rucord-dialogs";
  document.body.appendChild(container);
  return container;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface BaseOpts {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface ConfirmOpts extends BaseOpts {
  // typed-confirm: юзер должен ввести точную строку перед тем как кнопка
  // «Удалить» станет активной. Используется для необратимых операций.
  confirmText?: string;
}

export interface PromptOpts extends BaseOpts {
  label?: string;
  placeholder?: string;
  initial?: string;
  multiline?: boolean;
  // Простая валидация — возвращает строку-ошибку или null. Вызывается
  // на каждом keyup; кнопка «OK» дисэйблится пока ошибка.
  validate?: (v: string) => string | null;
}

function close(host: HTMLDivElement, onClosed: () => void): void {
  host.classList.add("dlg-fade-out");
  setTimeout(() => {
    host.remove();
    onClosed();
  }, 120);
}

export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const root = ensureContainer();
    const host = document.createElement("div");
    host.className = "dlg-backdrop";
    const needTyped = !!opts.confirmText;
    host.innerHTML = `
      <div class="dlg-card" role="dialog" aria-modal="true">
        <h3 class="dlg-title">${escapeHtml(opts.title)}</h3>
        ${opts.body ? `<p class="dlg-body">${escapeHtml(opts.body)}</p>` : ""}
        ${needTyped
          ? `<label class="dlg-typed-label">Чтобы подтвердить, введите <code>${escapeHtml(opts.confirmText!)}</code>:</label>
             <input type="text" class="dlg-typed-input" autocomplete="off" />`
          : ""}
        <div class="dlg-actions">
          <button class="dlg-cancel">${escapeHtml(opts.cancelLabel ?? "Отмена")}</button>
          <button class="dlg-confirm ${opts.danger ? "danger" : "primary"}" ${needTyped ? "disabled" : ""}>${escapeHtml(opts.confirmLabel ?? "Подтвердить")}</button>
        </div>
      </div>
    `;
    root.appendChild(host);

    const card = host.querySelector<HTMLDivElement>(".dlg-card")!;
    const confirmBtn = host.querySelector<HTMLButtonElement>(".dlg-confirm")!;
    const cancelBtn = host.querySelector<HTMLButtonElement>(".dlg-cancel")!;
    const typedInput = host.querySelector<HTMLInputElement>(".dlg-typed-input");

    let finished = false;
    const finish = (v: boolean): void => {
      if (finished) return;
      finished = true;
      close(host, () => resolve(v));
    };

    confirmBtn.addEventListener("click", () => finish(true));
    cancelBtn.addEventListener("click", () => finish(false));
    host.addEventListener("click", (e) => {
      if (e.target === host) finish(false);
    });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter" && !typedInput && !confirmBtn.disabled) {
        e.preventDefault();
        finish(true);
      }
    };
    document.addEventListener("keydown", onKey, true);
    host.addEventListener("transitionend", () => {
      if (finished) document.removeEventListener("keydown", onKey, true);
    });

    if (typedInput) {
      typedInput.addEventListener("input", () => {
        confirmBtn.disabled = typedInput.value !== opts.confirmText;
      });
      typedInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !confirmBtn.disabled) {
          e.preventDefault();
          finish(true);
        }
      });
      setTimeout(() => typedInput.focus(), 0);
    } else {
      setTimeout(() => confirmBtn.focus(), 0);
    }

    requestAnimationFrame(() => card.classList.add("dlg-card-in"));
  });
}

export function promptDialog(opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => {
    const root = ensureContainer();
    const host = document.createElement("div");
    host.className = "dlg-backdrop";
    const inputHtml = opts.multiline
      ? `<textarea class="dlg-prompt-input" rows="4" placeholder="${escapeHtml(opts.placeholder ?? "")}">${escapeHtml(opts.initial ?? "")}</textarea>`
      : `<input type="text" class="dlg-prompt-input" placeholder="${escapeHtml(opts.placeholder ?? "")}" value="${escapeHtml(opts.initial ?? "")}" autocomplete="off" />`;
    host.innerHTML = `
      <div class="dlg-card" role="dialog" aria-modal="true">
        <h3 class="dlg-title">${escapeHtml(opts.title)}</h3>
        ${opts.body ? `<p class="dlg-body">${escapeHtml(opts.body)}</p>` : ""}
        ${opts.label ? `<label class="dlg-label">${escapeHtml(opts.label)}</label>` : ""}
        ${inputHtml}
        <div class="dlg-error" hidden></div>
        <div class="dlg-actions">
          <button class="dlg-cancel">${escapeHtml(opts.cancelLabel ?? "Отмена")}</button>
          <button class="dlg-confirm primary">${escapeHtml(opts.confirmLabel ?? "OK")}</button>
        </div>
      </div>
    `;
    root.appendChild(host);

    const card = host.querySelector<HTMLDivElement>(".dlg-card")!;
    const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(".dlg-prompt-input")!;
    const confirmBtn = host.querySelector<HTMLButtonElement>(".dlg-confirm")!;
    const cancelBtn = host.querySelector<HTMLButtonElement>(".dlg-cancel")!;
    const errBox = host.querySelector<HTMLDivElement>(".dlg-error")!;

    let finished = false;
    const finish = (v: string | null): void => {
      if (finished) return;
      finished = true;
      close(host, () => resolve(v));
    };

    const validateNow = (): boolean => {
      if (!opts.validate) return true;
      const err = opts.validate(input.value);
      if (err) {
        errBox.textContent = err;
        errBox.hidden = false;
        confirmBtn.disabled = true;
        return false;
      }
      errBox.hidden = true;
      errBox.textContent = "";
      confirmBtn.disabled = false;
      return true;
    };

    input.addEventListener("input", validateNow);
    if (!opts.multiline) {
      input.addEventListener("keydown", (e: Event) => {
        const ke = e as KeyboardEvent;
        if (ke.key === "Enter") {
          ke.preventDefault();
          if (validateNow()) finish(input.value);
        }
      });
    }
    confirmBtn.addEventListener("click", () => {
      if (validateNow()) finish(input.value);
    });
    cancelBtn.addEventListener("click", () => finish(null));
    host.addEventListener("click", (e) => {
      if (e.target === host) finish(null);
    });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    host.addEventListener("transitionend", () => {
      if (finished) document.removeEventListener("keydown", onKey, true);
    });

    setTimeout(() => {
      input.focus();
      if (!opts.multiline && input instanceof HTMLInputElement) input.select();
    }, 0);
    requestAnimationFrame(() => card.classList.add("dlg-card-in"));
  });
}
