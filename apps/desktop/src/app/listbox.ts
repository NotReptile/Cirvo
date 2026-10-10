// Keep the native select as the form value, and expose an accessible button
// plus listbox popup for consistent rendering across the desktop UI.

interface ActiveListbox {
  wrapper: HTMLDivElement;
  trigger: HTMLButtonElement;
  select: HTMLSelectElement;
  popup: HTMLDivElement;
  observer: MutationObserver;
  anchorLeft?: number;
  anchorTop?: number;
}

let active: ActiveListbox | null = null;
let nextListboxId = 1;
const listboxes = new Set<ActiveListbox>();
let detachedListboxObserver: MutationObserver | null = null;

function watchDetachedListboxes(body: HTMLElement): void {
  if (detachedListboxObserver) return;
  detachedListboxObserver = new MutationObserver(() => {
    for (const listbox of listboxes) {
      if (listbox.wrapper.isConnected) continue;
      if (active === listbox) closeActive();
      listbox.observer.disconnect();
      listbox.popup.remove();
      listboxes.delete(listbox);
    }
  });
  detachedListboxObserver.observe(body, { childList: true, subtree: true });
}

function enabledOptions(select: HTMLSelectElement): HTMLOptionElement[] {
  return Array.from(select.options).filter((option) => {
    const group = option.parentElement;
    return !option.disabled && !(group instanceof HTMLOptGroupElement && group.disabled);
  });
}

function accessibleName(select: HTMLSelectElement): string {
  const explicit = select.getAttribute("aria-label")?.trim();
  if (explicit) return explicit;
  const labels = Array.from(select.labels ?? [])
    .map((label) => label.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
  if (labels) return labels;
  const tooltip = select.getAttribute("data-tooltip")?.trim();
  if (tooltip) return tooltip;
  return select.id ? select.id.replace(/[-_]+/g, " ") : "Выбор";
}

function selectedOption(select: HTMLSelectElement): HTMLOptionElement | null {
  return select.options[select.selectedIndex] ?? null;
}

function syncTrigger(listbox: ActiveListbox): void {
  // DOM patching can leave a single select at -1 after options are replaced.
  // Restore the browser's normal first-option default instead of a blank label.
  if (listbox.select.selectedIndex < 0 && listbox.select.options.length > 0)
    listbox.select.selectedIndex = 0;
  const option = selectedOption(listbox.select);
  const label = listbox.trigger.querySelector<HTMLSpanElement>(".listbox-label");
  if (label) label.textContent = option?.text ?? "";
  listbox.wrapper.dataset.value = listbox.select.value;
  listbox.trigger.disabled = listbox.select.disabled;
  if (listbox.trigger.disabled && active?.wrapper === listbox.wrapper) closeActive();
  if (listbox.popup.classList.contains("is-open")) {
    for (const row of listbox.popup.querySelectorAll<HTMLElement>("[role=option]")) {
      row.setAttribute("aria-selected", String(row.dataset.value === listbox.select.value));
      row.classList.toggle("selected", row.dataset.value === listbox.select.value);
    }
  }
}

function buildOptions(listbox: ActiveListbox): void {
  const { select, popup } = listbox;
  popup.replaceChildren();
  const options = document.createElement("ul");
  options.className = "listbox-list";
  options.id = `${popup.id}-options`;
  options.setAttribute("role", "presentation");

  Array.from(select.options).forEach((option, index) => {
    const group = option.parentElement;
    const disabled = option.disabled || (group instanceof HTMLOptGroupElement && group.disabled);
    const row = document.createElement("li");
    row.id = `${popup.id}-option-${index}`;
    row.className = "listbox-option";
    row.dataset.value = option.value;
    row.dataset.index = String(index);
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(option.selected));
    row.setAttribute("aria-disabled", String(disabled));
    if (disabled) row.classList.add("disabled");
    if (option.selected) row.classList.add("selected");
    row.textContent = option.text;
    options.appendChild(row);
  });
  popup.appendChild(options);
}

function selectedIndex(listbox: ActiveListbox): number {
  return Math.max(0, listbox.select.selectedIndex);
}

function setActiveIndex(listbox: ActiveListbox, index: number): void {
  const rows = Array.from(listbox.popup.querySelectorAll<HTMLElement>("[role=option]"));
  for (const row of rows) {
    const selected = Number(row.dataset.index) === index && row.getAttribute("aria-disabled") !== "true";
    row.classList.toggle("active", selected);
    if (selected) {
      listbox.trigger.setAttribute("aria-activedescendant", row.id);
      const popupRect = listbox.popup.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      if (rowRect.top < popupRect.top) listbox.popup.scrollTop -= popupRect.top - rowRect.top;
      else if (rowRect.bottom > popupRect.bottom) listbox.popup.scrollTop += rowRect.bottom - popupRect.bottom;
    }
  }
}

