import { bindEvent, delegate } from "../dom";
import { describeError } from "../errors";
import { t } from "../i18n";
import { icon } from "../icons";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type { Channel } from "../types";
import { escapeHtml } from "../util/html";
import { selectChannel } from "./loaders";

export function renderCreateChannelModal(): string {
  const cc = uiContext.state.createChannel;
  const ws = uiContext.state.workspaces.find((w) => w.id === cc.workspaceId);
  if (!ws) return "";
  const kindLabel =
    cc.kind === "voice"
      ? "голосовой"
      : cc.kind === "forum"
        ? "форум"
        : "текстовый";
  const rolesBlock = !cc.isPrivate
    ? `<div class="modal-hint">Канал виден всем участникам воркспейса.</div>`
    : cc.rolesLoading
      ? `<div class="modal-hint">Загрузка ролей…</div>`
      : cc.roles.length === 0
        ? `<div class="modal-hint">Нет ролей в воркспейсе.</div>`
        : `
          <div class="cc-roles-label">Выбери роли, которые увидят канал</div>
          <ul class="cc-roles-list">
            ${cc.roles
              .map((r) => {
                // owner-роль всегда видит — checkbox disabled+checked
                const isOwner = r.code === "owner";
                const checked = isOwner || cc.selectedRoles.has(r.id);
                const colorDot = r.color
                  ? `<span class="cc-role-dot" style="background:${escapeHtml(r.color)}"></span>`
                  : `<span class="cc-role-dot cc-role-dot-empty"></span>`;
                return `
                <li class="cc-role-row">
                  <label>
                    <input type="checkbox" data-cc-role="${escapeHtml(r.id)}"
                           ${checked ? "checked" : ""} ${isOwner ? "disabled" : ""} />
                    ${colorDot}
                    <span class="cc-role-name">${escapeHtml(r.name)}</span>
                    ${isOwner ? `<span class="cc-role-pill">всегда</span>` : ""}
                  </label>
                </li>
              `;
              })
              .join("")}
          </ul>
        `;
  const errBlock = cc.error
    ? `<div class="modal-error">${escapeHtml(cc.error)}</div>`
    : "";
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal cc-modal" role="dialog">
        <div class="modal-header">
          <h3>Создать ${kindLabel} канал · ${escapeHtml(ws.name)}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="modal-body">
          <div class="cc-field">
            <span class="cc-field-label">Тип канала</span>
            <div class="settings-radio-group">
              <label class="settings-radio">
                <input type="radio" name="cc-kind" value="text" ${cc.kind === "text" ? "checked" : ""} />
                <span>${icon("channel-text", { size: 14 })} Текстовый</span>
              </label>
              <label class="settings-radio">
                <input type="radio" name="cc-kind" value="voice" ${cc.kind === "voice" ? "checked" : ""} />
                <span>${icon("channel-voice", { size: 14 })} Голосовой</span>
              </label>
              <label class="settings-radio">
                <input type="radio" name="cc-kind" value="forum" ${cc.kind === "forum" ? "checked" : ""} />
                <span>${icon("channel-forum", { size: 14 })} Форум</span>
              </label>
            </div>
          </div>
          <label class="cc-field">
            <span class="cc-field-label">Название</span>
            <input id="create-channel-name" type="text" autocomplete="off"
                   maxlength="64" placeholder="новый-канал" value="${escapeHtml(cc.name)}" />
          </label>
          ${
            cc.kind === "forum"
              ? `<div class="modal-hint">Форум — доска постов: участники создают темы и обсуждают их в тредах. Приватные форумы пока не поддерживаются.</div>`
              : `<label class="cc-field cc-field-toggle">
            <input id="create-channel-private" type="checkbox" ${cc.isPrivate ? "checked" : ""} />
            <span class="cc-field-toggle-body">
              <span class="cc-field-label">🔒 Приватный канал</span>
              <span class="cc-field-hint">Видят только выбранные роли + админы. Можно сменить позже в настройках канала.</span>
            </span>
          </label>
          <div class="cc-roles">${rolesBlock}</div>`
          }
          ${errBlock}
        </div>
        <div class="modal-footer">
          <button class="ghost" data-modal-close>Отмена</button>
          <button id="create-channel-submit" class="primary" ${cc.saving ? "disabled" : ""}>
            ${cc.saving ? "Создание…" : "Создать"}
          </button>
        </div>
      </div>
    </div>
  `;
}

export function attachCreateChannelHandlers(): void {
  if (uiContext.state.modal !== "createChannel") return;
  const nameInput = uiContext.rootEl.querySelector<HTMLInputElement>(
    "#create-channel-name",
  );
  nameInput
    ? bindEvent(
        nameInput,
        "input",
        () => {
          uiContext.state.createChannel.name = nameInput.value;
          // не зовём render() — иначе фокус слетит. error чистим при наборе.
          if (uiContext.state.createChannel.error) {
            uiContext.state.createChannel.error = null;
            // лёгкий update DOM-узла без render'а
            const err =
              uiContext.rootEl.querySelector<HTMLElement>(".modal-error");
            if (err) err.remove();
          }
        },
        "bind-291897",
      )
    : undefined;

  nameInput
    ? bindEvent(
        nameInput,
        "keydown",
        (e) => {
          if (
            e.key !== "Enter" ||
            e.isComposing ||
            uiContext.state.createChannel.saving
          )
            return;
          e.preventDefault();
          void submitCreateChannel();
        },
        "bind-292297",
      )
    : undefined;

  const privateToggle = uiContext.rootEl.querySelector<HTMLInputElement>(
    "#create-channel-private",
  );
  privateToggle
    ? bindEvent(
        privateToggle,
        "change",
        () => {
          uiContext.state.createChannel.isPrivate = privateToggle.checked;
          render();
        },
        "bind-292583",
      )
    : undefined;

  // J.5: переключатель типа канала. Перерисовка нужна всегда: от типа зависит
  // заголовок окна («Создать голосовой канал»), а для forum ещё и блок
  // приватности (Wave 9: приватные форумы не поддерживаются).
  delegate<HTMLInputElement, "change">(
    uiContext.rootEl,
    'input[name="cc-kind"]',
    "change",
    (_event, r) => {
      if (!r.checked) return;
      const prev = uiContext.state.createChannel.kind;
      uiContext.state.createChannel.kind = r.value as
        "text" | "voice" | "forum";
      if (r.value === "forum") {
        uiContext.state.createChannel.isPrivate = false;
        uiContext.state.createChannel.selectedRoles = new Set();
      }
      if (prev !== uiContext.state.createChannel.kind) render();
    },
    "delegate-292965",
  );

  delegate<HTMLInputElement, "change">(
    uiContext.rootEl,
    "[data-cc-role]",
    "change",
    (_event, cb) => {
      const id = cb.dataset.ccRole;
      if (!id) return;
      const next = new Set(uiContext.state.createChannel.selectedRoles);
      if (cb.checked) next.add(id);
      else next.delete(id);
      uiContext.state.createChannel.selectedRoles = next;
    },
    "delegate-293452",
  );

  uiContext.rootEl.querySelector<HTMLButtonElement>("#create-channel-submit")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#create-channel-submit",
        ),
        "click",
        () => {
          void submitCreateChannel();
        },
        "bind-293756",
      )
    : undefined;
}

export async function submitCreateChannel(): Promise<void> {
  const cc = uiContext.state.createChannel;
  if (!cc.workspaceId) return;
  const name = cc.name.trim();
  if (!name) {
    cc.error = "Введи название канала";
    render();
    return;
  }
  cc.saving = true;
  cc.error = null;
  render();
  try {
    const ch = await uiContext.httpClient.post<Channel>(
      `/api/v1/workspaces/${cc.workspaceId}/channels`,
      {
        kind: cc.kind,
        name,
        isPrivate: cc.isPrivate,
        categoryId: cc.categoryId ?? undefined,
      },
    );
    // Для приватного канала с выбранными ролями — выдаём channel.view
    // overrides отдельным запросом. owner всегда видит (короткое замыкание
    // в backend permission-резолвере), поэтому его не включаем.
    if (cc.isPrivate && cc.selectedRoles.size > 0) {
      const overrides = cc.roles
        .filter((r) => cc.selectedRoles.has(r.id) && r.code !== "owner")
        .map((r) => ({
          roleCode: r.code,
          granted: ["channel.view"],
          denied: [],
        }));
      if (overrides.length > 0) {
        try {
          await uiContext.httpClient.put(
            `/api/v1/channels/${ch.id}/permissions`,
            { overrides },
          );
        } catch (err) {
          // Канал уже создан — не валим целиком, просто сообщим в status.
          uiContext.state.status = `Канал создан, но не удалось выдать доступ: ${describeError(err)}`;
        }
      }
    }
    // realtime channel.created может прилететь до того, как POST-ответ
    // вернулся, и уже вставить канал в state — поэтому здесь дедуп.
    if (!uiContext.state.channels.some((c) => c.id === ch.id)) {
      uiContext.state.channels = [...uiContext.state.channels, ch];
    }
    uiContext.state.modal = null;
    cc.saving = false;
    await selectChannel(ch.id);
  } catch (err) {
    cc.saving = false;
    cc.error = describeError(err);
    render();
  }
}

// Wave 9: модалка «Новый пост» форума. Двухшаговый submit: POST
// /forum/posts {title} создаёт тред-канал, затем первое сообщение идёт
// обычным POST /channels/{threadId}/messages (переиспользует mentions/
// notifications/realtime). Если второй шаг упал — пост уже существует,
// открываем его: юзер допишет руками, ничего не теряется.
export function renderCreateForumPostModal(): string {
  const fp = uiContext.state.createForumPost;
  const ch = uiContext.state.channels.find((c) => c.id === fp.channelId);
  if (!ch) return "";
  const errBlock = fp.error
    ? `<div class="modal-error">${escapeHtml(fp.error)}</div>`
    : "";
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal cc-modal forum-post-modal" role="dialog">
        <div class="modal-header">
          <h3>${t("forum.newPost")} · ${escapeHtml(ch.name)}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="modal-body">
          <label class="cc-field">
            <span class="cc-field-label">${t("forum.post.title")}</span>
            <input id="forum-post-title" type="text" autocomplete="off"
                   maxlength="96" placeholder="${t("forum.post.title.ph")}" value="${escapeHtml(fp.title)}" />
          </label>
          <label class="cc-field">
            <span class="cc-field-label">${t("forum.post.body")}</span>
            <textarea id="forum-post-body" rows="5" maxlength="4000"
                      placeholder="${t("forum.post.body.ph")}">${escapeHtml(fp.body)}</textarea>
          </label>
          ${errBlock}
        </div>
        <div class="modal-footer">
          <button class="ghost" data-modal-close>${t("common.cancel")}</button>
          <button id="forum-post-submit" class="primary" ${fp.saving ? "disabled" : ""}>
            ${fp.saving ? t("forum.post.saving") : t("forum.post.submit")}
          </button>
        </div>
      </div>
    </div>
  `;
}

