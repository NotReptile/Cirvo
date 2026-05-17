import type { ApiError, HttpClient } from "../network/httpClient";
import type { RealtimeClient, RealtimeEvent } from "../realtime/realtimeClient";

interface Me {
  id: string;
  email: string;
  username: string;
  displayName?: string;
}

interface Workspace {
  id: string;
  slug: string;
  name: string;
  ownerId: string;
  role?: string;
  createdAt: string;
}

interface Channel {
  id: string;
  workspaceId: string;
  kind: string;
  name: string;
  topic?: string;
  isPrivate: boolean;
  position: number;
  createdAt: string;
}

interface Message {
  id: string;
  channelId: string;
  authorId: string;
  body: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  clientMessageId?: string;
}

interface Invite {
  id: string;
  workspaceId: string;
  code: string;
  maxUses: number;
  usedCount: number;
  expiresAt?: string;
  revokedAt?: string;
  createdAt: string;
  createdBy?: string;
}

interface AppState {
  me: Me | null;
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  channels: Channel[];
  selectedChannelId: string | null;
  messages: Message[];
  authError: string | null;
  status: string;
  editingMessageId: string | null;
  invitesOpen: boolean;
  invites: Invite[];
  invitesLoading: boolean;
}

const state: AppState = {
  me: null,
  workspaces: [],
  selectedWorkspaceId: null,
  channels: [],
  selectedChannelId: null,
  messages: [],
  authError: null,
  status: "",
  editingMessageId: null,
  invitesOpen: false,
  invites: [],
  invitesLoading: false
};

let rootEl: HTMLElement;
let httpClient: HttpClient;
let realtimeClient: RealtimeClient;

export function renderApp(container: HTMLElement, http: HttpClient, realtime: RealtimeClient): void {
  rootEl = container;
  httpClient = http;
  realtimeClient = realtime;

  realtime.subscribe(handleRealtimeEvent);
  http.onTokensChanged((tokens) => {
    if (!tokens) {
      Object.assign(state, {
        me: null,
        workspaces: [],
        selectedWorkspaceId: null,
        channels: [],
        selectedChannelId: null,
        messages: [],
        editingMessageId: null,
        invitesOpen: false,
        invites: []
      });
      render();
    }
  });

  if (http.getTokens()) {
    void bootstrapSession();
  } else {
    render();
  }
}

async function bootstrapSession(): Promise<void> {
  try {
    state.status = "Загрузка профиля…";
    render();
    state.me = await httpClient.get<Me>("/api/v1/users/me");
    await loadWorkspaces();
    state.status = "";
    render();
  } catch (err) {
    state.status = "";
    await httpClient.logout();
    state.authError = describeError(err);
    render();
  }
}

async function loadWorkspaces(): Promise<void> {
  const data = await httpClient.get<{ items: Workspace[] }>("/api/v1/workspaces");
  state.workspaces = data.items ?? [];
  if (state.selectedWorkspaceId && !state.workspaces.some((w) => w.id === state.selectedWorkspaceId)) {
    state.selectedWorkspaceId = null;
  }
  if (!state.selectedWorkspaceId && state.workspaces.length > 0) {
    await selectWorkspace(state.workspaces[0].id);
  }
}

async function selectWorkspace(id: string): Promise<void> {
  state.selectedWorkspaceId = id;
  state.selectedChannelId = null;
  state.channels = [];
  state.messages = [];
  state.invitesOpen = false;
  state.invites = [];
  render();
  const data = await httpClient.get<{ items: Channel[] }>(`/api/v1/workspaces/${id}/channels`);
  state.channels = data.items ?? [];
  if (state.channels.length > 0) {
    await selectChannel(state.channels[0].id);
  } else {
    render();
  }
}

async function selectChannel(id: string): Promise<void> {
  state.selectedChannelId = id;
  state.messages = [];
  state.editingMessageId = null;
  render();
  const data = await httpClient.get<{ items: Message[] }>(`/api/v1/channels/${id}/messages?limit=50`);
  state.messages = (data.items ?? []).slice().reverse();
  render();
}

