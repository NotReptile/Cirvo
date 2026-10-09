import { confirmDialog } from "../dialogs";
import { bindEvent } from "../dom";
import { openEmojiPicker } from "../emojiPicker";
import { describeError } from "../errors";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type { Message, PendingUpload } from "../types";
import { transformSlashCommand } from "../util/commands";
import {
  applyChannelPick,
  applyMentionPick,
  filterChannelMatches,
  filterMentionMatches,
  hideChannelPopup,
  hideMentionPopup,
  isBodyTooLongError,
  isSlowModeError,
  renderChannelPopupContent,
  renderMentionPopupContent,
  setSlowMode,
  updateChannelPopup,
  updateMentionPopup,
} from "./composer";
import { saveDraft, setTransientStatus } from "./helpers";
import {
  maybeSendTyping,
  tryEditLastOwnMessage,
  updateSlashPopup,
} from "./loaders";
import { uploadFiles } from "./voiceView";

export function attachComposerRegion(): void {
  // mention-автокомплит: ловим `@<prefix>` перед каретой и показываем
  // popup. Все обновления — direct DOM, чтобы не дёргать render() и не
  // терять фокус/курсор в input'е (см. техдолг про инкрементальный апдейт).
  const composerInput = uiContext.rootEl.querySelector<HTMLInputElement>(
    '#send-form input[name="body"]',
  );
  const mentionPopup =
    uiContext.rootEl.querySelector<HTMLDivElement>("#mention-popup");
  // Wave 8: попап `#канал` — есть только в workspace-каналах (в DM нет).
  const channelPopup =
    uiContext.rootEl.querySelector<HTMLDivElement>("#channel-popup");
  if (composerInput && mentionPopup) {
    bindEvent(
      composerInput,
      "input",
      () => {
        saveDraft(uiContext.state.selectedChannelId, composerInput.value);
        if (composerInput.value) maybeSendTyping();
        updateMentionPopup(composerInput, mentionPopup);
        if (channelPopup) updateChannelPopup(composerInput, channelPopup);
        updateSlashPopup(composerInput);
      },
      "bind-495899",
    );
    // Wave 2: кнопка-смайл рядом с send. Вставка по каретке + dispatch
    // input — чтобы draft сохранился и mention-popup пересчитался.
    uiContext.rootEl.querySelector<HTMLButtonElement>("#composer-emoji")
      ? bindEvent(
          uiContext.rootEl.querySelector<HTMLButtonElement>("#composer-emoji"),
          "click",
          (ev) => {
            const anchor = ev.currentTarget as HTMLElement;
            openEmojiPicker({
              anchor,
              onPick: (emoji) => {
                const start =
                  composerInput.selectionStart ?? composerInput.value.length;
                const end = composerInput.selectionEnd ?? start;
                composerInput.value =
                  composerInput.value.slice(0, start) +
                  emoji +
                  composerInput.value.slice(end);
                const caret = start + emoji.length;
                composerInput.focus({ preventScroll: true });
                composerInput.setSelectionRange(caret, caret);
                composerInput.dispatchEvent(
                  new Event("input", { bubbles: true }),
                );
              },
            });
          },
          "bind-496379",
        )
      : undefined;
    bindEvent(
      composerInput,
      "click",
      () => {
        updateMentionPopup(composerInput, mentionPopup);
        if (channelPopup) updateChannelPopup(composerInput, channelPopup);
      },
      "bind-497120",
    );
    bindEvent(
      composerInput,
      "keyup",
      (ev) => {
        // ArrowLeft/Right двигают каретку — пересчитаем токен. Стрелки
        // вверх/вниз и Enter обрабатываются на keydown ниже.
        if (
          ev.key === "ArrowLeft" ||
          ev.key === "ArrowRight" ||
          ev.key === "Home" ||
          ev.key === "End"
        ) {
          updateMentionPopup(composerInput, mentionPopup);
          if (channelPopup) updateChannelPopup(composerInput, channelPopup);
        }
      },
      "bind-497308",
    );
    bindEvent(
      composerInput,
      "keydown",
      (ev) => {
        // Edit прошлого своего сообщения по стрелке вверх (Discord/Slack):
        // пустой композер + ArrowUp + не активен mention-popup и не идёт edit.
        if (
          ev.key === "ArrowUp" &&
          composerInput.value === "" &&
          !uiContext.state.editingMessageId &&
          (!uiContext.state.mentionAutocomplete || mentionPopup.hidden) &&
          (!uiContext.state.channelAutocomplete ||
            !channelPopup ||
            channelPopup.hidden)
        ) {
          if (tryEditLastOwnMessage()) {
            ev.preventDefault();
            return;
          }
        }
        // Wave 8: навигация по channel-попапу. Токены `@…` и `#…` взаимно
        // исключающие — активен максимум один попап.
        if (
          channelPopup &&
          uiContext.state.channelAutocomplete &&
          !channelPopup.hidden
        ) {
          const chMatches = filterChannelMatches(
            uiContext.state.channelAutocomplete.query,
          );
          if (chMatches.length > 0) {
            if (ev.key === "ArrowDown") {
              ev.preventDefault();
              uiContext.state.channelAutocomplete.selectIndex =
                (uiContext.state.channelAutocomplete.selectIndex + 1) %
                chMatches.length;
              renderChannelPopupContent(
                channelPopup,
                chMatches,
                uiContext.state.channelAutocomplete.selectIndex,
              );
              return;
            } else if (ev.key === "ArrowUp") {
              ev.preventDefault();
              uiContext.state.channelAutocomplete.selectIndex =
                (uiContext.state.channelAutocomplete.selectIndex -
                  1 +
                  chMatches.length) %
                chMatches.length;
              renderChannelPopupContent(
                channelPopup,
                chMatches,
                uiContext.state.channelAutocomplete.selectIndex,
              );
              return;
            } else if (ev.key === "Enter" || ev.key === "Tab") {
              ev.preventDefault();
              applyChannelPick(
                composerInput,
                channelPopup,
                chMatches[uiContext.state.channelAutocomplete.selectIndex].name,
              );
              return;
            } else if (ev.key === "Escape") {
              ev.preventDefault();
              hideChannelPopup(channelPopup);
              return;
            }
          }
        }
        if (!uiContext.state.mentionAutocomplete || mentionPopup.hidden) return;
        const matches = filterMentionMatches(
          uiContext.state.mentionAutocomplete.query,
        );
        if (matches.length === 0) return;
        if (ev.key === "ArrowDown") {
          ev.preventDefault();
          uiContext.state.mentionAutocomplete.selectIndex =
            (uiContext.state.mentionAutocomplete.selectIndex + 1) %
            matches.length;
          renderMentionPopupContent(
            mentionPopup,
            matches,
            uiContext.state.mentionAutocomplete.selectIndex,
          );
        } else if (ev.key === "ArrowUp") {
          ev.preventDefault();
          uiContext.state.mentionAutocomplete.selectIndex =
            (uiContext.state.mentionAutocomplete.selectIndex -
              1 +
              matches.length) %
            matches.length;
          renderMentionPopupContent(
            mentionPopup,
            matches,
            uiContext.state.mentionAutocomplete.selectIndex,
          );
        } else if (ev.key === "Enter" || ev.key === "Tab") {
          ev.preventDefault();
          applyMentionPick(
            composerInput,
            mentionPopup,
            matches[uiContext.state.mentionAutocomplete.selectIndex].username,
          );
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          hideMentionPopup(mentionPopup);
        }
      },
      "bind-497744",
    );
    bindEvent(
      composerInput,
      "blur",
      () => {
        // Микро-задержка чтобы клик по popup успел отработать раньше скрытия.
        setTimeout(() => {
          hideMentionPopup(mentionPopup);
          if (channelPopup) hideChannelPopup(channelPopup);
        }, 120);
      },
      "bind-500795",
    );
    bindEvent(
      mentionPopup,
      "mousedown",
      (ev) => {
        const target = (ev.target as HTMLElement).closest<HTMLElement>(
          "[data-mention-username]",
        );
        if (!target) return;
        ev.preventDefault();
        applyMentionPick(
          composerInput,
          mentionPopup,
          target.dataset.mentionUsername!,
        );
      },
      "bind-501069",
    );
    channelPopup
      ? bindEvent(
          channelPopup,
          "mousedown",
          (ev) => {
            const target = (ev.target as HTMLElement).closest<HTMLElement>(
              "[data-channel-pick]",
            );
            if (!target) return;
            ev.preventDefault();
            applyChannelPick(
              composerInput,
              channelPopup,
              target.dataset.channelPick!,
            );
          },
          "bind-501371",
        )
      : undefined;

    // G.1.c: Ctrl+V вставка вложений из буфера. Любые file-items в
    // clipboardData (картинка скриншота, скопированный файл из проводника) —
    // прогоняем через uploadFiles. Текстовая вставка — стандартное поведение
    // браузера, не трогаем (e.preventDefault не вызываем, если файлов нет).
    bindEvent(
      composerInput,
      "paste",
      (ev) => {
        const items = ev.clipboardData?.items;
        if (!items || items.length === 0) return;
        const files: File[] = [];
        for (const item of Array.from(items)) {
          if (item.kind !== "file") continue;
          const f = item.getAsFile();
          if (f) files.push(f);
        }
        if (files.length === 0) return;
        ev.preventDefault();
        void uploadFiles(files);
      },
      "bind-501968",
    );
  }

  uiContext.rootEl.querySelector<HTMLFormElement>("#send-form")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLFormElement>("#send-form"),
        "submit",
        async (e) => {
          e.preventDefault();
          const form = e.currentTarget as HTMLFormElement;
          const input =
            form.querySelector<HTMLInputElement>('input[name="body"]');
          if (!input || !uiContext.state.selectedChannelId) return;
          const body = input.value.trim();
          const attachmentIds = uiContext.state.pendingUploads.map((p) => p.id);
          if (!body && attachmentIds.length === 0) return;
          const channelIdSnapshot = uiContext.state.selectedChannelId;
          // Wave 2: slash-команды. /nick — действие без отправки сообщения,
          // остальные трансформируют тело перед POST.
          const slash = transformSlashCommand(body);
          if (slash.kind === "nick") {
            input.value = "";
            saveDraft(channelIdSnapshot, "");
            if (!slash.name) {
              setTransientStatus("Использование: /nick новое_имя");
              return;
            }
            try {
              await uiContext.httpClient.put("/api/v1/users/me", {
                displayName: slash.name,
              });
              if (uiContext.state.me)
                uiContext.state.me = {
                  ...uiContext.state.me,
                  displayName: slash.name,
                };
              setTransientStatus(`Имя изменено на «${slash.name}»`);
            } catch (err) {
              uiContext.state.status = describeError(err);
            }
            render();
            return;
          }
          const bodyToSend = slash.body;
          input.value = "";
          saveDraft(channelIdSnapshot, "");
          const pendingSnapshot = uiContext.state.pendingUploads;
          const replyingSnapshot = uiContext.state.replyingTo;
          uiContext.state.pendingUploads = [];
          uiContext.state.replyingTo = null;
          uiContext.state.windowStart = null;
          uiContext.state.stickToBottom = true; // отправил — едем вниз показать свой месседж
          render();
          try {
            const created = await uiContext.httpClient.post<Message>(
              `/api/v1/channels/${channelIdSnapshot}/messages`,
              {
                body: bodyToSend,
                clientMessageId: crypto.randomUUID(),
                attachmentIds,
                replyToMessageId: replyingSnapshot?.messageId ?? undefined,
              },
            );
            if (
              uiContext.state.selectedChannelId === channelIdSnapshot &&
              created &&
              created.id &&
              !uiContext.state.messages.some((m) => m.id === created.id)
            ) {
              uiContext.state.messages = [
                ...uiContext.state.messages,
                {
                  ...created,
                  reactions: created.reactions ?? {},
                  attachments: created.attachments ?? [],
                },
              ];
              render();
            }
          } catch (err) {
            // J.3(b): slow-mode 429 → сохраняем draft, ставим countdown.
            const slow = isSlowModeError(err);
            if (slow) {
              setSlowMode(channelIdSnapshot, slow.retry);
              setTransientStatus(`Медленный режим: подожди ${slow.retry}с`);
              input.value = body;
              saveDraft(channelIdSnapshot, body);
              uiContext.state.pendingUploads = pendingSnapshot;
              uiContext.state.replyingTo = replyingSnapshot;
              render();
              return;
            }
            // Body too long → предлагаем отправить тело как .txt-вложение.
            // Бэк отдаёт "body too long" сообщением (см. message/module.go).
            // Согласие = uploadFile(text) → повторный POST с пустым body и
            // тем же набором вложений + reply. Отказ — восстанавливаем форму.
            if (isBodyTooLongError(err) && body) {
              const accepted = await confirmDialog({
                title: "Сообщение слишком длинное",
                body: `Тело — ${body.length} символов. Отправить его как текстовый файл вложением?`,
                confirmLabel: "Отправить файл",
              });
              if (accepted) {
                uiContext.state.status = "Отправка как файл…";
                render();
                try {
                  const file = new File([body], "message.txt", {
                    type: "text/plain",
                  });
                  const uploaded =
                    await uiContext.httpClient.uploadFile<PendingUpload>(
                      "/api/v1/uploads",
                      file,
                    );
                  const allAttachments = [...attachmentIds, uploaded.id];
                  const created = await uiContext.httpClient.post<Message>(
                    `/api/v1/channels/${channelIdSnapshot}/messages`,
                    {
                      body: "",
                      clientMessageId: crypto.randomUUID(),
                      attachmentIds: allAttachments,
                      replyToMessageId:
                        replyingSnapshot?.messageId ?? undefined,
                    },
                  );
                  if (
                    uiContext.state.selectedChannelId === channelIdSnapshot &&
                    created &&
                    created.id &&
                    !uiContext.state.messages.some((m) => m.id === created.id)
                  ) {
                    uiContext.state.messages = [
                      ...uiContext.state.messages,
                      {
                        ...created,
                        reactions: created.reactions ?? {},
                        attachments: created.attachments ?? [],
                      },
                    ];
                  }
                  setTransientStatus("Отправлено как файл");
                  return;
                } catch (fileErr) {
                  uiContext.state.status = describeError(fileErr);
                  input.value = body;
                  saveDraft(channelIdSnapshot, body);
                  uiContext.state.pendingUploads = pendingSnapshot;
                  uiContext.state.replyingTo = replyingSnapshot;
                  render();
                  return;
                }
              }
            }
            uiContext.state.status = describeError(err);
            input.value = body;
            saveDraft(channelIdSnapshot, body);
            uiContext.state.pendingUploads = pendingSnapshot;
            uiContext.state.replyingTo = replyingSnapshot;
            render();
          }
        },
        "bind-502418",
      )
    : undefined;
}
