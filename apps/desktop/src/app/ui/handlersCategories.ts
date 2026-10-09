import { bindEvent, delegate } from "../dom";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import { openCategoryPermissions, saveCategoryPermissions } from "./modals";

export function attachCategoriesRegion(): void {
  // Wave 5 (J.5b): ПКМ по заголовку категории.
  delegate<HTMLElement, "contextmenu">(
    uiContext.rootEl,
    "[data-cat-drag]",
    "contextmenu",
    (ev, header) => {
      ev.preventDefault();
      const id = header.dataset.catDrag;
      if (!id) return;
      const x = Math.min(ev.clientX, window.innerWidth - 220);
      const y = Math.min(ev.clientY, window.innerHeight - 120);
      uiContext.state.categoryMenu = { categoryId: id, x, y };
      render();
    },
    "delegate-445023",
  );
  uiContext.rootEl.querySelector<HTMLElement>("[data-category-menu-close]")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLElement>(
          "[data-category-menu-close]",
        ),
        "click",
        () => {
          uiContext.state.categoryMenu = null;
          render();
        },
        "bind-444884",
      )
    : undefined;
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-category-action]",
    "click",
    async (_event, btn) => {
      const action = btn.dataset.categoryAction;
      const id = btn.dataset.id;
      if (!action || !id) return;
      uiContext.state.categoryMenu = null;
      if (action === "permissions") {
        void openCategoryPermissions(id);
        return;
      }
      if (action === "copy-id") {
        try {
          await navigator.clipboard.writeText(id);
          uiContext.state.status = "ID категории скопирован";
        } catch {
          uiContext.state.status = "Не удалось скопировать";
        }
        render();
        return;
      }
    },
    "delegate-445609",
  );
  // Wave 5: селекты в модалке прав категории.
  delegate<HTMLSelectElement, "change">(
    uiContext.rootEl,
    ".cat-perm-select",
    "change",
    (_event, sel) => {
      const key = sel.dataset.key;
      const action = sel.dataset.action;
      if (!key || !action) return;
      if (!uiContext.state.categoryPerms.draft[key])
        uiContext.state.categoryPerms.draft[key] = {};
      uiContext.state.categoryPerms.draft[key][action] = sel.value as
        "inherit" | "grant" | "deny";
    },
    "delegate-446333",
  );
  uiContext.rootEl.querySelector<HTMLButtonElement>("#cat-perm-save")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#cat-perm-save"),
        "click",
        () => {
          void saveCategoryPermissions();
        },
        "bind-446147",
      )
    : undefined;
}
