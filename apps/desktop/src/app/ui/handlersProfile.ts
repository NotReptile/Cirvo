import { bindEvent, delegate } from "../dom";
import { describeError } from "../errors";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type { Me, PendingUpload } from "../types";
import { setTransientStatus } from "./helpers";
import { attachProfileEditHandlers } from "./workspaceSettings";

export function attachProfileRegion(): void {
  delegate<HTMLElement, "click">(
    uiContext.rootEl,
    "[data-modal-close]",
    "click",
    (e, el) => {
      if (e.target !== el && e.currentTarget !== e.target) return;
      uiContext.state.modal = null;
      render();
    },
    "delegate-439736",
  );

  attachProfileEditHandlers();

  // G.10: кнопка «карандаш» поверх аватара триггерит hidden file-input.
  uiContext.rootEl.querySelector<HTMLButtonElement>("#profile-avatar-upload")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#profile-avatar-upload",
        ),
        "click",
        () => {
          uiContext.rootEl
            .querySelector<HTMLInputElement>("#profile-avatar-input")
            ?.click();
        },
        "bind-439587",
      )
    : undefined;

  // H.1: загрузка аватара. Двухступенчато: (1) POST /uploads c image-файлом
  // через существующий attachment-pipeline → получаем mediaId; (2) PUT
  // /users/me/avatar c этим mediaId → бэк ставит users.avatar_media_id и
  // возвращает обновлённую meView. Делаем поэтапно а не одним multipart'ом,
  // чтобы переиспользовать уже работающую загрузку файлов (квоты, ACL,
  // MinIO-pipeline).
  uiContext.rootEl.querySelector<HTMLInputElement>("#profile-avatar-input")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>(
          "#profile-avatar-input",
        ),
        "change",
        async (e) => {
          const input = e.currentTarget as HTMLInputElement;
          const file = input.files?.[0];
          if (!file) return;
          if (!file.type.startsWith("image/")) {
            uiContext.state.status = "Аватар должен быть картинкой";
            render();
            return;
          }
          try {
            uiContext.state.status = "Загрузка аватара…";
            render();
            const uploaded =
              await uiContext.httpClient.uploadFile<PendingUpload>(
                "/api/v1/uploads",
                file,
              );
            const updated = await uiContext.httpClient.put<
              Me & { updatedAt: string }
            >("/api/v1/users/me/avatar", { mediaId: uploaded.id });
            if (uiContext.state.me) {
              uiContext.state.me = {
                ...uiContext.state.me,
                avatarMediaId: updated.avatarMediaId,
                displayName:
                  updated.displayName ?? uiContext.state.me.displayName,
              };
            }
            setTransientStatus("Аватар обновлён");
          } catch (err) {
            uiContext.state.status = describeError(err);
            render();
          } finally {
            input.value = "";
          }
        },
        "bind-440169",
      )
    : undefined;

  uiContext.rootEl.querySelector<HTMLButtonElement>("#profile-avatar-remove")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#profile-avatar-remove",
        ),
        "click",
        async (e) => {
          e.preventDefault();
          try {
            const updated = await uiContext.httpClient.del<
              Me & { updatedAt: string }
            >("/api/v1/users/me/avatar");
            if (uiContext.state.me) {
              uiContext.state.me = {
                ...uiContext.state.me,
                avatarMediaId: undefined,
                displayName:
                  updated.displayName ?? uiContext.state.me.displayName,
              };
            }
            setTransientStatus("Аватар удалён");
          } catch (err) {
            uiContext.state.status = describeError(err);
            render();
          }
        },
        "bind-441207",
      )
    : undefined;
}
