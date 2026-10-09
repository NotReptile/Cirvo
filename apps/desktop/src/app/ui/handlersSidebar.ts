import { bindEvent, delegate } from "../dom";
import { describeError } from "../errors";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import { loadChannelPermissions } from "./channelSettings";
import {
  applyPttModeToActiveSessions,
  enterDMMode,
  exitDMMode,
  selectChannel,
} from "./loaders";
import { attachDragReorderHandlers } from "./members";
import { selectWorkspace } from "./session";

export function attachSidebarRegion(): void {
  uiContext.rootEl.querySelector<HTMLButtonElement>("#ws-rail-dm")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#ws-rail-dm"),
        "click",
        () => {
          enterDMMode();
        },
        "bind-453278",
      )
    : undefined;

  uiContext.rootEl.querySelectorAll<HTMLElement>("[data-ws]").forEach((el) => {
    bindEvent(
      el,
      "click",
      () => {
        const id = el.dataset.ws;
        if (!id) return;
        if (uiContext.state.dmMode) {
          exitDMMode(id);
        } else if (id !== uiContext.state.selectedWorkspaceId) {
          void selectWorkspace(id);
        }
      },
      "bind-453468",
    );
    bindEvent(
      el,
      "contextmenu",
      (ev) => {
        ev.preventDefault();
        const id = el.dataset.ws;
        if (!id) return;
        const x = Math.min(ev.clientX, window.innerWidth - 220);
        const y = Math.min(ev.clientY, window.innerHeight - 160);
        uiContext.state.workspaceMenu = { workspaceId: id, x, y };
        render();
      },
      "bind-453717",
    );
  });

  uiContext.rootEl
    .querySelectorAll<HTMLLIElement>("[data-ch]")
    .forEach((li) => {
      bindEvent(
        li,
        "click",
        () => {
          const id = li.dataset.ch;
          if (id && id !== uiContext.state.selectedChannelId)
            void selectChannel(id);
        },
        "bind-454133",
      );
      // K.4: Discord-pattern — двойной клик по voice-каналу сразу подключает.
      // Одиночный клик остаётся «peek» (открыть voice-room с участниками,
      // без join'а). Не-voice каналы dblclick игнорят.
      bindEvent(
        li,
        "dblclick",
        async () => {
          const id = li.dataset.ch;
          if (!id) return;
          const ch = uiContext.state.channels.find((c) => c.id === id);
          if (!ch || ch.kind !== "voice") return;
          const snap = uiContext.voiceMgr.getSnapshot();
          if (snap.channelId === id && snap.state !== "leaving") return; // уже там
          try {
            await uiContext.voiceMgr.join(id);
            applyPttModeToActiveSessions();
          } catch (err) {
            uiContext.state.status = describeError(err);
            render();
          }
        },
        "bind-454490",
      );
      bindEvent(
        li,
        "contextmenu",
        (ev) => {
          ev.preventDefault();
          const id = li.dataset.ch;
          if (!id) return;
          // Меню рендерится absolute по координатам курсора; зажимаем по краям
          // вьюпорта, чтобы не уехать за экран (ширина меню ~200px).
          const x = Math.min(ev.clientX, window.innerWidth - 220);
          const y = Math.min(ev.clientY, window.innerHeight - 160);
          uiContext.state.channelMenu = { channelId: id, x, y };
          render();
        },
        "bind-455006",
      );
    });
  attachDragReorderHandlers();

  // J.2: hover-кнопки на канале. stopPropagation, чтобы клик не съел
  // также `selectChannel`-handler на <li>.
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-ch-settings]",
    "click",
    (ev, btn) => {
      ev.stopPropagation();
      const id = btn.dataset.chSettings;
      if (!id) return;
      const ch = uiContext.state.channels.find((c) => c.id === id);
      uiContext.state.modal = "channelSettings";
      uiContext.state.channelSettings = {
        channelId: id,
        tab: "overview",
        loading: true,
        saving: false,
        error: null,
        data: null,
        draft: {},
        userData: null,
        userDraft: {},
        overviewDraft: {
          name: ch?.name ?? "",
          topic: ch?.topic ?? "",
          slowMode: ch?.slowModeSeconds ?? 0,
          isNsfw: !!ch?.isNsfw,
          categoryId: ch?.categoryId ?? "",
          nameColor: ch?.nameColor ?? "",
        },
      };
      render();
      void loadChannelPermissions();
    },
    "delegate-456275",
  );
}