function moveActive(listbox: ActiveListbox, direction: 1 | -1, edge?: "start" | "end"): void {
  const eligible = enabledOptions(listbox.select);
  if (eligible.length === 0) return;
  const current = listbox.trigger.getAttribute("aria-activedescendant");
  const activeRow = current ? document.getElementById(current) : null;
  const activeIndex = activeRow ? Number((activeRow as HTMLElement).dataset.index) : selectedIndex(listbox);
  let target: HTMLOptionElement | undefined;
  if (edge === "start") target = eligible[0];
  else if (edge === "end") target = eligible[eligible.length - 1];
  else {
    const next = eligible.find((option) => option.index > activeIndex);
    const previous = [...eligible].reverse().find((option) => option.index < activeIndex);
    target = direction === 1 ? next ?? eligible[eligible.length - 1] : previous ?? eligible[0];
  }
  if (target) setActiveIndex(listbox, target.index);
}

function positionPopup(listbox: ActiveListbox): void {
  const triggerRect = listbox.trigger.getBoundingClientRect();
  listbox.anchorLeft = triggerRect.left;
  listbox.anchorTop = triggerRect.top;
  const margin = 8;
  const gap = 4;
  const desiredHeight = Math.min(listbox.popup.scrollHeight, 280);
  const below = window.innerHeight - triggerRect.bottom - margin;
  const above = triggerRect.top - margin;
  const placeAbove = below < Math.min(desiredHeight, 160) && above > below;
  const available = Math.max(0, placeAbove ? above : below);
  const height = Math.min(desiredHeight, available);
  const width = Math.min(triggerRect.width, Math.max(0, window.innerWidth - 2 * margin));
  const left = Math.min(
    Math.max(margin, triggerRect.left),
    Math.max(margin, window.innerWidth - width - margin),
  );
  const top = placeAbove
    ? Math.max(margin, triggerRect.top - height - gap)
    : Math.min(window.innerHeight - height - margin, triggerRect.bottom + gap);

  listbox.popup.style.position = "fixed";
  listbox.popup.style.left = `${left}px`;
  listbox.popup.style.top = `${top}px`;
  listbox.popup.style.right = "auto";
  listbox.popup.style.bottom = "auto";
  listbox.popup.style.width = `${width}px`;
  listbox.popup.style.maxHeight = `${height}px`;
}

function closeActive(restoreFocus = false): void {
  if (!active) return;
  const listbox = active;
  active = null;
  listbox.wrapper.classList.remove("listbox-open");
  listbox.popup.classList.remove("is-open");
  listbox.popup.style.display = "none";
  listbox.trigger.setAttribute("aria-expanded", "false");
  listbox.trigger.removeAttribute("aria-activedescendant");
  document.removeEventListener("click", onOutsideClick, true);
  window.removeEventListener("scroll", onViewportChange, true);
  window.removeEventListener("resize", onViewportChange);
  if (restoreFocus && listbox.trigger.isConnected && !listbox.trigger.disabled) {
    listbox.trigger.focus();
  }
}

function onOutsideClick(event: MouseEvent): void {
  const target = event.target as Node | null;
  if (target && active && (active.wrapper.contains(target) || active.popup.contains(target))) return;
  closeActive();
}

function onViewportChange(event: Event): void {
  const target = event.target;
  if (event.type === "scroll" && target instanceof Node && active?.popup.contains(target)) return;
  // Focusing a clipped trigger can deliver a queued scroll after opening. Only
  // dismiss for scrolling that actually moves the anchor out of alignment.
  if (event.type === "scroll" && active) {
    const rect = active.trigger.getBoundingClientRect();
    if (rect.left === active.anchorLeft && rect.top === active.anchorTop) return;
  }
  closeActive();
}

function openPopup(listbox: ActiveListbox, initial: "selected" | "next" | "previous" = "selected"): void {
  if (listbox.trigger.disabled) return;
  if (active?.wrapper === listbox.wrapper) {
    closeActive();
    return;
  }
  closeActive();
  buildOptions(listbox);
  listbox.wrapper.classList.add("listbox-open");
  listbox.popup.classList.add("is-open");
  listbox.popup.style.display = "block";
  listbox.trigger.setAttribute("aria-expanded", "true");
  active = listbox;

  // The popup is portalled to body so overflow on dialogs and permission tables
  // cannot clip it. Fixed coordinates keep it aligned to the trigger in the viewport.
  positionPopup(listbox);
  const selected = selectedIndex(listbox);
  listbox.popup.setAttribute("role", "listbox");
  listbox.popup.setAttribute("aria-label", accessibleName(listbox.select));
  setActiveIndex(listbox, selected);
  if (initial === "next") moveActive(listbox, 1);
  else if (initial === "previous") moveActive(listbox, -1);
  document.addEventListener("click", onOutsideClick, true);
  window.addEventListener("scroll", onViewportChange, true);
  window.addEventListener("resize", onViewportChange);
}