async function loadInvites(): Promise<void> {
  if (!state.selectedWorkspaceId) return;
  state.invitesLoading = true;
  render();
  try {
    const data = await httpClient.get<{ items: Invite[] }>(`/api/v1/workspaces/${state.selectedWorkspaceId}/invites`);
    state.invites = data.items ?? [];
  } catch (err) {
    state.status = describeError(err);
  } finally {
    state.invitesLoading = false;
    render();
  }
}

function handleRealtimeEvent(event: RealtimeEvent): void {
  if (event.channelId !== state.selectedChannelId) return;
  switch (event.event) {
    case "message.created": {
      const msg = event.payload as Message;
      if (state.messages.some((m) => m.id === msg.id)) return;
      state.messages = [...state.messages, msg];
      render();
      break;
    }
    case "message.deleted": {
      const payload = event.payload as { id: string };
      state.messages = state.messages.filter((m) => m.id !== payload.id);
      render();
      break;
    }
    case "message.updated": {
      const msg = event.payload as Message;
      state.messages = state.messages.map((m) => (m.id === msg.id ? msg : m));
      render();
      break;
    }
  }
}

function render(): void {
  if (!httpClient.getTokens()) {
    renderAuth();
    return;
  }
  renderShell();
}

function renderAuth(): void {
  rootEl.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <h1>RuCord</h1>
        <div class="auth-tabs">
          <button data-tab="login" class="auth-tab active">Войти</button>
          <button data-tab="register" class="auth-tab">Регистрация</button>
        </div>
        <form id="auth-form" class="auth-form" data-mode="login">
          <label data-only="login">Логин или email
            <input name="login" autocomplete="username" />
          </label>
          <label data-only="register">Email
            <input name="email" type="email" autocomplete="email" />
          </label>
          <label data-only="register">Имя пользователя
            <input name="username" pattern="[a-z0-9_]{3,32}" />
          </label>
          <label data-only="register">Отображаемое имя
            <input name="displayName" />
          </label>
          <label>Пароль
            <input name="password" type="password" autocomplete="current-password" required minlength="8" />
          </label>
          ${state.authError ? `<div class="auth-error">${escapeHtml(state.authError)}</div>` : ""}
          <button type="submit" class="primary">Продолжить</button>
        </form>
      </div>
    </div>
  `;
  const form = rootEl.querySelector<HTMLFormElement>("#auth-form");
  const tabs = rootEl.querySelectorAll<HTMLButtonElement>(".auth-tab");
  if (!form) return;
  updateAuthVisibility(form, "login");
  tabs.forEach((tab) => {
    tab.addEventListener("click", (e) => {
      e.preventDefault();
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      updateAuthVisibility(form, tab.dataset.tab === "register" ? "register" : "login");
    });
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const mode = form.dataset.mode === "register" ? "register" : "login";
    state.authError = null;
    try {
      if (mode === "register") {
        await httpClient.register({
          email: String(data.get("email") ?? "").trim(),
          username: String(data.get("username") ?? "").trim(),
          password: String(data.get("password") ?? ""),
          displayName: String(data.get("displayName") ?? "").trim() || undefined
        });
      } else {
        await httpClient.login(String(data.get("login") ?? "").trim(), String(data.get("password") ?? ""));
      }
      await bootstrapSession();
    } catch (err) {
      state.authError = describeError(err);
      render();
    }
  });
}

function updateAuthVisibility(form: HTMLFormElement, mode: "login" | "register"): void {
  form.dataset.mode = mode;
  form.querySelectorAll<HTMLElement>("[data-only]").forEach((el) => {
    const onlyFor = el.dataset.only;
    const isVisible = onlyFor === mode;
    el.style.display = isVisible ? "" : "none";
    el.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
      input.disabled = !isVisible;
      if (input.name === "email" || input.name === "username" || input.name === "login") {
        input.required = isVisible;
      }
    });
  });
}

function renderShell(): void {
  const me = state.me;
  const selectedChannel = state.channels.find((c) => c.id === state.selectedChannelId);
  const selectedWorkspace = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  const canModerate = selectedWorkspace && ["owner", "admin", "moderator"].includes(selectedWorkspace.role ?? "");

  rootEl.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="sidebar-header">
          <div class="user">
            <div class="avatar">${(me?.displayName || me?.username || "?").charAt(0).toUpperCase()}</div>
            <div>
              <div class="user-name">${escapeHtml(me?.displayName || me?.username || "—")}</div>
              <div class="user-sub">@${escapeHtml(me?.username || "")}</div>
            </div>
          </div>
          <button id="logout-btn" class="ghost" title="Выйти">⎋</button>
        </div>
        <div class="section-title">Воркспейсы</div>
        <ul class="workspace-list">
          ${state.workspaces
            .map(
              (ws) => `
            <li class="${ws.id === state.selectedWorkspaceId ? "active" : ""}" data-ws="${ws.id}">
              <span class="ws-badge">${escapeHtml(ws.name.charAt(0).toUpperCase())}</span>
              <span>${escapeHtml(ws.name)}</span>
            </li>
          `
            )
            .join("")}
        </ul>
        <form id="create-workspace" class="inline-form">
          <input name="name" placeholder="Имя нового воркспейса" required />
          <input name="slug" placeholder="slug" pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]" required />
          <button type="submit">+</button>
        </form>
        <form id="accept-invite" class="inline-form">
          <input name="code" placeholder="Код инвайта" required />
          <button type="submit" title="Принять">↵</button>
        </form>
        ${state.selectedWorkspaceId ? renderChannelsBlock(Boolean(canModerate)) : ""}
        ${state.selectedWorkspaceId && canModerate ? renderInvitesBlock() : ""}
      </aside>
      <main class="content">
        ${selectedChannel ? renderChannelView(selectedChannel) : renderEmpty()}
      </main>
      ${state.status ? `<div class="status-bar">${escapeHtml(state.status)}</div>` : ""}
    </div>
  `;
  attachShellHandlers();
}

