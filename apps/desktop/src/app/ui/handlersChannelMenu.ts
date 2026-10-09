import { confirmDialog, promptDialog } from "../dialogs";
import { bindEvent, delegate } from "../dom";
import { describeError } from "../errors";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type { Channel, NotifLevel } from "../types";
import { setChannelNotifLevel, startUpdateInstall } from "./loaders";

export function attachChannelMenuRegion(): void {
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-channel-action]",
    "click",
    async (_event, btn) => {
      const action = btn.dataset.channelAction;
      const id = btn.dataset.id;
      if (!id || !action) return;
      uiContext.state.channelMenu = null;
      const ch = uiContext.state.channels.find((c) => c.id === id);
      if (!ch) {
        render();
        return;
      }
      if (action === "copy-id") {
        try {
          await navigator.clipboard.writeText(id);
          uiContext.state.status = `ID канала #${ch.name} скопирован`;
        } catch {
          uiContext.state.status = "Не удалось скопировать";
        }
        render();
        return;
      }
      if (action === "mark-read") {
        // Берём последнее сообщение канала, если оно загружено — иначе
        // просто шлём read без курсора (бэк интерпретирует как «текущий момент»
        // — см. message-module/handleRead). Безопасно: повторный POST идемпотентен.
        const last =
          uiContext.state.selectedChannelId === id &&
          uiContext.state.messages.length > 0
            ? uiContext.state.messages[uiContext.state.messages.length - 1].id
            : "";
        try {
          await uiContext.httpClient.post(
            `/api/v1/channels/${id}/read`,
            last ? { messageId: last } : {},
          );
          uiContext.state.unread[id] = 0;
        } catch (err) {
          uiContext.state.status = describeError(err);
        }
        render();
        return;
      }
      if (action === "invite") {
        // Существующая модалка инвайтов завязана на workspace. Открываем её
        // и подсказываем юзеру выбрать конкретный канал внутри.
        uiContext.state.invitesOpen = true;
        uiContext.state.status = `Создай инвайт в воркспейс — он привяжет нового участника, а доступ к #${ch.name} даст admin'у через настройки канала.`;
        render();
        return;
      }
      if (action === "notif") {
        const level = (btn.dataset.level ?? "") as NotifLevel | "";
        void setChannelNotifLevel(id, level);
        return;
      }
      if (action === "clone") {
        // Backend ещё не имеет /clone — постим обычный create с такими же
        // полями. kind клонируется, имя — "<имя>-копия" (если уже есть, бэк
        // вернёт 409 — мы покажем ошибку, юзер переименует).
        const baseName = ch.name.length > 56 ? ch.name.slice(0, 56) : ch.name;
        try {
          const created = await uiContext.httpClient.post<Channel>(
            `/api/v1/workspaces/${ch.workspaceId}/channels`,
            {
              kind: ch.kind,
              name: `${baseName}-копия`,
              topic: ch.topic ?? "",
              isPrivate: ch.isPrivate,
            },
          );
          if (
            created &&
            !uiContext.state.channels.some((c) => c.id === created.id)
          ) {
            uiContext.state.channels = [...uiContext.state.channels, created];
          }
        } catch (err) {
          uiContext.state.status = describeError(err);
        }
        render();
        return;
      }
      if (action === "archive" || action === "unarchive") {
        // Wave 8: soft-archive через PATCH. realtime channel.updated догонит
        // остальных клиентов; локально апдейтим ответом сразу.
        try {
          const updated = await uiContext.httpClient.patch<Channel>(
            `/api/v1/channels/${id}`,
            {
              archived: action === "archive",
            },
          );
          uiContext.state.channels = uiContext.state.channels.map((c) =>
            c.id === id ? updated : c,
          );
        } catch (err) {
          uiContext.state.status = describeError(err);
        }
        render();
        return;
      }
      if (action === "rename") {
        const nextRaw = await promptDialog({
          title: "Переименовать канал",
          label: "Новое имя",
          initial: ch.name,
          placeholder: "общая, voice, гейминг…",
        });
        const next = nextRaw?.trim();
        if (!next || next === ch.name) {
          render();
          return;
        }
        try {
          await uiContext.httpClient.patch<Channel>(`/api/v1/channels/${id}`, {
            name: next,
          });
          // realtime channel.updated догонит локальный state, но если
          // публикация не сработает (нет realtimebus в этой инстанции) —
          // апдейтим оптимистично.
          uiContext.state.channels = uiContext.state.channels.map((c) =>
            c.id === id ? { ...c, name: next } : c,
          );
        } catch (err) {
          uiContext.state.status = describeError(err);
        }
        render();
        return;
      }
      if (action === "delete") {
        const ok = await confirmDialog({
          title: "Удалить канал",
          body: `История сообщений и вложения канала #${ch.name} удалятся безвозвратно.`,
          confirmText: ch.name,
          confirmLabel: "Удалить",
          danger: true,
        });
        if (!ok) {
          render();
          return;
        }
        try {
          await uiContext.httpClient.del(`/api/v1/channels/${id}`);
          uiContext.state.channels = uiContext.state.channels.filter(
            (c) => c.id !== id,
          );
          if (uiContext.state.selectedChannelId === id) {
            uiContext.state.selectedChannelId = null;
            uiContext.state.messages = [];
          }
        } catch (err) {
          uiContext.state.status = describeError(err);
        }
        render();
        return;
      }
    },
    "delegate-469863",
  );

  uiContext.rootEl.querySelector<HTMLButtonElement>("#update-install")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#update-install"),
        "click",
        () => {
          void startUpdateInstall();
        },
        "bind-473948",
      )
    : undefined;
}
