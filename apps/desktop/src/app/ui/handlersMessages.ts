import { confirmDialog } from "../dialogs";
import { bindEvent, delegate } from "../dom";
import { openEmojiPicker } from "../emojiPicker";
import { describeError } from "../errors";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import { toggleReaction } from "./events";
import { setTransientStatus } from "./helpers";
import { attachDropZoneHandlers, uploadFiles } from "./voiceView";

export function attachMessagesRegion(): void {
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".action-edit",
    "click",
    (_event, btn) => {
      uiContext.state.editingMessageId = btn.dataset.id ?? null;
      render();
    },
    "delegate-484353",
  );

  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".action-delete",
    "click",
    async (_event, btn) => {
      const id = btn.dataset.id;
      if (!id) return;
      const ok = await confirmDialog({
        title: "Удалить сообщение?",
        body: "Сообщение будет помечено удалённым; отменить нельзя.",
        confirmLabel: "Удалить",
        danger: true,
      });
      if (!ok) return;
      try {
        await uiContext.httpClient.del(`/api/v1/messages/${id}`);
      } catch (err) {
        uiContext.state.status = describeError(err);
        render();
      }
    },
    "delegate-484600",
  );

  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".action-react",
    "click",
    (_event, btn) => {
      const messageId = btn.dataset.id;
      if (!messageId) return;
      // Один смайлик → полный пикер эмодзи (с полем «своя реакция»).
      openEmojiPicker({
        anchor: btn,
        allowCustom: true,
        onPick: (emoji) => {
          void toggleReaction(messageId, emoji);
        },
      });
    },
    "delegate-485193",
  );

  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".action-pin",
    "click",
    async (_event, btn) => {
      const id = btn.dataset.id;
      if (!id) return;
      const wasPinned = btn.dataset.pinned === "1";
      try {
        if (wasPinned) {
          await uiContext.httpClient.del(`/api/v1/messages/${id}/pin`);
          setTransientStatus("Откреплено");
        } else {
          await uiContext.httpClient.put(`/api/v1/messages/${id}/pin`);
          setTransientStatus("Закреплено");
        }
      } catch (err) {
        uiContext.state.status = describeError(err);
        render();
      }
    },
    "delegate-485466",
  );

  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-react-toggle]",
    "click",
    (_event, btn) => {
      const messageId = btn.dataset.reactToggle;
      const emoji = btn.dataset.emoji;
      if (!messageId || !emoji) return;
      void toggleReaction(messageId, emoji);
    },
    "delegate-486083",
  );

  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".cancel-edit",
    "click",
    (_event, btn) => {
      uiContext.state.editingMessageId = null;
      render();
    },
    "delegate-486904",
  );

  delegate<HTMLFormElement, "submit">(
    uiContext.rootEl,
    ".edit-form",
    "submit",
    async (e, form) => {
      e.preventDefault();
      const id = form.dataset.editId;
      if (!id) return;
      const input = form.querySelector<HTMLInputElement>('input[name="body"]');
      const body = input?.value.trim() ?? "";
      if (!body) return;
      try {
        await uiContext.httpClient.patch(`/api/v1/messages/${id}`, { body });
        uiContext.state.editingMessageId = null;
        render();
      } catch (err) {
        uiContext.state.status = describeError(err);
        render();
      }
    },
    "delegate-487094",
  );

  uiContext.rootEl.querySelector<HTMLInputElement>("#attach-input")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#attach-input"),
        "change",
        async (e) => {
          const target = e.currentTarget as HTMLInputElement;
          const files = target.files ? Array.from(target.files) : [];
          target.value = "";
          if (files.length === 0) return;
          await uploadFiles(files);
        },
        "bind-486425",
      )
    : undefined;

  attachDropZoneHandlers();

  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    ".pending-remove",
    "click",
    (_event, btn) => {
      const id = btn.dataset.id;
      uiContext.state.pendingUploads = uiContext.state.pendingUploads.filter(
        (p) => p.id !== id,
      );
      render();
    },
    "delegate-488049",
  );

  delegate<HTMLAnchorElement, "click">(
    uiContext.rootEl,
    ".attach-file",
    "click",
    async (e, link) => {
      e.preventDefault();
      const url = link.dataset.mediaUrl;
      const filename = link.dataset.filename || "file";
      if (!url) return;
      try {
        const blob = await uiContext.httpClient.getBlob(url);
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
      } catch (err) {
        uiContext.state.status = describeError(err);
        render();
      }
    },
    "delegate-488316",
  );
}
