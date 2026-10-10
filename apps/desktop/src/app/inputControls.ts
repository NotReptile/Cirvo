import { getLocale } from "./i18n";

// Keep the form inputs and their existing change handlers; render RuCord controls
// in the top layer so scrollable settings cannot clip the picker.
let activePicker: HTMLDivElement | null = null;

function closePicker(): void {
  activePicker?.remove();
  activePicker = null;
}

function labelFor(input: HTMLInputElement): string {
  return input.getAttribute("aria-label") || input.labels?.[0]?.textContent?.trim() ||
    input.dataset.tooltip || input.name || input.id;
}

function pickerFor(trigger: HTMLButtonElement): HTMLDivElement {
  closePicker();
  const picker = document.createElement("div");
  picker.className = "rucord-input-picker";
  picker.setAttribute("popover", "auto");
  picker.setAttribute("role", "dialog");
  picker.setAttribute("aria-label", trigger.getAttribute("aria-label") || "");
  document.body.appendChild(picker);
  activePicker = picker;
  picker.showPopover();
  const rect = trigger.getBoundingClientRect();
  picker.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 292))}px`;
  picker.style.top = `${Math.max(8, Math.min(rect.bottom + 6, innerHeight - 340))}px`;
  picker.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); closePicker(); trigger.focus();
    }
  });
  picker.addEventListener("toggle", (event) => {
    if ((event as ToggleEvent).newState === "closed" && activePicker === picker && picker.isConnected) closePicker();
  });
  return picker;
}

function setValue(input: HTMLInputElement, value: string, trigger: HTMLButtonElement): void {
  input.value = value;
  syncTrigger(input, trigger);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function syncTrigger(input: HTMLInputElement, trigger: HTMLButtonElement): void {
  trigger.disabled = input.disabled;
  trigger.setAttribute("aria-label", labelFor(input));
  if (input.type === "color") {
    trigger.textContent = input.value.toUpperCase();
    trigger.style.setProperty("--control-color", input.value);
  } else {
    trigger.textContent = input.value || (getLocale() === "ru" ? "Выбрать дату" : "Choose date");
  }
}

function openColor(input: HTMLInputElement, trigger: HTMLButtonElement): void {
  const picker = pickerFor(trigger);
  const palette = document.createElement("div");
  palette.className = "rucord-color-palette";
  for (const color of ["#5865f2", "#3ba55c", "#faa61a", "#ed4245", "#eb459e", "#9b59b6", "#1abc9c", "#ffffff", "#80848e", "#111214"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.style.backgroundColor = color;
    button.setAttribute("aria-label", color);
    button.addEventListener("click", () => { setValue(input, color, trigger); closePicker(); trigger.focus(); });
    palette.appendChild(button);
  }
  const label = document.createElement("label");
  label.textContent = getLocale() === "ru" ? "Цвет HEX" : "HEX color";
  const hex = document.createElement("input");
  hex.type = "text";
  hex.value = input.value;
  hex.maxLength = 7;
  hex.pattern = "#[0-9a-fA-F]{6}";
  hex.required = true;
  hex.spellcheck = false;
  label.appendChild(hex);
  const apply = document.createElement("button");
  apply.type = "button";
  apply.textContent = getLocale() === "ru" ? "Применить" : "Apply";
  const submit = () => {
    if (!hex.reportValidity()) return;
    setValue(input, hex.value, trigger); closePicker(); trigger.focus();
  };
  apply.addEventListener("click", submit);
  hex.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } });
  picker.append(palette, label, apply);
  hex.focus();
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function openDate(input: HTMLInputElement, trigger: HTMLButtonElement): void {
  const picker = pickerFor(trigger);
  const today = new Date();
  const chosen = input.value ? new Date(`${input.value}T12:00:00`) : today;
  let year = chosen.getFullYear(), month = chosen.getMonth();
  const draw = () => {
    picker.replaceChildren();
    const header = document.createElement("div");
    header.className = "rucord-calendar-header";
    const title = document.createElement("strong");
    title.textContent = new Intl.DateTimeFormat(getLocale(), { month: "long", year: "numeric" }).format(new Date(year, month, 1));
    for (const direction of [-1, 1]) {
      const nav = document.createElement("button"); nav.type = "button";
      nav.textContent = direction < 0 ? "‹" : "›";
      nav.setAttribute("aria-label", getLocale() === "ru" ? (direction < 0 ? "Предыдущий месяц" : "Следующий месяц") : (direction < 0 ? "Previous month" : "Next month"));
      nav.addEventListener("click", () => {
        const next = new Date(year, month + direction, 1);
        year = next.getFullYear(); month = next.getMonth(); draw();
        picker.querySelector<HTMLButtonElement>("button")?.focus();
      });
      header.appendChild(nav);
      if (direction < 0) header.appendChild(title);
    }
    const grid = document.createElement("div"); grid.className = "rucord-calendar-grid";
    for (let i = 0; i < 7; i++) {
      const weekday = document.createElement("span");
      weekday.textContent = new Intl.DateTimeFormat(getLocale(), { weekday: "short" }).format(new Date(2024, 0, 1 + i));
      grid.appendChild(weekday);
    }
    const offset = (new Date(year, month, 1).getDay() + 6) % 7;
    for (let i = 0; i < offset; i++) grid.appendChild(document.createElement("span"));
    const days = new Date(year, month + 1, 0).getDate();
    for (let day = 1; day <= days; day++) {
      const value = dateKey(year, month, day);
      const button = document.createElement("button"); button.type = "button";
      button.textContent = String(day);
      button.setAttribute("aria-label", value);
      button.setAttribute("aria-pressed", String(value === input.value));
      button.disabled = Boolean((input.min && value < input.min) || (input.max && value > input.max));
      button.addEventListener("click", () => { setValue(input, value, trigger); closePicker(); trigger.focus(); });
      grid.appendChild(button);
    }
    const clear = document.createElement("button"); clear.type = "button";
    clear.textContent = getLocale() === "ru" ? "Очистить" : "Clear";
    clear.disabled = input.required;
    clear.addEventListener("click", () => { setValue(input, "", trigger); closePicker(); trigger.focus(); });
    picker.append(header, grid, clear);
  };
  draw();
  picker.querySelector<HTMLButtonElement>(`[aria-label="${input.value}"]`)?.focus();
  if (!picker.contains(document.activeElement)) picker.querySelector<HTMLButtonElement>("button")?.focus();
}

export function polishInputControls(root: ParentNode): void {
  if (activePicker && !activePicker.contains(document.activeElement) &&
      !document.querySelector(".rucord-input-control:focus-within")) closePicker();
  for (const input of root.querySelectorAll<HTMLInputElement>('input[type="color"], input[type="date"]')) {
    if (input.parentElement?.classList.contains("rucord-input-control")) {
      syncTrigger(input, input.parentElement.querySelector("button")!);
      continue;
    }
    const wrapper = document.createElement("span");
    wrapper.className = `rucord-input-control rucord-${input.type}-control`;
    input.before(wrapper); wrapper.appendChild(input);
    input.tabIndex = -1;
    const trigger = document.createElement("button"); trigger.type = "button";
    trigger.className = "rucord-input-trigger";
    syncTrigger(input, trigger);
    trigger.addEventListener("click", () => input.type === "color" ? openColor(input, trigger) : openDate(input, trigger));
    input.addEventListener("change", () => syncTrigger(input, trigger));
    wrapper.appendChild(trigger);
  }
}

window.addEventListener("resize", closePicker);
document.addEventListener("scroll", closePicker, true);