export function attachCreateForumPostHandlers(): void {
  if (uiContext.state.modal !== "createForumPost") return;
  const titleInput =
    uiContext.rootEl.querySelector<HTMLInputElement>("#forum-post-title");
  titleInput
    ? bindEvent(
        titleInput,
        "input",
        () => {
          uiContext.state.createForumPost.title = titleInput.value;
        },
        "bind-297761",
      )
    : undefined;
  const bodyInput =
    uiContext.rootEl.querySelector<HTMLTextAreaElement>("#forum-post-body");
  bodyInput
    ? bindEvent(
        bodyInput,
        "input",
        () => {
          uiContext.state.createForumPost.body = bodyInput.value;
        },
        "bind-297950",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#forum-post-submit")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#forum-post-submit"),
        "click",
        () => {
          void submitCreateForumPost();
        },
        "bind-298053",
      )
    : undefined;
}

export async function submitCreateForumPost(): Promise<void> {
  const fp = uiContext.state.createForumPost;
  if (!fp.channelId || fp.saving) return;
  const title = fp.title.trim();
  const body = fp.body.trim();
  if (!title) {
    fp.error = t("forum.post.err.title");
    render();
    return;
  }
  if (!body) {
    fp.error = t("forum.post.err.body");
    render();
    return;
  }
  fp.saving = true;
  fp.error = null;
  render();
  try {
    const thread = await uiContext.httpClient.post<Channel>(
      `/api/v1/channels/${fp.channelId}/forum/posts`,
      { title },
    );
    if (!uiContext.state.channels.some((c) => c.id === thread.id)) {
      uiContext.state.channels = [...uiContext.state.channels, thread];
    }
    try {
      await uiContext.httpClient.post(
        `/api/v1/channels/${thread.id}/messages`,
        { body },
      );
    } catch (err) {
      uiContext.state.status = describeError(err);
    }
    uiContext.state.modal = null;
    fp.saving = false;
    await selectChannel(thread.id);
  } catch (err) {
    fp.saving = false;
    fp.error = describeError(err);
    render();
  }
}
