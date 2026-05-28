// K.8(b): кастомные tooltip'ы вместо нативного `title`-popup'а. Перехватываем
// mouseover на элементах с `title=` или `data-tooltip=`, через 250ms
// задержки рендерим floating-card возле курсора. Нативный `title` стрипаем
// на hover (восстанавливаем на mouseleave) — иначе системный popup тоже
// появлялся бы через ~700ms и был бы вторым.
//
// Self-contained DOM (как dialogs.ts), не требует render()-цикла. Вызывается
// единожды из bootstrap'а.

const SHOW_DELAY_MS = 250;
const ATTR_STASH = "data-tt-orig";

let tooltipEl: HTMLDivElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let currentTarget: HTMLElement | null = null;

function ensureTooltip(): HTMLDivElement {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement("div");
  tooltipEl.id = "rucord-tooltip";
  tooltipEl.setAttribute("role", "tooltip");
  tooltipEl.hidden = true;
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}

function position(target: HTMLElement, tip: HTMLDivElement): void {
  const rect = target.getBoundingClientRect();
  // Сначала ставим в DOM чтобы померить размеры.
  tip.style.left = "0px";
  tip.style.top = "0px";
  tip.hidden = false;
  const tipRect = tip.getBoundingClientRect();
  // Выше элемента по умолчанию; если не влезает (margin top < 8) — снизу.
  let top = rect.top - tipRect.height - 8;
  let placement = "top";
  if (top < 8) {
    top = rect.bottom + 8;
    placement = "bottom";
  }
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  if (left < 8) left = 8;
  if (left + tipRect.width > window.innerWidth - 8) {
    left = window.innerWidth - 8 - tipRect.width;
  }
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  tip.dataset.placement = placement;
}

function hide(): void {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (tooltipEl) tooltipEl.hidden = true;
  if (currentTarget) {
    // Восстанавливаем нативный title чтобы он работал при keyboard-focus.
    const orig = currentTarget.getAttribute(ATTR_STASH);
    if (orig !== null) {
      currentTarget.setAttribute("title", orig);
      currentTarget.removeAttribute(ATTR_STASH);
    }
    currentTarget = null;
  }
}

function getText(el: HTMLElement): string {
  return el.getAttribute("data-tooltip") || el.getAttribute("title") || "";
}

function onMouseOver(ev: MouseEvent): void {
  const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-tooltip], [title]");
  if (!target) return;
  const text = getText(target);
  if (!text.trim()) return;

  // Стрипаем нативный title чтобы не показывался дополнительно.
  if (target.hasAttribute("title")) {
    target.setAttribute(ATTR_STASH, target.getAttribute("title") ?? "");
    target.removeAttribute("title");
  }
  if (showTimer) clearTimeout(showTimer);
  if (currentTarget && currentTarget !== target) hide();
  currentTarget = target;
  showTimer = setTimeout(() => {
    if (!currentTarget) return;
    const tip = ensureTooltip();
    tip.textContent = text;
    position(currentTarget, tip);
  }, SHOW_DELAY_MS);
}

function onMouseOut(ev: MouseEvent): void {
  const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-tooltip], [data-tt-orig]");
  if (!target || target !== currentTarget) return;
  // related — куда уходит курсор. Если в дочерний элемент того же target'а,
  // не скрываем (mouseover/mouseout по дочерним нодам).
  const related = ev.relatedTarget as Node | null;
  if (related && target.contains(related)) return;
  hide();
}

let installed = false;

export function installTooltips(): void {
  if (installed) return;
  installed = true;
  document.addEventListener("mouseover", onMouseOver, true);
  document.addEventListener("mouseout", onMouseOut, true);
  // На scroll/wheel прячем — позиция всё равно устареет.
  document.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
}
