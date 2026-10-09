import { confirmDialog, promptDialog } from "../dialogs";
import { bindEvent, delegate } from "../dom";
import { describeError } from "../errors";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type { ChannelCategory, Workspace } from "../types";
import { attachCreateChannelHandlers } from "./channelCreate";
import { createCategoryFlow, isArchiveCollapsed } from "./channelView";
import { setTransientStatus } from "./helpers";
import { loadInvites, selectChannel, slugify } from "./loaders";
import { openWorkspaceSettings } from "./profile";
import {
  loadWorkspaces,
  saveCollapsedCategories,
  selectWorkspace,
} from "./session";
import {
  attachWorkspaceSettingsHandlers,
  openCreateChannelModal,
} from "./workspaceSettings";

export function attachWorkspaceCreateRegion(): void {
  uiContext.rootEl.querySelector<HTMLButtonElement>("#ws-rail-create")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#ws-rail-create"),
        "click",
        async () => {
          const raw = await promptDialog({
            title: "Новый воркспейс",
            label: "Название",
            placeholder: "Моё сообщество",
          });
          const name = raw?.trim();
          if (!name) return;
          const slug = slugify(name);
          if (slug.length < 3) {
            uiContext.state.status =
              "Имя должно содержать минимум 3 буквы/цифры для генерации адреса.";
            render();
            return;
          }
          try {
            const ws = await uiContext.httpClient.post<Workspace>(
              "/api/v1/workspaces",
              { name, slug },
            );
            uiContext.state.workspaces = [...uiContext.state.workspaces, ws];
            uiContext.realtimeClient.refreshSubscriptions();
            await selectWorkspace(ws.id);
          } catch (err) {
            uiContext.state.status = describeError(err);
            render();
          }
        },
        "bind-474082",
      )
    : undefined;

  uiContext.rootEl.querySelector<HTMLButtonElement>("#ws-rail-invite")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#ws-rail-invite"),
        "click",
        async () => {
          const raw = await promptDialog({
            title: "Принять приглашение",
            label: "Код инвайта",
            placeholder: "abc123…",
          });
          const code = raw?.trim();
          if (!code) return;
          try {
            const res = await uiContext.httpClient.post<{
              workspaceId: string;
              role: string;
              channelId?: string;
            }>(`/api/v1/invites/${encodeURIComponent(code)}/accept`);
            await loadWorkspaces();
            uiContext.realtimeClient.refreshSubscriptions();
            await selectWorkspace(res.workspaceId);
            // J.3(a): если инвайт был channel-scoped — открываем сразу нужный канал.
            if (res.channelId) {
              await selectChannel(res.channelId);
            }
            setTransientStatus("Вы вступили в воркспейс");
          } catch (err) {
            uiContext.state.status = describeError(err);
            render();
          }
        },
        "bind-474881",
      )
    : undefined;

  // J.5: «+ канал» внутри категории / orphan-блока. Открывает createChannel-
  // модалку с предзаполненным categoryId — пользователь сам выбирает kind
  // через radio в модалке (раньше kind определялся фиксированной hardcode-
  // секцией text/voice, теперь категории могут содержать оба типа).
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".ch-category-add[data-create-in-category]",
    "click",
    (e, btn) => {
      e.preventDefault();
      if (!uiContext.state.selectedWorkspaceId) return;
      const catId = btn.dataset.createInCategory ?? null;
      openCreateChannelModal(
        uiContext.state.selectedWorkspaceId,
        "text",
        catId,
      );
    },
    "delegate-477047",
  );
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".ch-category-add[data-create-orphan]",
    "click",
    (e, btn) => {
      e.preventDefault();
      if (!uiContext.state.selectedWorkspaceId) return;
      openCreateChannelModal(uiContext.state.selectedWorkspaceId, "text", null);
    },
    "delegate-477415",
  );

  // J.5: workspace-dropdown — toggle на заголовок.
  uiContext.rootEl.querySelector<HTMLButtonElement>("#open-ws-menu")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#open-ws-menu"),
        "click",
        (e) => {
          e.stopPropagation();
          uiContext.state.workspaceMenuOpen =
            !uiContext.state.workspaceMenuOpen;
          if (
            uiContext.state.workspaceMenuOpen &&
            document.activeElement instanceof HTMLElement
          ) {
            document.activeElement.blur();
          }
          render();
        },
        "bind-476752",
      )
    : undefined;
  // Клик по любому пункту меню — закрываем и выполняем действие.
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-ws-menu]",
    "click",
    async (e, btn) => {
      e.stopPropagation();
      const action = btn.dataset.wsMenu;
      const wsId = uiContext.state.selectedWorkspaceId;
      if (!wsId) return;
      uiContext.state.workspaceMenuOpen = false;
      if (action === "invite") {
        uiContext.state.modal = "invites";
        render();
        await loadInvites();
        return;
      }
      if (action === "settings") {
        openWorkspaceSettings(wsId);
        return;
      }
      if (action === "create-channel") {
        openCreateChannelModal(wsId, "text", null);
        return;
      }
      if (action === "create-category") {
        render();
        await createCategoryFlow(wsId);
        return;
      }
      render();
    },
    "delegate-478161",
  );
  // Click-outside закрывает dropdown.
  if (uiContext.state.workspaceMenuOpen) {
    const onOutside = (ev: MouseEvent): void => {
      const target = ev.target as HTMLElement | null;
      if (target?.closest(".ws-menu") || target?.closest("#open-ws-menu"))
        return;
      uiContext.state.workspaceMenuOpen = false;
      document.removeEventListener("click", onOutside, true);
      render();
    };
    setTimeout(
      () => bindEvent(document, "click", onOutside, "bind-478332", true),
      0,
    );
  }

  // J.5: ⚙ управления категорией — выпадающее меню «Переименовать / Удалить».
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".ch-category-settings",
    "click",
    async (e, btn) => {
      e.stopPropagation();
      const catId = btn.dataset.categoryId;
      if (!catId) return;
      const cat = uiContext.state.categories.find((c) => c.id === catId);
      if (!cat) return;
      const ok = await confirmDialog({
        title: `Категория «${cat.name}»`,
        body: "Что сделать?",
        confirmLabel: "Переименовать",
        cancelLabel: "Удалить",
      });
      if (ok) {
        // Переименовать
        const raw = await promptDialog({
          title: "Переименовать категорию",
          label: "Название",
          initial: cat.name,
        });
        const name = raw?.trim();
        if (!name || name === cat.name) return;
        try {
          const updated = await uiContext.httpClient.patch<ChannelCategory>(
            `/api/v1/categories/${cat.id}`,
            { name },
          );
          uiContext.state.categories = uiContext.state.categories.map((c) =>
            c.id === updated.id ? updated : c,
          );
          render();
        } catch (err) {
          uiContext.state.status = describeError(err);
          render();
        }
      } else {
        // Удалить — typed-confirm на имя категории.
        const confirmed = await confirmDialog({
          title: "Удалить категорию",
          body: `Категория «${cat.name}» исчезнет, каналы переедут в «Без категории».`,
          confirmText: cat.name,
          confirmLabel: "Удалить",
          danger: true,
        });
        if (!confirmed) return;
        try {
          await uiContext.httpClient.del(`/api/v1/categories/${cat.id}`);
          uiContext.state.categories = uiContext.state.categories.filter(
            (c) => c.id !== cat.id,
          );
          uiContext.state.channels = uiContext.state.channels.map((ch) =>
            ch.categoryId === cat.id ? { ...ch, categoryId: null } : ch,
          );
          render();
        } catch (err) {
          uiContext.state.status = describeError(err);
          render();
        }
      }
    },
    "delegate-479519",
  );

  // J.6: toggle свёрнутости категории.
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-category-collapse]",
    "click",
    (e, btn) => {
      e.stopPropagation();
      const catId = btn.dataset.categoryCollapse;
      if (!catId) return;
      if (uiContext.state.collapsedCategories.has(catId))
        uiContext.state.collapsedCategories.delete(catId);
      else uiContext.state.collapsedCategories.add(catId);
      saveCollapsedCategories();
      render();
    },
    "delegate-481501",
  );
  // Wave 8: collapse-toggle блока «Архив».
  uiContext.rootEl.querySelector<HTMLButtonElement>("[data-archive-collapse]")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "[data-archive-collapse]",
        ),
        "click",
        (e) => {
          e.stopPropagation();
          try {
            localStorage.setItem(
              uiContext.ARCHIVE_COLLAPSED_KEY,
              isArchiveCollapsed() ? "0" : "1",
            );
          } catch {
            /* quota / disabled */
          }
          render();
        },
        "bind-480892",
      )
    : undefined;
  attachCreateChannelHandlers();
  attachWorkspaceSettingsHandlers();

  uiContext.rootEl.querySelector<HTMLButtonElement>("#open-ws-settings")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#open-ws-settings"),
        "click",
        () => {
          if (uiContext.state.selectedWorkspaceId)
            openWorkspaceSettings(uiContext.state.selectedWorkspaceId);
        },
        "bind-481257",
      )
    : undefined;
}