function renderEmpty(): string {
  if (state.workspaces.length === 0) {
    return `
      <div class="empty">
        <p>У вас пока нет воркспейсов.</p>
        <p>Создайте новый слева или присоединитесь по коду инвайта.</p>
      </div>
    `;
  }
  return `<div class="empty"><p>Выберите канал</p></div>`;
}

function renderChannelsBlock(_canModerate: boolean): string {
  return `
    <div class="section-title">Каналы</div>
    <ul class="channel-list">
      ${state.channels
        .map(
          (ch) => `
        <li class="${ch.id === state.selectedChannelId ? "active" : ""}" data-ch="${ch.id}">
          <span class="channel-prefix">${ch.isPrivate ? "🔒" : "#"}</span>
          <span>${escapeHtml(ch.name)}</span>
        </li>
      `
        )
        .join("")}
    </ul>
    <form id="create-channel" class="inline-form">
      <input name="name" placeholder="новый-канал" required />
      <button type="submit">+</button>
    </form>
  `;
}

function renderInvitesBlock(): string {
  const list = state.invitesOpen
    ? state.invitesLoading
      ? `<div class="invites-empty">Загрузка…</div>`
      : state.invites.length === 0
        ? `<div class="invites-empty">Активных инвайтов нет</div>`
        : `<ul class="invite-list">
            ${state.invites
              .filter((i) => !i.revokedAt)
              .map(
                (i) => `
              <li data-invite="${i.id}">
                <code class="invite-code">${escapeHtml(i.code)}</code>
                <span class="invite-meta">${i.usedCount}/${i.maxUses === 0 ? "∞" : i.maxUses}</span>
                <button class="ghost invite-copy" data-code="${escapeHtml(i.code)}" title="Копировать код">⧉</button>
                <button class="ghost invite-revoke" data-invite="${i.id}" title="Отозвать">✕</button>
              </li>
            `
              )
              .join("")}
          </ul>`
    : "";
  return `
    <div class="section-title invites-title">
      <span>Инвайты</span>
      <button id="toggle-invites" class="ghost" title="${state.invitesOpen ? "Скрыть" : "Показать"}">${state.invitesOpen ? "▾" : "▸"}</button>
    </div>
    ${
      state.invitesOpen
        ? `<form id="create-invite" class="inline-form">
            <input name="maxUses" type="number" min="0" max="10000" placeholder="макс. использований (0 = ∞)" />
            <button type="submit">Создать</button>
          </form>${list}`
        : ""
    }
  `;
}

