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
  clientMessageId?: string;
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
}

const state: AppState = {
  me: null,
  workspaces: [],
  selectedWorkspaceId: null,
  channels: [],
  selectedChannelId: null,
  messages: [],
  authError: null,
  status: ""
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
        messages: []
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
  if (!state.selectedWorkspaceId && state.workspaces.length > 0) {
    await selectWorkspace(state.workspaces[0].id);
  }
}

async function selectWorkspace(id: string): Promise<void> {
  state.selectedWorkspaceId = id;
  state.selectedChannelId = null;
  state.channels = [];
  state.messages = [];
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
  render();
  const data = await httpClient.get<{ items: Message[] }>(`/api/v1/channels/${id}/messages?limit=50`);
  state.messages = (data.items ?? []).slice().reverse();
  render();
}

function handleRealtimeEvent(event: RealtimeEvent): void {
  if (event.event === "message.created" && event.channelId === state.selectedChannelId) {
    const msg = event.payload as Message;
    if (state.messages.some((m) => m.id === msg.id)) return;
    state.messages = [...state.messages, msg];
    render();
  } else if (event.event === "message.deleted" && event.channelId === state.selectedChannelId) {
    const payload = event.payload as { id: string };
    state.messages = state.messages.filter((m) => m.id !== payload.id);
    render();
  } else if (event.event === "message.updated" && event.channelId === state.selectedChannelId) {
    const msg = event.payload as Message;
    state.messages = state.messages.map((m) => (m.id === msg.id ? msg : m));
    render();
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
          <label>Логин или email
            <input name="login" autocomplete="username" required />
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
      input.required = isVisible && (input.name === "email" || input.name === "username");
      input.disabled = !isVisible;
    });
  });
  const loginLabel = form.querySelector<HTMLElement>('label:has(input[name="login"])');
  if (loginLabel) loginLabel.style.display = mode === "login" ? "" : "none";
  const loginInput = form.querySelector<HTMLInputElement>('input[name="login"]');
  if (loginInput) loginInput.required = mode === "login";
}

function renderShell(): void {
  const me = state.me;
  const selectedChannel = state.channels.find((c) => c.id === state.selectedChannelId);
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
          <button id="logout-btn" class="ghost">Выйти</button>
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
          <input name="name" placeholder="Новый воркспейс" required />
          <input name="slug" placeholder="slug (a-z, 0-9, -)" pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]" required />
          <button type="submit">Создать</button>
        </form>
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
        ${state.selectedWorkspaceId
          ? `<form id="create-channel" class="inline-form">
              <input name="name" placeholder="новый-канал" required />
              <button type="submit">+</button>
            </form>`
          : ""}
      </aside>
      <main class="content">
        ${
          selectedChannel
            ? renderChannelView(selectedChannel)
            : `<div class="empty"><p>Выберите канал или создайте воркспейс</p></div>`
        }
      </main>
      ${state.status ? `<div class="status-bar">${escapeHtml(state.status)}</div>` : ""}
    </div>
  `;
  attachShellHandlers();
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
      ${state.messages
        .map(
          (m) => `
        <div class="message" data-id="${m.id}">
          <div class="message-meta">
            <span class="author">${shortId(m.authorId)}</span>
            <span class="timestamp">${formatTime(m.createdAt)}${m.editedAt ? " · изменено" : ""}</span>
          </div>
          <div class="message-body">${escapeHtml(m.body)}</div>
        </div>
      `
        )
        .join("")}
    </div>
    <form id="send-form" class="send-form" ${channel.kind === "text" ? "" : "data-disabled"}>
      <input
        name="body"
        autocomplete="off"
        placeholder="${channel.kind === "text" ? `Сообщение в #${channel.name}` : "Этот канал не принимает сообщения"}"
        ${channel.kind === "text" ? "" : "disabled"}
      />
      <button type="submit" ${channel.kind === "text" ? "" : "disabled"}>Отправить</button>
    </form>
  `;
}

function attachShellHandlers(): void {
  const logoutBtn = rootEl.querySelector<HTMLButtonElement>("#logout-btn");
  logoutBtn?.addEventListener("click", () => {
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

  const createWsForm = rootEl.querySelector<HTMLFormElement>("#create-workspace");
  createWsForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(createWsForm);
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

  const createChForm = rootEl.querySelector<HTMLFormElement>("#create-channel");
  createChForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.selectedWorkspaceId) return;
    const data = new FormData(createChForm);
    try {
      const ch = await httpClient.post<Channel>(`/api/v1/workspaces/${state.selectedWorkspaceId}/channels`, {
        kind: "text",
        name: String(data.get("name") ?? "").trim()
      });
      state.channels = [...state.channels, ch];
      await selectChannel(ch.id);
    } catch (err) {
      state.status = describeError(err);
      render();
    }
  });

  const sendForm = rootEl.querySelector<HTMLFormElement>("#send-form");
  sendForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = sendForm.querySelector<HTMLInputElement>('input[name="body"]');
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