function chooseActive(listbox: ActiveListbox): void {
  const id = listbox.trigger.getAttribute("aria-activedescendant");
  const row = id ? document.getElementById(id) : null;
  if (!row || row.getAttribute("aria-disabled") === "true") return;
  const option = listbox.select.options[Number((row as HTMLElement).dataset.index)];
  if (!option || option.disabled || listbox.select.disabled) return;
  const changed = listbox.select.value !== option.value;
  listbox.select.value = option.value;
  syncTrigger(listbox);
  closeActive();
  if (changed) listbox.select.dispatchEvent(new Event("change", { bubbles: true }));
  focusTrigger(listbox.select);
}

function focusTrigger(select: HTMLSelectElement): void {
  const current = select.isConnected ? select : select.id ? document.getElementById(select.id) as HTMLSelectElement | null : null;
  let trigger = current?.closest<HTMLDivElement>(".listbox-wrapper")?.querySelector<HTMLButtonElement>(".listbox-trigger");
  if (!trigger) {
    const name = accessibleName(select);
    const matches = Array.from(document.querySelectorAll<HTMLButtonElement>(".listbox-trigger"))
      .filter((candidate) => candidate.getAttribute("aria-label") === name);
    if (matches.length === 1) trigger = matches[0];
  }
  if (trigger?.isConnected && !trigger.disabled) trigger.focus();
}

function onKeyDown(listbox: ActiveListbox, event: KeyboardEvent): void {
  if (listbox.trigger.disabled) return;
  if (event.key === "Tab") {
    closeActive();
    return;
  }
  if (event.key === "Escape") {
    if (active?.wrapper === listbox.wrapper) {
      event.preventDefault();
      closeActive(true);
    }
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    if (active?.wrapper !== listbox.wrapper) {
      openPopup(listbox, direction === 1 ? "next" : "previous");
    } else {
      moveActive(listbox, direction);
    }
    return;
  }
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    if (active?.wrapper !== listbox.wrapper) openPopup(listbox);
    moveActive(listbox, event.key === "Home" ? 1 : -1, event.key === "Home" ? "start" : "end");
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (active?.wrapper === listbox.wrapper) chooseActive(listbox);
    else openPopup(listbox);
  }
}

function wrap(select: HTMLSelectElement, portal: HTMLElement): void {
  if (select.dataset.listboxWrapped === "1") return;
  if (select.multiple || select.size > 1 || select.closest("[data-native-select]")) return;

  const parent = select.parentNode;
  if (!parent) return;
  select.dataset.listboxWrapped = "1";

  const wrapper = document.createElement("div");
  wrapper.className = "listbox-wrapper";
  if (select.classList.contains("screen-quality-select")) wrapper.classList.add("listbox-compact");
  wrapper.dataset.value = select.value;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "listbox-trigger";
  trigger.id = `listbox-trigger-${nextListboxId}`;
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-label", accessibleName(select));
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.disabled = select.disabled;
  trigger.innerHTML = `<span class="listbox-label"></span><span class="listbox-chevron" aria-hidden="true">▾</span>`;

  const popup = document.createElement("div");
  popup.className = "listbox-popup listbox-portal";
  popup.id = `listbox-popup-${nextListboxId}`;
  popup.setAttribute("role", "listbox");
  popup.setAttribute("aria-label", accessibleName(select));
  popup.style.display = "none";
  trigger.setAttribute("aria-controls", popup.id);
  nextListboxId += 1;

  const listbox: ActiveListbox = {
    wrapper,
    trigger,
    select,
    popup,
    observer: new MutationObserver(() => {
      syncTrigger(listbox);
    }),
  };

  // Keep the native value for forms and existing change handlers. The trigger
  // is the single keyboard/screen-reader control for this select.
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  parent.insertBefore(wrapper, select);
  wrapper.appendChild(select);
  wrapper.appendChild(trigger);
  portal.appendChild(popup);
  listboxes.add(listbox);
  watchDetachedListboxes(portal);
  syncTrigger(listbox);

  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (active?.wrapper === wrapper) closeActive();
    else openPopup(listbox);
  });
  trigger.addEventListener("keydown", (event) => onKeyDown(listbox, event));
  select.addEventListener("change", () => syncTrigger(listbox));
  listbox.observer.observe(select, { attributes: true, attributeFilter: ["disabled"], childList: true, subtree: true });

  popup.addEventListener("pointermove", (event) => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>("[role=option]");
    if (row && row.getAttribute("aria-disabled") !== "true") {
      setActiveIndex(listbox, Number(row.dataset.index));
    }
  });
  popup.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>("[role=option]");
    if (!row || row.getAttribute("aria-disabled") === "true") return;
    setActiveIndex(listbox, Number(row.dataset.index));
    chooseActive(listbox);
  });
}

export function polishListboxes(root: ParentNode = document): void {
  const selects = root.querySelectorAll<HTMLSelectElement>(
    "select:not([multiple]):not([size]), select[size='1']",
  );
  const doc = root instanceof Document ? root : root.ownerDocument ?? document;
  const portal = doc.body;
  for (const select of selects) wrap(select, portal);
}