function renderChannelView(channel: Channel): string {
  return `
    <header class="channel-header">
      <div>
        <h2>${channel.isPrivate ? "🔒" : "#"} ${escapeHtml(channel.name)}</h2>
        ${channel.topic ? `<div class="topic">${escapeHtml(channel.topic)}</div>` : ""}
      </div>
    </header>
    <div id="message-list" class="message-list">
      ${state.messages.map((m) => renderMessage(m)).join("")}
    </div>
    <form id="send-form" class="send-form">
      <input
        name="body"
        autocomplete="off"
        placeholder="${channel.kind === "text" ? `Сообщение в #${channel.name}` : "Этот канал не принимает сообщения"}"
        ${channel.kind === "text" ? "" : "disabled"}
      />
      <button type="submit" ${channel.kind === "text" ? "" : "disabled"}>↑</button>
    </form>
  `;
}

function renderMessage(m: Message): string {
  const isMine = state.me?.id === m.authorId;
  const selectedWorkspace = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  const canModerate = selectedWorkspace && ["owner", "admin", "moderator"].includes(selectedWorkspace.role ?? "");
  const canDelete = isMine || canModerate;
  const isEditing = state.editingMessageId === m.id;

  if (isEditing) {
    return `
      <div class="message" data-id="${m.id}">
        <div class="message-meta">
          <span class="author">${shortId(m.authorId)}</span>
          <span class="timestamp">${formatTime(m.createdAt)}</span>
        </div>
        <form class="edit-form" data-edit-id="${m.id}">
          <input name="body" value="${escapeHtml(m.body)}" autofocus />
          <button type="submit" class="primary">Сохранить</button>
          <button type="button" class="ghost cancel-edit" data-id="${m.id}">Отмена</button>
        </form>
      </div>
    `;
  }

  return `
    <div class="message" data-id="${m.id}">
      <div class="message-meta">
        <span class="author">${shortId(m.authorId)}${isMine ? " · вы" : ""}</span>
        <span class="timestamp">${formatTime(m.createdAt)}${m.editedAt ? " · изменено" : ""}</span>
        <span class="message-actions">
          ${isMine ? `<button class="ghost action-edit" data-id="${m.id}" title="Редактировать">✎</button>` : ""}
          ${canDelete ? `<button class="ghost action-delete" data-id="${m.id}" title="Удалить">🗑</button>` : ""}
        </span>
      </div>
      <div class="message-body">${escapeHtml(m.body)}</div>
    </div>
  `;
}

function attachShellHandlers(): void {
  rootEl.querySelector<HTMLButtonElement>("#logout-btn")?.addEventListener("click", () => {
    void httpClient.logout();
  });

  rootEl.querySelectorAll<HTMLLIElement>("[data-ws]").forEach((li) => {
    li.addEventListener("click", () => {
      const id = li.dataset.ws;
      if (id && id !== state.selectedWorkspaceId) void selectWorkspace(id);
    });
  });

  rootEl.querySelectorAll<HTMLLIElement>("[data-ch]").forEach((li) => {
    li.addEventListener("click", () => {
      const id = li.dataset.ch;
      if (id && id !== state.selectedChannelId) void selectChannel(id);
    });
  });

  rootEl.querySelector<HTMLFormElement>("#create-workspace")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    try {
      const ws = await httpClient.post<Workspace>("/api/v1/workspaces", {
        name: String(data.get("name") ?? "").trim(),
        slug: String(data.get("slug") ?? "").trim()
      });
      state.workspaces = [...state.workspaces, ws];
      await selectWorkspace(ws.id);
    } catch (err) {
      state.status = describeError(err);
      render();
    }
  });

  rootEl.querySelector<HTMLFormElement>("#accept-invite")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const code = String(data.get("code") ?? "").trim();
    if (!code) return;
    try {
      const res = await httpClient.post<{ workspaceId: string; role: string }>(
        `/api/v1/invites/${encodeURIComponent(code)}/accept`
      );
      form.reset();
      await loadWorkspaces();
      await selectWorkspace(res.workspaceId);
      state.status = "Вы вступили в воркспейс";
    } catch (err) {
      state.status = describeError(err);
      render();
    }
  });

  rootEl.querySelector<HTMLFormElement>("#create-channel")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.selectedWorkspaceId) return;
    const form = e.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    try {
      const ch = await httpClient.post<Channel>(`/api/v1/workspaces/${state.selectedWorkspaceId}/channels`, {
        kind: "text",
        name: String(data.get("name") ?? "").trim()
      });
      state.channels = [...state.channels, ch];
      form.reset();
      await selectChannel(ch.id);
    } catch (err) {
      state.status = describeError(err);
      render();
    }
  });

  rootEl.querySelector<HTMLButtonElement>("#toggle-invites")?.addEventListener("click", async (e) => {
    e.preventDefault();
    state.invitesOpen = !state.invitesOpen;
    if (state.invitesOpen) {
      await loadInvites();
    } else {
      render();
    }
  });

  rootEl.querySelector<HTMLFormElement>("#create-invite")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.selectedWorkspaceId) return;
    const form = e.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const maxUses = Number(data.get("maxUses") || 0);
    try {
      const inv = await httpClient.post<Invite>(`/api/v1/workspaces/${state.selectedWorkspaceId}/invites`, {
        maxUses
      });
      state.invites = [inv, ...state.invites];
      form.reset();
      render();
    } catch (err) {
      state.status = describeError(err);
      render();
    }
  });

  rootEl.querySelectorAll<HTMLButtonElement>(".invite-copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const code = btn.dataset.code ?? "";
      try {
        await navigator.clipboard.writeText(code);
        state.status = "Код скопирован";
        render();
      } catch {
        state.status = code;
        render();
      }
    });
  });

  rootEl.querySelectorAll<HTMLButtonElement>(".invite-revoke").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.invite;
      if (!id) return;
      try {
        await httpClient.del(`/api/v1/invites/${id}`);
        state.invites = state.invites.filter((i) => i.id !== id);
        render();
      } catch (err) {
        state.status = describeError(err);
        render();
      }
    });
  });

  rootEl.querySelectorAll<HTMLButtonElement>(".action-edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.editingMessageId = btn.dataset.id ?? null;
      render();
    });
  });

  rootEl.querySelectorAll<HTMLButtonElement>(".action-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      if (!id) return;
      if (!confirm("Удалить сообщение?")) return;
      try {
        await httpClient.del(`/api/v1/messages/${id}`);
      } catch (err) {
        state.status = describeError(err);
        render();
      }
    });
  });

  rootEl.querySelectorAll<HTMLButtonElement>(".cancel-edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.editingMessageId = null;
      render();
    });
  });

  rootEl.querySelectorAll<HTMLFormElement>(".edit-form").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = form.dataset.editId;
      if (!id) return;
      const input = form.querySelector<HTMLInputElement>('input[name="body"]');
      const body = input?.value.trim() ?? "";
      if (!body) return;
      try {
        await httpClient.patch(`/api/v1/messages/${id}`, { body });
        state.editingMessageId = null;
      } catch (err) {
        state.status = describeError(err);
        render();
      }
    });
  });

  rootEl.querySelector<HTMLFormElement>("#send-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const input = form.querySelector<HTMLInputElement>('input[name="body"]');
    if (!input || !state.selectedChannelId) return;
    const body = input.value.trim();
    if (!body) return;
    input.value = "";
    try {
      await httpClient.post(`/api/v1/channels/${state.selectedChannelId}/messages`, {
        body,
        clientMessageId: crypto.randomUUID()
      });
    } catch (err) {
      state.status = describeError(err);
      input.value = body;
      render();
    }
  });

  const list = rootEl.querySelector<HTMLDivElement>("#message-list");
  if (list) list.scrollTop = list.scrollHeight;
}

function describeError(err: unknown): string {
  const api = err as ApiError;
  if (api && typeof api === "object" && "code" in api && "message" in api) {
    return `${api.message} (${api.code})`;
  }
  if (err instanceof Error) return err.message;
  return "Неизвестная ошибка";
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function escapeHtml(value: string | undefined | null): string {
  if (value == null) return "";
  return String(value).replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}
