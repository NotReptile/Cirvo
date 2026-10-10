import { bindEvent, delegate } from "../dom";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type { PresenceMode } from "../types";
import { saveStatus } from "./loaders";

export function polishStatusMenu(): void {
  const menu = uiContext.rootEl.querySelector<HTMLElement>(".status-menu");
  if (menu) {
    menu.style.maxHeight = `${Math.max(0, innerHeight - 16)}px`;
    menu.style.maxWidth = `${Math.max(0, innerWidth - 16)}px`;
    menu.style.overflowY = "auto";
    const rect = menu.getBoundingClientRect();
    const dx = rect.left < 8 ? 8 - rect.left : rect.right > innerWidth - 8 ? innerWidth - 8 - rect.right : 0;
    const dy = rect.top < 8 ? 8 - rect.top : rect.bottom > innerHeight - 8 ? innerHeight - 8 - rect.bottom : 0;
    if (dx) menu.style.left = `${parseFloat(menu.style.left) + dx}px`;
    if (dy) menu.style.top = `${parseFloat(menu.style.top) + dy}px`;
  }
  bindEvent(window, "resize", polishStatusMenu, "presence-menu-resize");
}

export function attachPresenceRegion(): void {
  uiContext.rootEl.querySelector<HTMLButtonElement>("#open-status")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#open-status"),
        "click",
        (ev) => {
          const target = ev.currentTarget as HTMLElement;
          const rect = target.getBoundingClientRect();
          // Открываем popup НАД user-strip'ом (Discord-like): фиксируем нижний
          // край popup'а к верху кнопки. Слева — у кнопки.
          uiContext.state.statusMenu = {
            x: Math.max(8, rect.left),
            y: Math.max(8, rect.top - 8),
            draftMode:
              (uiContext.state.me?.presenceMode as PresenceMode) ?? "online",
            draftCustom: uiContext.state.me?.customStatus ?? "",
          };
          render(new Set(["presence"]));
        },
        "bind-430228",
      )
    : undefined;

  uiContext.rootEl.querySelector<HTMLElement>("[data-status-menu-close]")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLElement>("[data-status-menu-close]"),
        "click",
        () => {
          uiContext.state.statusMenu = null;
          render(new Set(["presence"]));
        },
        "bind-430793",
      )
    : undefined;

  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-status-mode]",
    "click",
    (_event, btn) => {
      if (!uiContext.state.statusMenu) return;
      uiContext.state.statusMenu.draftMode = btn.dataset
        .statusMode as PresenceMode;
      render(new Set(["presence"]));
    },
    "delegate-431331",
  );

  const statusCustomInput = uiContext.rootEl.querySelector<HTMLInputElement>(
    "#status-custom-input",
  );
  if (statusCustomInput) {
    bindEvent(
      statusCustomInput,
      "input",
      () => {
        if (uiContext.state.statusMenu)
          uiContext.state.statusMenu.draftCustom = statusCustomInput.value;
      },
      "bind-431316",
    );
  }

  uiContext.rootEl.querySelector<HTMLButtonElement>("#status-clear")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#status-clear"),
        "click",
        () => {
          if (!uiContext.state.statusMenu) return;
          uiContext.state.statusMenu.draftCustom = "";
          void saveStatus(uiContext.state.statusMenu.draftMode, "");
        },
        "bind-431467",
      )
    : undefined;

  uiContext.rootEl.querySelector<HTMLButtonElement>("#status-save")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#status-save"),
        "click",
        () => {
          if (!uiContext.state.statusMenu) return;
          const { draftMode, draftCustom } = uiContext.state.statusMenu;
          void saveStatus(draftMode, draftCustom);
        },
        "bind-431677",
      )
    : undefined;
}
