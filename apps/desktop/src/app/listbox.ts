// K.8(a): custom listbox-обёртка над `<select>`. Native select оставляем
// в DOM (для form-submit и accessibility), но визуально прячем и
// рисуем кастомный trigger + popup. Когда юзер выбирает option, пишем
// в select.value и эмитим стандартное `change`-событие — все
// существующие addEventListener("change", ...) на этом select'е
// продолжают работать без правок.
//
// Opt-in: только `<select class="listbox">` оборачивается. Нативные
// селекты (admin, role-modals и т.п.) остаются как есть.

let outsideListener: ((e: MouseEvent) => void) | null = null;
let activeWrapper: HTMLDivElement | null = null;

function closeActive(): void {
  if (!activeWrapper) return;
  activeWrapper.classList.remove("listbox-open");
  if (outsideListener) {
    document.removeEventListener("click", outsideListener, true);
    outsideListener = null;
  }
  activeWrapper = null;
}

function openPopup(wrapper: HTMLDivElement): void {
  if (activeWrapper === wrapper) {
    closeActive();
    return;
  }
  closeActive();
  // Drop-up: селект у нижнего края экрана (например качество демонстрации
  // в ряду войс-кнопок) откроет popup за вьюпорт — разворачиваем вверх.
  // 290 ≈ max-height popup'а + отступ.
  const rect = wrapper.getBoundingClientRect();
  wrapper.classList.toggle("drop-up", rect.bottom + 290 > window.innerHeight);
  wrapper.classList.add("listbox-open");
  activeWrapper = wrapper;
  outsideListener = (e: MouseEvent) => {
    const target = e.target as Node | null;
    if (target && wrapper.contains(target)) return;
    closeActive();
  };
  // setTimeout — иначе клик, который открыл popup, тут же его закроет.
  setTimeout(() => {
    if (outsideListener) document.addEventListener("click", outsideListener, true);
  }, 0);
}

function buildOptions(select: HTMLSelectElement): string {
  return Array.from(select.options)
    .map((opt) => {
      const sel = opt.selected ? " selected" : "";
      const disabled = opt.disabled ? " disabled" : "";
      return `<li class="listbox-option${sel}${disabled}" data-value="${escapeAttr(opt.value)}">${escapeText(opt.text)}</li>`;
    })
    .join("");
}

function currentLabel(select: HTMLSelectElement): string {
  const opt = select.options[select.selectedIndex];
  return opt ? opt.text : "";
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function wrap(select: HTMLSelectElement): void {
  if (select.dataset.listboxWrapped === "1") return;
  // disabled-селект не имеет смысла оборачивать — оставляем нативный
  // (но прячем styling-несогласованность через CSS-класс).
  if (select.disabled) return;
  select.dataset.listboxWrapped = "1";

  const wrapper = document.createElement("div");
  wrapper.className = "listbox-wrapper";
  // Компакт-вариант для селекта качества в ряду войс-кнопок.
  if (select.classList.contains("screen-quality-select")) {
    wrapper.classList.add("listbox-compact");
  }
  wrapper.dataset.value = select.value;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "listbox-trigger";
  trigger.innerHTML = `<span class="listbox-label">${escapeText(currentLabel(select))}</span><span class="listbox-chevron">▾</span>`;

  const popup = document.createElement("div");
  popup.className = "listbox-popup";
  popup.innerHTML = `<ul class="listbox-list">${buildOptions(select)}</ul>`;

  const parent = select.parentNode;
  if (!parent) return;
  parent.insertBefore(wrapper, select);
  wrapper.appendChild(select);
  wrapper.appendChild(trigger);
  wrapper.appendChild(popup);

  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPopup(wrapper);
  });

  popup.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement | null)?.closest<HTMLLIElement>(".listbox-option");
    if (!li || li.classList.contains("disabled")) return;
    const value = li.dataset.value ?? "";
    select.value = value;
    // Обновляем visible label + active-state в popup'е до закрытия.
    const label = trigger.querySelector<HTMLSpanElement>(".listbox-label");
    if (label) label.textContent = currentLabel(select);
    popup.querySelectorAll(".listbox-option").forEach((opt) => opt.classList.remove("selected"));
    li.classList.add("selected");
    closeActive();
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

// Opt-in селекторы. Native `<select>` без какого-то из этих классов
// остаётся как есть.
const TARGET_SELECTOR = [
  "select.settings-select",  // voice/appearance/audit-filter/channel-settings
  "select.listbox",          // явный opt-in
  "select.cc-field-select",  // ws-settings, welcome-channel
  "select.member-role",      // member-row role-select
  "select.perm-select",      // channel-permissions матрица
  // качество демонстрации в войс-кнопках: компакт-вид (.listbox-compact)
  // + drop-up, т.к. ряд кнопок у нижнего края экрана
  "select.screen-quality-select"
].join(", ");

export function polishListboxes(root: ParentNode = document): void {
  const selects = root.querySelectorAll<HTMLSelectElement>(TARGET_SELECTOR);
  for (const select of selects) {
    wrap(select);
  }
}
