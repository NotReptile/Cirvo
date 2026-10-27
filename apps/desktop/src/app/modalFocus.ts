let returnFocus: HTMLElement | null = null;
let modalWasOpen = false;

function currentDialog(): HTMLElement | null {
  const status = document.querySelector<HTMLElement>(".status-menu");
  if (status) return status;
  const picker = document.querySelector<HTMLElement>(".cirvo-input-picker:popover-open");
  if (picker) return picker;
  const confirmation = document.querySelector<HTMLElement>("#cirvo-dialogs .dlg-backdrop:last-child .dlg-card");
  if (confirmation) return confirmation;
  const region = document.querySelector("#region-modal");
  const dialogs = region?.querySelectorAll<HTMLElement>('[role="dialog"], .modal');
  return dialogs?.length ? dialogs[dialogs.length - 1] : null;
}

export function polishModalFocus(): void {
  const dialog = currentDialog();
  if (dialog) {
    if (!dialog.classList.contains("status-menu")) {
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
    }
    if (!modalWasOpen) returnFocus = document.activeElement as HTMLElement | null;
    modalWasOpen = true;
  } else if (modalWasOpen) {
    modalWasOpen = false;
    if (returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  }
}

document.addEventListener("keydown", event => {
  if (event.key !== "Tab") return;
  // The select popup owns navigation and closes before normal Tab handling.
  if (document.querySelector(".listbox-popup.listbox-portal.is-open")) return;
  const dialog = currentDialog();
  if (!dialog) return;
  const candidates = Array.from(dialog.querySelectorAll<HTMLElement>(
    'button, input, select, textarea, a[href], [tabindex]',
  )).filter(element => {
    const style = getComputedStyle(element);
    return element.tabIndex >= 0 && !element.matches(":disabled") &&
      style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
      element.getClientRects().length > 0;
  });
  if (candidates.length === 0) { event.preventDefault(); return; }
  const index = candidates.indexOf(document.activeElement as HTMLElement);
  if (index < 0 || (!event.shiftKey && index === candidates.length - 1) || (event.shiftKey && index === 0)) {
    event.preventDefault();
    candidates[event.shiftKey ? candidates.length - 1 : 0].focus();
  }
}, true);
