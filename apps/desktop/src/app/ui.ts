import type { CallManager, CallSnapshot } from "../call/callManager";
import type { VoiceChannelManager, VoiceSnapshot } from "../call/voiceChannelManager";
import type { ApiError, HttpClient } from "../network/httpClient";
import type { RealtimeClient, RealtimeEvent } from "../realtime/realtimeClient";
import { icon } from "./icons";

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

interface ReactionAgg {
  count: number;
  mine: boolean;
}

interface Attachment {
  id: string;
  contentType: string;
  sizeBytes: number;
  filename?: string;
  url: string;
}

interface PendingUpload {
  id: string;
  contentType: string;
  sizeBytes: number;
  filename?: string;
  url: string;
}

interface ReplySnippet {
  messageId: string;
  authorId: string;
  body: string;
  deleted?: boolean;
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
  reactions?: Record<string, ReactionAgg>;
  attachments?: Attachment[];
  replyTo?: ReplySnippet;
  mentions?: string[];
}

interface MentionAutocomplete {
  query: string;
  selectIndex: number;
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

interface Member {
  userId: string;
  username: string;
  displayName?: string;
  role: string;
  joinedAt: string;
}

interface AuditEntry {
  id: string;
  actorId?: string;
  action: string;
  targetType: string;
  targetId: string;
  workspaceId?: string;
  createdAt: string;
}

type ModalKind = "profile" | "members" | "audit" | null;

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
  modal: ModalKind;
  members: Member[];
  membersLoading: boolean;
  pickerForMessageId: string | null;
  auditEntries: AuditEntry[];
  auditLoading: boolean;
  pendingUploads: PendingUpload[];
  uploadInFlight: boolean;
  callSnapshot: CallSnapshot | null;
  voiceSnapshot: VoiceSnapshot | null;
  voicePeek: VoicePeek | null;
  replyingTo: ReplySnippet | null;
  mentionAutocomplete: MentionAutocomplete | null;
  // C.4: smart scroll + lazy pagination
  messagesCursor: string | null;       // следующий before= для подгрузки старых
  messagesHasMore: boolean;
  messagesLoadingOlder: boolean;
  stickToBottom: boolean;              // юзер у нижней границы → autoscroll на новые
  restoreScrollBottom: number | null;  // one-shot: после render() восстановить «расстояние до низа»
}

interface VoicePeekParticipant {
  userId: string;
  sessionId: string;
  username: string;
  displayName?: string;
  joinedAt: string;
}

interface VoicePeek {
  channelId: string;
  participants: VoicePeekParticipant[];
}

const QUICK_EMOJIS = ["👍", "❤️", "😄", "🎉", "🔥", "🤔", "👀", "🙏"];

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
  invitesLoading: false,
  modal: null,
  members: [],
  membersLoading: false,
  pickerForMessageId: null,
  auditEntries: [],
  auditLoading: false,
  pendingUploads: [],
  uploadInFlight: false,
  callSnapshot: null,
  voiceSnapshot: null,
  voicePeek: null,
  replyingTo: null,
  mentionAutocomplete: null,
  messagesCursor: null,
  messagesHasMore: false,
  messagesLoadingOlder: false,
  stickToBottom: true,
  restoreScrollBottom: null
};

const mediaBlobCache = new Map<string, string>();

let rootEl: HTMLElement;
let httpClient: HttpClient;
let realtimeClient: RealtimeClient;
let callMgr: CallManager;
let voiceMgr: VoiceChannelManager;
let callTimerInterval: ReturnType<typeof setInterval> | null = null;

export function renderApp(
  container: HTMLElement,
  http: HttpClient,
  realtime: RealtimeClient,
  callManager: CallManager,
  voiceManager: VoiceChannelManager
): void {
  rootEl = container;
  httpClient = http;
  realtimeClient = realtime;
  callMgr = callManager;
  voiceMgr = voiceManager;

  realtime.subscribe(handleRealtimeEvent);
  callManager.subscribe((snap) => {
    state.callSnapshot = snap.state === "idle" ? null : snap;
    render();
  });
  voiceManager.subscribe((snap) => {
    state.voiceSnapshot = snap.state === "idle" ? null : snap;
    render();
  });
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
        invites: [],
        modal: null,
        members: [],
        pickerForMessageId: null
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
  state.members = [];
  render();
  const data = await httpClient.get<{ items: Channel[] }>(`/api/v1/workspaces/${id}/channels`);
  state.channels = data.items ?? [];
  // Резолвинг authorId → имя в сообщениях. Не блокируем загрузку каналов.
  void loadMembers();
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
  state.pickerForMessageId = null;
  state.voicePeek = null;
  state.replyingTo = null;
  state.messagesCursor = null;
  state.messagesHasMore = false;
  state.messagesLoadingOlder = false;
  state.stickToBottom = true;
  state.restoreScrollBottom = null;
  render();
  const ch = state.channels.find((c) => c.id === id);
  if (ch?.kind === "voice") {
    try {
      const data = await httpClient.get<{ items: VoicePeekParticipant[] }>(
        `/api/v1/channels/${id}/voice/participants`
      );
      if (state.selectedChannelId === id) {
        state.voicePeek = { channelId: id, participants: data.items ?? [] };
        render();
      }
    } catch (err) {
      state.status = describeError(err);
      render();
    }
    return;
  }
  const data = await httpClient.get<{ items: Message[]; nextCursor?: string }>(
    `/api/v1/channels/${id}/messages?limit=50`
  );
  if (state.selectedChannelId !== id) return; // юзер уже сменил канал
  state.messages = (data.items ?? []).slice().reverse();
  state.messagesCursor = data.nextCursor || null;
  state.messagesHasMore = !!data.nextCursor;
  state.stickToBottom = true;
  render();
}

async function loadOlderMessages(channelId: string, list: HTMLDivElement): Promise<void> {
  if (state.messagesLoadingOlder || !state.messagesCursor) return;
  const cursor = state.messagesCursor;
  // Сохраняем расстояние от низа списка ДО prepend — после ре-рендера
  // выставим scrollTop так, чтобы видимая «нижняя граница» осталась той же.
  const savedBottomOffset = list.scrollHeight - list.scrollTop - list.clientHeight;
  state.messagesLoadingOlder = true;
  try {
    const data = await httpClient.get<{ items: Message[]; nextCursor?: string }>(
      `/api/v1/channels/${channelId}/messages?limit=50&before=${encodeURIComponent(cursor)}`
    );
    if (state.selectedChannelId !== channelId) return;
    const older = (data.items ?? []).slice().reverse();
    if (older.length === 0) {
      state.messagesHasMore = false;
      state.messagesCursor = null;
      return;
    }
    state.messages = [...older, ...state.messages];
    state.messagesCursor = data.nextCursor || null;
    state.messagesHasMore = !!data.nextCursor;
    state.restoreScrollBottom = savedBottomOffset;
    state.stickToBottom = false;
    render();
  } catch (err) {
    state.status = describeError(err);
  } finally {
    state.messagesLoadingOlder = false;
  }
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

async function loadAudit(): Promise<void> {
  if (!state.selectedWorkspaceId) return;
  state.auditLoading = true;
  state.auditEntries = [];
  render();
  try {
    const data = await httpClient.get<{ items: AuditEntry[] }>(
      `/api/v1/workspaces/${state.selectedWorkspaceId}/audit?limit=100`
    );
    state.auditEntries = data.items ?? [];
  } catch (err) {
    state.status = describeError(err);
  } finally {
    state.auditLoading = false;
    render();
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function loadMembers(): Promise<void> {
  if (!state.selectedWorkspaceId) return;
  state.membersLoading = true;
  state.members = [];
  render();
  try {
    const data = await httpClient.get<{ items: Member[] }>(`/api/v1/workspaces/${state.selectedWorkspaceId}/members`);
    state.members = data.items ?? [];
  } catch (err) {
    state.status = describeError(err);
  } finally {
    state.membersLoading = false;
    render();
  }
}

function handleRealtimeEvent(event: RealtimeEvent): void {
  if (event.channelId !== state.selectedChannelId) return;
  switch (event.event) {
    case "message.created": {
      const msg = event.payload as Message;
      if (state.messages.some((m) => m.id === msg.id)) return;
      state.messages = [...state.messages, { ...msg, reactions: msg.reactions ?? {} }];
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
      state.messages = state.messages.map((m) =>
        m.id === msg.id ? { ...msg, reactions: msg.reactions ?? m.reactions ?? {} } : m
      );
      render();
      break;
    }
    case "message.reaction.added": {
      const p = event.payload as { messageId: string; userId: string; emoji: string };
      applyReactionDelta(p.messageId, p.emoji, +1, p.userId);
      break;
    }
    case "message.reaction.removed": {
      const p = event.payload as { messageId: string; userId: string; emoji: string };
      applyReactionDelta(p.messageId, p.emoji, -1, p.userId);
      break;
    }
    case "voice.joined": {
      const p = event.payload as VoicePeekParticipant & { channelId: string };
      if (!state.voicePeek || state.voicePeek.channelId !== p.channelId) break;
      if (state.voicePeek.participants.some((x) => x.sessionId === p.sessionId)) break;
      state.voicePeek = {
        channelId: p.channelId,
        participants: [...state.voicePeek.participants, p]
      };
      render();
      break;
    }
    case "voice.left": {
      const p = event.payload as { channelId: string; sessionId: string };
      if (!state.voicePeek || state.voicePeek.channelId !== p.channelId) break;
      state.voicePeek = {
        channelId: p.channelId,
        participants: state.voicePeek.participants.filter((x) => x.sessionId !== p.sessionId)
      };
      render();
      break;
    }
  }
}

function applyReactionDelta(messageId: string, emoji: string, delta: number, userId: string): void {
  const idx = state.messages.findIndex((m) => m.id === messageId);
  if (idx < 0) return;
  const msg = state.messages[idx];
  const reactions = { ...(msg.reactions ?? {}) };
  const current = reactions[emoji] ?? { count: 0, mine: false };
  const isMe = userId === state.me?.id;
  const nextCount = current.count + delta;
  if (nextCount <= 0) {
    delete reactions[emoji];
  } else {
    reactions[emoji] = {
      count: nextCount,
      mine: isMe ? delta > 0 : current.mine
    };
  }
  state.messages = state.messages.map((m, i) => (i === idx ? { ...m, reactions } : m));
  render();
}

async function toggleReaction(messageId: string, emoji: string): Promise<void> {
  const msg = state.messages.find((m) => m.id === messageId);
  if (!msg) return;
  const isMine = msg.reactions?.[emoji]?.mine ?? false;
  const path = `/api/v1/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`;
  try {
    if (isMine) {
      await httpClient.del(path);
    } else {
      await httpClient.put(path);
    }
  } catch (err) {
    state.status = describeError(err);
    render();
  }
}

function render(): void {
  if (!httpClient.getTokens()) {
    renderAuth();
    return;
  }
  // C.4: фиксируем bottom-offset ДО уничтожения старого message-list,
  // чтобы после re-render позиция чтения не уехала. Если значение уже
  // задано (loadOlderMessages с pre-prepend высотой) — не перетираем.
  if (!state.stickToBottom && state.restoreScrollBottom === null) {
    const oldList = rootEl.querySelector<HTMLDivElement>("#message-list");
    if (oldList) {
      state.restoreScrollBottom = oldList.scrollHeight - oldList.scrollTop - oldList.clientHeight;
    }
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
            <input name="username" minlength="3" maxlength="32" title="строчные a-z, 0-9, нижнее подчёркивание; 3-32 символа" placeholder="username" />
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
        const rawUsername = String(data.get("username") ?? "").trim().toLowerCase();
        const username = rawUsername.replace(/[^a-z0-9_]/g, "_");
        if (!/^[a-z0-9_]{3,32}$/.test(username)) {
          state.authError = "Имя пользователя: 3–32 символа, только a–z, 0–9, _";
          render();
          return;
        }
        await httpClient.register({
          email: String(data.get("email") ?? "").trim(),
          username,
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
  const canModerate = !!selectedWorkspace && ["owner", "admin", "moderator"].includes(selectedWorkspace.role ?? "");

  rootEl.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="sidebar-header">
          <button id="open-profile" class="user user-btn" title="Профиль">
            <div class="avatar">${(me?.displayName || me?.username || "?").charAt(0).toUpperCase()}</div>
            <div>
              <div class="user-name">${escapeHtml(me?.displayName || me?.username || "—")}</div>
              <div class="user-sub">@${escapeHtml(me?.username || "")}</div>
            </div>
          </button>
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
        <form id="create-workspace" class="inline-form" data-slug-touched="false">
          <input name="name" placeholder="Имя нового воркспейса" required />
          <input name="slug" placeholder="slug (a-z, 0-9, -)" title="3–64 символа, строчные a-z, 0-9, -, не может начинаться/заканчиваться дефисом" required />
          <button type="submit" title="Создать">+</button>
        </form>
        <form id="accept-invite" class="inline-form">
          <input name="code" placeholder="Код инвайта" required />
          <button type="submit" title="Принять">↵</button>
        </form>
        ${state.selectedWorkspaceId ? renderChannelsBlock() : ""}
        ${state.selectedWorkspaceId ? renderMembersButton() : ""}
        ${state.selectedWorkspaceId && canModerate ? renderAuditButton() : ""}
        ${state.selectedWorkspaceId && canModerate ? renderInvitesBlock() : ""}
        ${renderVoiceStrip()}
      </aside>
      <main class="content">
        ${selectedChannel ? renderChannelView(selectedChannel) : renderEmpty()}
      </main>
      ${state.status ? `<div class="status-bar">${escapeHtml(state.status)}</div>` : ""}
      ${renderModal()}
      ${renderCallOverlay()}
    </div>
  `;
  attachShellHandlers();
  attachVoiceVideoStreams();
}

function renderCallOverlay(): string {
  const snap = state.callSnapshot;
  if (!snap) return "";
  const peerName = describePeer(snap.peerUserId);
  const avatar = peerName.slice(0, 1).toUpperCase();
  const duration = snap.startedAt ? formatDuration(Date.now() - snap.startedAt) : "";

  // Incoming/outgoing/connecting/ended — компактная карточка справа снизу.
  // Active — full-width bar вдоль нижней грани с tiles над ним.
  if (snap.state === "active") {
    return `
      <div class="call-video-overlay" role="dialog">
        <div class="call-video-stack">
          <div class="call-video-tile remote">
            <video data-call-remote="1" autoplay playsinline></video>
          </div>
          <div class="call-video-tile self">
            <video data-call-self="1" autoplay playsinline muted></video>
          </div>
        </div>
      </div>
      <div class="call-bar" role="region" aria-label="активный звонок">
        <div class="call-bar-info">
          <div class="call-bar-avatar">${escapeHtml(avatar)}</div>
          <div class="call-bar-name">
            <div class="call-bar-title">${escapeHtml(peerName)}</div>
            <div class="call-bar-timer" id="call-timer">${escapeHtml(duration)}</div>
          </div>
        </div>
        <div class="call-bar-actions">
          ${callIconButton("call-mute", snap.muted ? "mic-off" : "mic", snap.muted ? "Включить микрофон" : "Заглушить", snap.muted ? "danger" : "")}
          ${callIconButton("call-camera", snap.cameraOn ? "camera-off" : "camera", snap.cameraOn ? "Выключить камеру" : "Включить камеру", "", snap.screenSharing)}
          ${callIconButton("call-screen", snap.screenSharing ? "screen-off" : "screen", snap.screenSharing ? "Прекратить демо" : "Поделиться экраном", snap.screenSharing ? "active" : "")}
          ${callIconButton("call-hangup", "phone-off", "Завершить", "hangup")}
        </div>
      </div>
    `;
  }

  let title = "";
  let extra = "";
  let footer = "";
  switch (snap.state) {
    case "incoming":
      title = `Входящий звонок`;
      extra = `от <b>${escapeHtml(peerName)}</b>`;
      footer = `
        <button class="call-accept" id="call-accept">${icon("phone-incoming")} Принять</button>
        <button class="call-reject" id="call-reject">${icon("phone-off")} Отклонить</button>
      `;
      break;
    case "outgoing":
      title = `Звоним…`;
      extra = escapeHtml(peerName);
      footer = `<button class="call-reject" id="call-hangup">${icon("phone-off")} Отменить</button>`;
      break;
    case "connecting":
      title = `Подключение…`;
      extra = escapeHtml(peerName);
      footer = `<button class="call-reject" id="call-hangup">${icon("phone-off")} Завершить</button>`;
      break;
    case "ended":
      title = `Звонок завершён`;
      extra = snap.endedReason ? escapeHtml(snap.endedReason) : "";
      footer = "";
      break;
  }
  return `
    <div class="call-overlay" role="dialog">
      <div class="call-card">
        <div class="call-card-body">
          <div class="call-bar-avatar">${escapeHtml(avatar)}</div>
          <div>
            <div class="call-status">${escapeHtml(title)}</div>
            <div class="call-card-extra">${extra}</div>
          </div>
        </div>
        ${footer ? `<div class="call-footer">${footer}</div>` : ""}
      </div>
    </div>
  `;
}

function callIconButton(id: string, iconName: Parameters<typeof icon>[0], title: string, mod = "", disabled = false): string {
  return `<button id="${id}" class="call-icon-btn ${mod}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}" ${disabled ? "disabled" : ""}>${icon(iconName, { size: 20 })}</button>`;
}

function describePeer(userId: string | null): string {
  if (!userId) return "—";
  const member = state.members.find((m) => m.userId === userId);
  if (member) return member.displayName || member.username;
  return userId.slice(0, 8);
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function syncCallTimer(): void {
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
  const snap = state.callSnapshot;
  if (!snap || snap.state !== "active" || !snap.startedAt) return;
  const startedAt = snap.startedAt;
  const tick = () => {
    const el = rootEl.querySelector<HTMLElement>("#call-timer");
    if (!el) {
      if (callTimerInterval) {
        clearInterval(callTimerInterval);
        callTimerInterval = null;
      }
      return;
    }
    el.textContent = formatDuration(Date.now() - startedAt);
  };
  tick();
  callTimerInterval = setInterval(tick, 1000);
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

function renderChannelsBlock(): string {
  return `
    <div class="section-title">Каналы</div>
    <ul class="channel-list">
      ${state.channels
        .map(
          (ch) => `
        <li class="${ch.id === state.selectedChannelId ? "active" : ""}" data-ch="${ch.id}">
          <span class="channel-prefix">${channelPrefix(ch)}</span>
          <span>${escapeHtml(ch.name)}</span>
        </li>
      `
        )
        .join("")}
    </ul>
    <form id="create-channel" class="inline-form">
      <select name="kind" title="Тип канала">
        <option value="text">#</option>
        <option value="voice">🔊</option>
      </select>
      <input name="name" placeholder="новый-канал" required />
      <button type="submit">+</button>
    </form>
  `;
}

function channelPrefix(ch: Channel): string {
  if (ch.isPrivate) return "🔒";
  if (ch.kind === "voice") return "🔊";
  return "#";
}

function renderMembersButton(): string {
  return `<button id="open-members" class="ghost wide-btn">Участники</button>`;
}

function renderAuditButton(): string {
  return `<button id="open-audit" class="ghost wide-btn">Журнал событий</button>`;
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
  if (channel.kind === "voice") {
    return renderVoiceChannelView(channel);
  }
  const canSend = channel.kind === "text";
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
    ${state.pendingUploads.length > 0 ? renderPendingUploads() : ""}
    ${renderReplyBar()}
    <div id="mention-popup" class="mention-popup" hidden></div>
    <form id="send-form" class="send-form">
      <label class="attach-btn ${canSend ? "" : "disabled"}" title="Прикрепить файл">
        📎
        <input type="file" id="attach-input" hidden ${canSend ? "" : "disabled"} />
      </label>
      <input
        name="body"
        autocomplete="off"
        placeholder="${canSend ? `Сообщение в #${channel.name}` : "Этот канал не принимает сообщения"}"
        ${canSend ? "" : "disabled"}
      />
      <button type="submit" ${canSend ? "" : "disabled"}>${state.uploadInFlight ? "…" : "↑"}</button>
    </form>
  `;
}

function renderVoiceChannelView(channel: Channel): string {
  const voice = state.voiceSnapshot;
  const joined = voice?.channelId === channel.id;
  const busyOther = voice && !joined ? voice.channelId : null;
  const participants = joined
    ? voice!.participants
    : state.voicePeek?.channelId === channel.id
      ? state.voicePeek.participants
      : [];
  const selfSessionId = joined ? voice!.selfSessionId : null;
  const joining = voice?.state === "joining";
  const leaving = voice?.state === "leaving";
  const muted = joined && voice!.muted;
  const cameraOn = joined && voice!.cameraOn;
  const screenOn = joined && voice!.screenSharing;
  const error = voice?.error ?? null;

  // tiles: один на каждого участника. Для своих — local stream через
  // data-voice-self; для чужих — remote stream через data-voice-peer.
  // srcObject цепляется после render() в attachVoiceVideoStreams().
  const tiles = participants.length === 0
    ? `<div class="muted">Пока никого. ${joined ? "Подключайся, говори :)" : "Будь первым."}</div>`
    : `<div class="voice-tiles">${participants
        .map((p) => {
          const name = p.displayName?.trim() || p.username || p.userId.slice(0, 8);
          const isSelf = selfSessionId !== null && p.sessionId === selfSessionId;
          const tag = isSelf ? `data-voice-self="1"` : `data-voice-peer="${escapeHtml(p.sessionId)}"`;
          return `<div class="voice-tile${isSelf ? " self" : ""}">
            <video class="voice-tile-video" ${tag} autoplay playsinline ${isSelf ? "muted" : ""}></video>
            <div class="voice-tile-overlay">
              <span class="voice-dot"></span>
              <span class="voice-name">${escapeHtml(name)}${isSelf ? " (вы)" : ""}</span>
            </div>
          </div>`;
        })
        .join("")}</div>`;

  const actions = joined
    ? `
      ${callIconButton("voice-mute", muted ? "mic-off" : "mic", muted ? "Включить микрофон" : "Заглушить", muted ? "danger" : "")}
      ${callIconButton("voice-camera", cameraOn ? "camera-off" : "camera", cameraOn ? "Выключить камеру" : "Включить камеру", "", screenOn)}
      ${callIconButton("voice-screen", screenOn ? "screen-off" : "screen", screenOn ? "Прекратить демо" : "Поделиться экраном", screenOn ? "active" : "")}
      ${callIconButton("voice-leave", "log-out", leaving ? "Выхожу…" : "Выйти", "hangup", leaving)}
    `
    : `
      <button id="voice-join" data-channel-id="${channel.id}" ${joining || busyOther ? "disabled" : ""}>
        ${icon("phone-outgoing", { size: 16 })} ${joining ? "Подключаюсь…" : "Войти в голосовой"}
      </button>
      ${busyOther ? `<div class="muted">Сейчас в другом voice-канале. Сначала выйди оттуда.</div>` : ""}
    `;

  return `
    <header class="channel-header">
      <div>
        <h2>${channel.isPrivate ? "🔒" : "🔊"} ${escapeHtml(channel.name)}</h2>
        ${channel.topic ? `<div class="topic">${escapeHtml(channel.topic)}</div>` : ""}
      </div>
    </header>
    <div class="voice-room">
      <div class="voice-room-body">
        <h3>Сейчас в канале</h3>
        ${tiles}
        ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
      </div>
      <div class="voice-room-actions">${actions}</div>
    </div>
  `;
}

// Persistent strip: когда юзер в voice-канале, в sidebar снизу видим
// «в #X» с участниками и быстрыми контролами — даже когда смотрим
// другой канал. Discord-like.
function renderVoiceStrip(): string {
  const voice = state.voiceSnapshot;
  if (!voice || !voice.channelId) return "";
  const channel = state.channels.find((c) => c.id === voice.channelId);
  const channelName = channel?.name ?? voice.channelId.slice(0, 8);
  const muted = voice.muted;
  const cameraOn = voice.cameraOn;
  const screenOn = voice.screenSharing;
  const leaving = voice.state === "leaving";

  const participants = voice.participants
    .map((p) => {
      const name = p.displayName?.trim() || p.username || p.userId.slice(0, 8);
      const isSelf = p.sessionId === voice.selfSessionId;
      return `<li class="voice-strip-participant${isSelf ? " self" : ""}">
        <span class="voice-dot"></span>
        <span>${escapeHtml(name)}${isSelf ? " (вы)" : ""}</span>
      </li>`;
    })
    .join("");

  return `
    <div class="voice-strip">
      <div class="voice-strip-header" data-voice-jump="${voice.channelId}">
        ${icon("users", { size: 14 })}
        <span class="voice-strip-channel">${escapeHtml(channelName)}</span>
      </div>
      <ul class="voice-strip-list">${participants}</ul>
      <div class="voice-strip-actions">
        ${callIconButton("voice-mute", muted ? "mic-off" : "mic", muted ? "Включить микрофон" : "Заглушить", muted ? "danger" : "")}
        ${callIconButton("voice-camera", cameraOn ? "camera-off" : "camera", cameraOn ? "Выключить камеру" : "Включить камеру", "", screenOn)}
        ${callIconButton("voice-screen", screenOn ? "screen-off" : "screen", screenOn ? "Прекратить демо" : "Поделиться экраном", screenOn ? "active" : "")}
        ${callIconButton("voice-leave", "log-out", leaving ? "Выхожу…" : "Выйти", "hangup", leaving)}
      </div>
    </div>
  `;
}

// После render() цепляем MediaStream'ы в <video data-voice-*> /
// <video data-call-*> элементы. Через innerHTML srcObject не
// сериализуется — нужно ставить программно.
function attachVoiceVideoStreams(): void {
  const voiceLocal = voiceMgr.getLocalStream();
  for (const el of rootEl.querySelectorAll<HTMLVideoElement>("video[data-voice-self]")) {
    if (el.srcObject !== voiceLocal) el.srcObject = voiceLocal;
  }
  for (const el of rootEl.querySelectorAll<HTMLVideoElement>("video[data-voice-peer]")) {
    const sid = el.dataset.voicePeer;
    if (!sid) continue;
    const stream = voiceMgr.getRemoteStream(sid);
    if (el.srcObject !== stream) el.srcObject = stream;
  }
  const callLocal = callMgr.getLocalStream();
  const callRemote = callMgr.getRemoteStream();
  for (const el of rootEl.querySelectorAll<HTMLVideoElement>("video[data-call-self]")) {
    if (el.srcObject !== callLocal) el.srcObject = callLocal;
  }
  for (const el of rootEl.querySelectorAll<HTMLVideoElement>("video[data-call-remote]")) {
    if (el.srcObject !== callRemote) el.srcObject = callRemote;
  }
}

function renderPendingUploads(): string {
  return `
    <div class="pending-uploads">
      ${state.pendingUploads
        .map(
          (a) => `
        <div class="pending-chip" data-pending="${a.id}">
          <span>${isImage(a.contentType) ? "🖼" : "📄"} ${escapeHtml(a.filename || "файл")} · ${formatBytes(a.sizeBytes)}</span>
          <button class="ghost pending-remove" data-id="${a.id}" title="Убрать">✕</button>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function renderAttachment(a: Attachment): string {
  if (isImage(a.contentType)) {
    return `<div class="attach-image" data-media-url="${escapeHtml(a.url + "/thumb")}" data-full-url="${escapeHtml(a.url)}">
              <div class="attach-image-loader">Загрузка изображения…</div>
            </div>`;
  }
  return `
    <a class="attach-file" data-media-url="${escapeHtml(a.url)}" data-filename="${escapeHtml(a.filename || "file")}" href="#">
      <span class="attach-icon">📄</span>
      <div>
        <div class="attach-name">${escapeHtml(a.filename || "файл")}</div>
        <div class="attach-meta">${escapeHtml(a.contentType)} · ${formatBytes(a.sizeBytes)}</div>
      </div>
    </a>
  `;
}

function isImage(contentType: string): boolean {
  return contentType.startsWith("image/");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderReplySnippet(reply: ReplySnippet | undefined): string {
  if (!reply) return "";
  if (reply.deleted) {
    return `<div class="reply-snippet deleted">
      <span class="reply-arrow">↩</span>
      <span class="muted">исходное сообщение удалено</span>
    </div>`;
  }
  const author = describePeer(reply.authorId);
  return `<div class="reply-snippet" data-jump-id="${escapeHtml(reply.messageId)}" title="Перейти к исходному">
    <span class="reply-arrow">↩</span>
    <span class="reply-author">${escapeHtml(author)}</span>
    <span class="reply-body">${escapeHtml(reply.body)}</span>
  </div>`;
}

function renderReplyBar(): string {
  const r = state.replyingTo;
  if (!r) return "";
  if (r.deleted) {
    return `<div class="reply-bar">
      <span class="muted">Отвечаем на удалённое сообщение</span>
      <button class="ghost reply-cancel" title="Отменить ответ">✕</button>
    </div>`;
  }
  const author = describePeer(r.authorId);
  return `<div class="reply-bar">
    <span class="reply-arrow">↩</span>
    <span>В ответ <b>${escapeHtml(author)}</b>: ${escapeHtml(r.body)}</span>
    <button class="ghost reply-cancel" title="Отменить ответ">✕</button>
  </div>`;
}

// MENTION_RE_GLOBAL — синхронен с backend mentionRe: `@<slug>`, slug по
// правилу `[a-z0-9_]{3,32}`. Префикс — начало строки или не-словарный
// символ, чтобы не матчить email'ы (`hi@user`).
const MENTION_RE_GLOBAL = /(^|[^A-Za-z0-9_])@([a-z0-9_]{3,32})/g;
const FENCED_RE = /```([\s\S]*?)```/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const URL_RE = /\bhttps?:\/\/[^\s<>`]+/g;
const BOLD_RE = /\*\*([^*\n]+?)\*\*/g;
const ITALIC_RE = /(^|[^A-Za-z0-9_])_([^_\n]+?)_(?=[^A-Za-z0-9_]|$)/g;

// renderBody — C.3 markdown + C.2 mentions + autolinks. Безопасно:
// весь пользовательский текст проходит через escapeHtml, разметка
// добавляется через известный набор тегов; динамический href строится
// только из URL, прошедших URL_RE (http/https) и тоже escape'ится.
function renderBody(body: string): string {
  const placeholders: string[] = [];
  const stash = (html: string): string => {
    const token = `${placeholders.length}`;
    placeholders.push(html);
    return token;
  };

  // 1) Fenced code blocks — самый высокий приоритет, чтобы внутри
  //    не интерпретировались **, _, бэктики и т.д.
  let text = body.replace(FENCED_RE, (_, raw: string) => {
    const stripped = raw.replace(/^\n/, "").replace(/\n$/, "");
    return stash(`<pre class="md-code-block"><code>${escapeHtml(stripped)}</code></pre>`);
  });

  // 2) Inline code.
  text = text.replace(INLINE_CODE_RE, (_, raw: string) =>
    stash(`<code class="md-code">${escapeHtml(raw)}</code>`)
  );

  // 3) URL autolink. Хвостовые пунктуации (.,!?;:)) отрезаем, чтобы
  //    «загляни http://x.com.» не съело точку.
  text = text.replace(URL_RE, (url: string) => {
    let trimmed = url;
    let trail = "";
    while (trimmed.length > 0 && /[.,!?;:)\]]/.test(trimmed[trimmed.length - 1])) {
      trail = trimmed[trimmed.length - 1] + trail;
      trimmed = trimmed.slice(0, -1);
    }
    if (trimmed.length === 0) return url;
    const safe = escapeHtml(trimmed);
    return stash(`<a href="${safe}" target="_blank" rel="noopener noreferrer nofollow">${safe}</a>`) + trail;
  });

  // 4) Mentions.
  const knownUsernames = new Map(state.members.map((m) => [m.username, m]));
  const me = state.me?.username;
  text = text.replace(MENTION_RE_GLOBAL, (full: string, prefix: string, slug: string) => {
    if (!knownUsernames.has(slug)) return full;
    const isMe = me === slug;
    return prefix + stash(`<span class="mention${isMe ? " mention-self" : ""}">@${escapeHtml(slug)}</span>`);
  });

  // 5) Эскейпим всё оставшееся. Плейсхолдеры (N) состоят
  //    только из управляющего символа и цифр — escapeHtml их не трогает.
  text = escapeHtml(text);

  // 6) Bold / italic поверх уже escape'нутого текста. `*` и `_` в
  //    escapeHtml не входят, поэтому регулярки видят их как есть.
  text = text.replace(BOLD_RE, "<strong>$1</strong>");
  text = text.replace(ITALIC_RE, "$1<em>$2</em>");

  // 7) Возврат плейсхолдеров.
  return text.replace(/(\d+)/g, (_, idx: string) => placeholders[Number(idx)] ?? "");
}

function renderMessage(m: Message): string {
  const isMine = state.me?.id === m.authorId;
  const selectedWorkspace = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  const canModerate = !!selectedWorkspace && ["owner", "admin", "moderator"].includes(selectedWorkspace.role ?? "");
  const canDelete = isMine || canModerate;
  const isEditing = state.editingMessageId === m.id;
  const reactions = Object.entries(m.reactions ?? {});
  const pickerOpen = state.pickerForMessageId === m.id;

  if (isEditing) {
    return `
      <div class="message" data-id="${m.id}">
        <div class="message-meta">
          <span class="author">${escapeHtml(describePeer(m.authorId))}</span>
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
      ${renderReplySnippet(m.replyTo)}
      <div class="message-meta">
        <span class="author">${escapeHtml(describePeer(m.authorId))}${isMine ? " · вы" : ""}</span>
        <span class="timestamp">${formatTime(m.createdAt)}${m.editedAt ? " · изменено" : ""}</span>
        <span class="message-actions">
          <button class="ghost action-react" data-id="${m.id}" title="Реакция">😊</button>
          <button class="ghost action-reply" data-id="${m.id}" data-author="${escapeHtml(m.authorId)}" title="Ответить">↩</button>
          ${isMine ? `<button class="ghost action-edit" data-id="${m.id}" title="Редактировать">✎</button>` : ""}
          ${canDelete ? `<button class="ghost action-delete" data-id="${m.id}" title="Удалить">🗑</button>` : ""}
        </span>
      </div>
      ${m.body ? `<div class="message-body">${renderBody(m.body)}</div>` : ""}
      ${
        m.attachments && m.attachments.length > 0
          ? `<div class="attachments">${m.attachments.map((a) => renderAttachment(a)).join("")}</div>`
          : ""
      }
      ${
        reactions.length > 0
          ? `<div class="reaction-row">
              ${reactions
                .map(
                  ([emoji, agg]) => `
                <button class="reaction-chip${agg.mine ? " mine" : ""}" data-react-toggle="${m.id}" data-emoji="${escapeHtml(emoji)}">
                  <span>${escapeHtml(emoji)}</span>
                  <span class="count">${agg.count}</span>
                </button>
              `
                )
                .join("")}
            </div>`
          : ""
      }
      ${
        pickerOpen
          ? `<div class="emoji-picker">
              ${QUICK_EMOJIS.map(
                (e) =>
                  `<button class="ghost picker-emoji" data-react-toggle="${m.id}" data-emoji="${escapeHtml(e)}">${e}</button>`
              ).join("")}
              <input class="picker-custom" data-msg-id="${m.id}" placeholder="свой… ⏎" maxlength="16" />
            </div>`
          : ""
      }
    </div>
  `;
}

function renderModal(): string {
  if (!state.modal) return "";
  if (state.modal === "profile") return renderProfileModal();
  if (state.modal === "members") return renderMembersModal();
  if (state.modal === "audit") return renderAuditModal();
  return "";
}

function renderAuditModal(): string {
  const ws = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  if (!ws) return "";
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide" role="dialog">
        <div class="modal-header">
          <h3>Журнал событий · ${escapeHtml(ws.name)}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="modal-body">
          ${
            state.auditLoading
              ? `<div class="invites-empty">Загрузка…</div>`
              : state.auditEntries.length === 0
                ? `<div class="invites-empty">Событий пока нет</div>`
                : `<table class="audit-table">
                    <thead><tr><th>Когда</th><th>Кто</th><th>Что</th><th>Цель</th></tr></thead>
                    <tbody>
                      ${state.auditEntries
                        .map(
                          (e) => `
                        <tr>
                          <td class="audit-time">${formatTime(e.createdAt)}</td>
                          <td class="audit-actor">${e.actorId ? shortId(e.actorId) : "система"}</td>
                          <td><code>${escapeHtml(e.action)}</code></td>
                          <td class="audit-target">${escapeHtml(e.targetType)} · ${shortId(e.targetId)}</td>
                        </tr>
                      `
                        )
                        .join("")}
                    </tbody>
                  </table>`
          }
        </div>
      </div>
    </div>
  `;
}

function renderProfileModal(): string {
  const me = state.me;
  if (!me) return "";
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal" role="dialog">
        <div class="modal-header">
          <h3>Профиль</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <form id="profile-form" class="modal-body">
          <label>Email
            <input value="${escapeHtml(me.email)}" disabled />
          </label>
          <label>Имя пользователя
            <input value="${escapeHtml(me.username)}" disabled />
          </label>
          <label>Отображаемое имя
            <input name="displayName" value="${escapeHtml(me.displayName ?? "")}" maxlength="64" />
          </label>
          <button type="submit" class="primary">Сохранить</button>
        </form>
      </div>
    </div>
  `;
}

function renderMembersModal(): string {
  const ws = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  if (!ws) return "";
  const canManageRole = ws.role === "owner" || ws.role === "admin";
  const canKick = ["owner", "admin", "moderator"].includes(ws.role ?? "");
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide" role="dialog">
        <div class="modal-header">
          <h3>Участники · ${escapeHtml(ws.name)}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="modal-body">
          ${
            state.membersLoading
              ? `<div class="invites-empty">Загрузка…</div>`
              : `<table class="members-table">
                  <thead><tr><th>Пользователь</th><th>Роль</th><th></th></tr></thead>
                  <tbody>
                    ${state.members
                      .map((m) => renderMemberRow(m, ws.ownerId, canManageRole, canKick))
                      .join("")}
                  </tbody>
                </table>`
          }
        </div>
      </div>
    </div>
  `;
}

function renderMemberRow(m: Member, ownerId: string, canManageRole: boolean, canKick: boolean): string {
  const isOwner = m.userId === ownerId;
  const isSelf = m.userId === state.me?.id;
  const roleOptions = ["admin", "moderator", "member"];
  const showRoleSelect = canManageRole && !isOwner && !isSelf;
  const showKick = canKick && !isOwner && !isSelf;
  const showCall = !isSelf && state.callSnapshot === null;
  return `
    <tr data-member="${m.userId}">
      <td>
        <div class="member-name">${escapeHtml(m.displayName || m.username)}</div>
        <div class="member-sub">@${escapeHtml(m.username)}</div>
      </td>
      <td>
        ${
          showRoleSelect
            ? `<select class="member-role" data-user-id="${m.userId}">
                ${roleOptions
                  .map(
                    (r) => `<option value="${r}"${r === m.role ? " selected" : ""}>${escapeHtml(r)}</option>`
                  )
                  .join("")}
              </select>`
            : `<span class="role-badge role-${escapeHtml(m.role)}">${escapeHtml(m.role)}</span>`
        }
      </td>
      <td>
        ${showCall ? `<button class="ghost member-call" data-user-id="${m.userId}" title="Позвонить">📞</button>` : ""}
        ${showKick ? `<button class="ghost member-kick" data-user-id="${m.userId}" title="Удалить">🗑</button>` : ""}
      </td>
    </tr>
  `;
}

function attachShellHandlers(): void {
  rootEl.querySelector<HTMLButtonElement>("#logout-btn")?.addEventListener("click", () => {
    void httpClient.logout();
  });

  rootEl.querySelector<HTMLButtonElement>("#open-profile")?.addEventListener("click", () => {
    state.modal = "profile";
    render();
  });

  rootEl.querySelector<HTMLButtonElement>("#open-members")?.addEventListener("click", async () => {
    state.modal = "members";
    render();
    await loadMembers();
  });

  rootEl.querySelector<HTMLButtonElement>("#open-audit")?.addEventListener("click", async () => {
    state.modal = "audit";
    render();
    await loadAudit();
  });

  rootEl.querySelectorAll<HTMLElement>("[data-modal-close]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target !== el && e.currentTarget !== e.target) return;
      state.modal = null;
      render();
    });
  });

  rootEl.querySelector<HTMLFormElement>("#profile-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const displayName = String(data.get("displayName") ?? "").trim();
    try {
      const updated = await httpClient.put<Me & { updatedAt: string }>("/api/v1/users/me", {
        displayName
      });
      state.me = { id: updated.id, email: updated.email, username: updated.username, displayName: updated.displayName };
      state.modal = null;
      state.status = "Профиль обновлён";
      render();
    } catch (err) {
      state.status = describeError(err);
      render();
    }
  });

  rootEl.querySelectorAll<HTMLSelectElement>(".member-role").forEach((sel) => {
    sel.addEventListener("change", async () => {
      if (!state.selectedWorkspaceId) return;
      const userId = sel.dataset.userId;
      if (!userId) return;
      try {
        await httpClient.patch(`/api/v1/workspaces/${state.selectedWorkspaceId}/members/${userId}`, {
          role: sel.value
        });
        const idx = state.members.findIndex((m) => m.userId === userId);
        if (idx >= 0) state.members[idx] = { ...state.members[idx], role: sel.value };
        render();
      } catch (err) {
        state.status = describeError(err);
        render();
      }
    });
  });

  rootEl.querySelectorAll<HTMLButtonElement>(".member-kick").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!state.selectedWorkspaceId) return;
      const userId = btn.dataset.userId;
      if (!userId) return;
      if (!confirm("Удалить участника из воркспейса?")) return;
      try {
        await httpClient.del(`/api/v1/workspaces/${state.selectedWorkspaceId}/members/${userId}`);
        state.members = state.members.filter((m) => m.userId !== userId);
        render();
      } catch (err) {
        state.status = describeError(err);
        render();
      }
    });
  });

  rootEl.querySelectorAll<HTMLButtonElement>(".member-call").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const userId = btn.dataset.userId;
      if (!userId) return;
      try {
        state.modal = null;
        await callMgr.placeCall(userId);
      } catch (err) {
        state.status = describeError(err);
        render();
      }
    });
  });

  rootEl.querySelector<HTMLButtonElement>("#call-accept")?.addEventListener("click", async () => {
    try {
      await callMgr.acceptIncoming();
    } catch (err) {
      state.status = describeError(err);
      render();
    }
  });
  rootEl.querySelector<HTMLButtonElement>("#call-reject")?.addEventListener("click", () => {
    callMgr.rejectIncoming();
  });
  rootEl.querySelector<HTMLButtonElement>("#call-hangup")?.addEventListener("click", () => {
    callMgr.hangup();
  });
  rootEl.querySelector<HTMLButtonElement>("#call-mute")?.addEventListener("click", () => {
    callMgr.toggleMute();
  });
  rootEl.querySelector<HTMLButtonElement>("#call-camera")?.addEventListener("click", async () => {
    try {
      await callMgr.toggleCamera();
    } catch (err) {
      state.status = describeError(err);
      render();
    }
  });
  rootEl.querySelector<HTMLButtonElement>("#call-screen")?.addEventListener("click", async () => {
    try {
      await callMgr.toggleScreenShare();
    } catch (err) {
      state.status = describeError(err);
      render();
    }
  });

  rootEl.querySelector<HTMLButtonElement>("#voice-join")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const channelId = btn.dataset.channelId;
    if (!channelId) return;
    try {
      await voiceMgr.join(channelId);
    } catch (err) {
      state.status = describeError(err);
      render();
    }
  });
  // voice-кнопки могут существовать одновременно в room (content) и в
  // strip (sidebar) — навешиваем хэндлер на все.
  for (const btn of rootEl.querySelectorAll<HTMLButtonElement>("#voice-mute")) {
    btn.addEventListener("click", () => voiceMgr.toggleMute());
  }
  for (const btn of rootEl.querySelectorAll<HTMLButtonElement>("#voice-camera")) {
    btn.addEventListener("click", async () => {
      try {
        await voiceMgr.toggleCamera();
      } catch (err) {
        state.status = describeError(err);
        render();
      }
    });
  }
  for (const btn of rootEl.querySelectorAll<HTMLButtonElement>("#voice-screen")) {
    btn.addEventListener("click", async () => {
      try {
        await voiceMgr.toggleScreenShare();
      } catch (err) {
        state.status = describeError(err);
        render();
      }
    });
  }
  for (const btn of rootEl.querySelectorAll<HTMLButtonElement>("#voice-leave")) {
    btn.addEventListener("click", () => {
      void voiceMgr.leave();
    });
  }
  rootEl.querySelector<HTMLElement>("[data-voice-jump]")?.addEventListener("click", (e) => {
    const target = e.currentTarget as HTMLElement;
    const chId = target.dataset.voiceJump;
    if (chId && chId !== state.selectedChannelId) void selectChannel(chId);
  });

  syncCallTimer();

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

  const wsForm = rootEl.querySelector<HTMLFormElement>("#create-workspace");
  if (wsForm) {
    const nameInput = wsForm.querySelector<HTMLInputElement>('input[name="name"]');
    const slugInput = wsForm.querySelector<HTMLInputElement>('input[name="slug"]');
    if (nameInput && slugInput) {
      nameInput.addEventListener("input", () => {
        if (wsForm.dataset.slugTouched !== "true") {
          slugInput.value = slugify(nameInput.value);
        }
      });
      slugInput.addEventListener("input", () => {
        wsForm.dataset.slugTouched = slugInput.value === "" ? "false" : "true";
      });
    }
    wsForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = new FormData(wsForm);
      const name = String(data.get("name") ?? "").trim();
      let slug = String(data.get("slug") ?? "").trim().toLowerCase();
      slug = slug.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
      if (slug.length < 3) {
        state.status = "Slug должен быть от 3 символов: a-z, 0-9, -";
        render();
        return;
      }
      try {
        const ws = await httpClient.post<Workspace>("/api/v1/workspaces", { name, slug });
        state.workspaces = [...state.workspaces, ws];
        realtimeClient.reconnect();
        await selectWorkspace(ws.id);
      } catch (err) {
        state.status = describeError(err);
        render();
      }
    });
  }

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
      realtimeClient.reconnect();
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
    const kind = String(data.get("kind") ?? "text").trim() || "text";
    try {
      const ch = await httpClient.post<Channel>(`/api/v1/workspaces/${state.selectedWorkspaceId}/channels`, {
        kind,
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
      state.pickerForMessageId = null;
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

  rootEl.querySelectorAll<HTMLButtonElement>(".action-react").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id ?? null;
      state.pickerForMessageId = state.pickerForMessageId === id ? null : id;
      render();
    });
  });

  rootEl.querySelectorAll<HTMLButtonElement>("[data-react-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const messageId = btn.dataset.reactToggle;
      const emoji = btn.dataset.emoji;
      if (!messageId || !emoji) return;
      state.pickerForMessageId = null;
      void toggleReaction(messageId, emoji);
    });
  });

  rootEl.querySelectorAll<HTMLInputElement>(".picker-custom").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const messageId = input.dataset.msgId;
      const emoji = input.value.trim();
      if (!messageId || !emoji) return;
      state.pickerForMessageId = null;
      void toggleReaction(messageId, emoji);
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
        render();
      } catch (err) {
        state.status = describeError(err);
        render();
      }
    });
  });

  rootEl.querySelector<HTMLInputElement>("#attach-input")?.addEventListener("change", async (e) => {
    const target = e.currentTarget as HTMLInputElement;
    const file = target.files && target.files[0];
    target.value = "";
    if (!file) return;
    state.uploadInFlight = true;
    render();
    try {
      const uploaded = await httpClient.uploadFile<PendingUpload>("/api/v1/uploads", file);
      state.pendingUploads = [...state.pendingUploads, uploaded];
    } catch (err) {
      state.status = describeError(err);
    } finally {
      state.uploadInFlight = false;
      render();
    }
  });

  rootEl.querySelectorAll<HTMLButtonElement>(".pending-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      state.pendingUploads = state.pendingUploads.filter((p) => p.id !== id);
      render();
    });
  });

  rootEl.querySelectorAll<HTMLAnchorElement>(".attach-file").forEach((link) => {
    link.addEventListener("click", async (e) => {
      e.preventDefault();
      const url = link.dataset.mediaUrl;
      const filename = link.dataset.filename || "file";
      if (!url) return;
      try {
        const blob = await httpClient.getBlob(url);
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
      } catch (err) {
        state.status = describeError(err);
        render();
      }
    });
  });

  rootEl.querySelectorAll<HTMLDivElement>(".attach-image").forEach((slot) => {
    const url = slot.dataset.mediaUrl;
    if (!url) return;
    const cached = mediaBlobCache.get(url);
    if (cached) {
      slot.innerHTML = `<img src="${cached}" alt="" />`;
      return;
    }
    void (async () => {
      try {
        const blob = await httpClient.getBlob(url);
        const blobUrl = URL.createObjectURL(blob);
        mediaBlobCache.set(url, blobUrl);
        slot.innerHTML = `<img src="${blobUrl}" alt="" />`;
      } catch {
        slot.innerHTML = `<div class="attach-image-loader">Не удалось загрузить</div>`;
      }
    })();
  });

  // mention-автокомплит: ловим `@<prefix>` перед каретой и показываем
  // popup. Все обновления — direct DOM, чтобы не дёргать render() и не
  // терять фокус/курсор в input'е (см. техдолг про инкрементальный апдейт).
  const composerInput = rootEl.querySelector<HTMLInputElement>('#send-form input[name="body"]');
  const mentionPopup = rootEl.querySelector<HTMLDivElement>("#mention-popup");
  if (composerInput && mentionPopup) {
    composerInput.addEventListener("input", () => updateMentionPopup(composerInput, mentionPopup));
    composerInput.addEventListener("click", () => updateMentionPopup(composerInput, mentionPopup));
    composerInput.addEventListener("keyup", (ev) => {
      // ArrowLeft/Right двигают каретку — пересчитаем токен. Стрелки
      // вверх/вниз и Enter обрабатываются на keydown ниже.
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight" || ev.key === "Home" || ev.key === "End") {
        updateMentionPopup(composerInput, mentionPopup);
      }
    });
    composerInput.addEventListener("keydown", (ev) => {
      if (!state.mentionAutocomplete || mentionPopup.hidden) return;
      const matches = filterMentionMatches(state.mentionAutocomplete.query);
      if (matches.length === 0) return;
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        state.mentionAutocomplete.selectIndex = (state.mentionAutocomplete.selectIndex + 1) % matches.length;
        renderMentionPopupContent(mentionPopup, matches, state.mentionAutocomplete.selectIndex);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        state.mentionAutocomplete.selectIndex =
          (state.mentionAutocomplete.selectIndex - 1 + matches.length) % matches.length;
        renderMentionPopupContent(mentionPopup, matches, state.mentionAutocomplete.selectIndex);
      } else if (ev.key === "Enter" || ev.key === "Tab") {
        ev.preventDefault();
        applyMentionPick(composerInput, mentionPopup, matches[state.mentionAutocomplete.selectIndex].username);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        hideMentionPopup(mentionPopup);
      }
    });
    composerInput.addEventListener("blur", () => {
      // Микро-задержка чтобы клик по popup успел отработать раньше скрытия.
      setTimeout(() => hideMentionPopup(mentionPopup), 120);
    });
    mentionPopup.addEventListener("mousedown", (ev) => {
      const target = (ev.target as HTMLElement).closest<HTMLElement>("[data-mention-username]");
      if (!target) return;
      ev.preventDefault();
      applyMentionPick(composerInput, mentionPopup, target.dataset.mentionUsername!);
    });
  }

  rootEl.querySelector<HTMLFormElement>("#send-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const input = form.querySelector<HTMLInputElement>('input[name="body"]');
    if (!input || !state.selectedChannelId) return;
    const body = input.value.trim();
    const attachmentIds = state.pendingUploads.map((p) => p.id);
    if (!body && attachmentIds.length === 0) return;
    input.value = "";
    const pendingSnapshot = state.pendingUploads;
    const replyingSnapshot = state.replyingTo;
    state.pendingUploads = [];
    state.replyingTo = null;
    state.stickToBottom = true; // отправил — едем вниз показать свой месседж
    render();
    try {
      const created = await httpClient.post<Message>(`/api/v1/channels/${state.selectedChannelId}/messages`, {
        body,
        clientMessageId: crypto.randomUUID(),
        attachmentIds,
        replyToMessageId: replyingSnapshot?.messageId ?? undefined
      });
      if (created && created.id && !state.messages.some((m) => m.id === created.id)) {
        state.messages = [
          ...state.messages,
          { ...created, reactions: created.reactions ?? {}, attachments: created.attachments ?? [] }
        ];
        render();
      }
    } catch (err) {
      state.status = describeError(err);
      input.value = body;
      state.pendingUploads = pendingSnapshot;
      state.replyingTo = replyingSnapshot;
      render();
    }
  });

  // «Ответить» в action-bar сообщения
  rootEl.querySelectorAll<HTMLButtonElement>(".action-reply").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (!id) return;
      const target = state.messages.find((m) => m.id === id);
      if (!target) return;
      state.replyingTo = {
        messageId: target.id,
        authorId: target.authorId,
        body: target.body.slice(0, 120)
      };
      render();
      // Возвращаем фокус в композер.
      rootEl.querySelector<HTMLInputElement>('#send-form input[name="body"]')?.focus();
    });
  });
  rootEl.querySelector<HTMLButtonElement>(".reply-cancel")?.addEventListener("click", () => {
    state.replyingTo = null;
    render();
  });

  // Клик на reply-snippet — прыжок к исходному сообщению (если оно в DOM).
  rootEl.querySelectorAll<HTMLElement>(".reply-snippet[data-jump-id]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.jumpId;
      if (!id) return;
      const target = rootEl.querySelector<HTMLElement>(`.message[data-id="${id}"]`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("highlight");
        setTimeout(() => target.classList.remove("highlight"), 1200);
      }
    });
  });

  const list = rootEl.querySelector<HTMLDivElement>("#message-list");
  if (list) {
    // C.4: восстановление позиции либо приклеивание к низу.
    if (state.restoreScrollBottom !== null) {
      list.scrollTop = list.scrollHeight - list.clientHeight - state.restoreScrollBottom;
      state.restoreScrollBottom = null;
    } else if (state.stickToBottom) {
      list.scrollTop = list.scrollHeight;
    }
    // После выставления scrollTop вешаем listener — иначе наш же
    // программный скролл триггерит пересчёт stickToBottom от нулевой высоты.
    list.addEventListener("scroll", onMessageListScroll);
  }
}

function onMessageListScroll(e: Event): void {
  const list = e.currentTarget as HTMLDivElement;
  const bottomDistance = list.scrollHeight - list.scrollTop - list.clientHeight;
  state.stickToBottom = bottomDistance < 80;
  // Подгружаем старые когда юзер близок к верху и есть что грузить.
  if (
    list.scrollTop < 200 &&
    state.messagesHasMore &&
    !state.messagesLoadingOlder &&
    state.selectedChannelId
  ) {
    void loadOlderMessages(state.selectedChannelId, list);
  }
}

// ---- mention popup ---------------------------------------------------------

const MENTION_TOKEN_RE = /(?:^|[^A-Za-z0-9_])@([a-z0-9_]{0,32})$/;

function filterMentionMatches(query: string): Member[] {
  const q = query.toLowerCase();
  const meId = state.me?.id;
  const out: Member[] = [];
  for (const m of state.members) {
    if (m.userId === meId) continue;
    if (!m.username.startsWith(q)) continue;
    out.push(m);
    if (out.length >= 8) break;
  }
  return out;
}

function updateMentionPopup(input: HTMLInputElement, popup: HTMLDivElement): void {
  const caret = input.selectionStart ?? input.value.length;
  const head = input.value.slice(0, caret);
  const m = head.match(MENTION_TOKEN_RE);
  if (!m) {
    hideMentionPopup(popup);
    return;
  }
  const query = m[1];
  const matches = filterMentionMatches(query);
  if (matches.length === 0) {
    hideMentionPopup(popup);
    return;
  }
  const prevIndex = state.mentionAutocomplete?.selectIndex ?? 0;
  const selectIndex = Math.min(prevIndex, matches.length - 1);
  state.mentionAutocomplete = { query, selectIndex };
  renderMentionPopupContent(popup, matches, selectIndex);
  popup.hidden = false;
}

function renderMentionPopupContent(popup: HTMLDivElement, matches: Member[], selectIndex: number): void {
  popup.innerHTML = matches
    .map(
      (m, i) => `<div class="mention-item${i === selectIndex ? " selected" : ""}" data-mention-username="${escapeHtml(m.username)}">
        <span class="mention-name">${escapeHtml(m.displayName || m.username)}</span>
        <span class="mention-sub">@${escapeHtml(m.username)}</span>
      </div>`
    )
    .join("");
}

function hideMentionPopup(popup: HTMLDivElement): void {
  popup.hidden = true;
  popup.innerHTML = "";
  state.mentionAutocomplete = null;
}

function applyMentionPick(input: HTMLInputElement, popup: HTMLDivElement, username: string): void {
  const caret = input.selectionStart ?? input.value.length;
  const head = input.value.slice(0, caret);
  const tail = input.value.slice(caret);
  const m = head.match(MENTION_TOKEN_RE);
  if (!m) return;
  // Сохраняем разделитель перед `@` (или пустоту, если start of line).
  const prefixLen = m[0].length - 1 - m[1].length;
  const startOfToken = head.length - m[0].length + prefixLen;
  const replacement = "@" + username + " ";
  const newValue = input.value.slice(0, startOfToken) + replacement + tail;
  input.value = newValue;
  const newCaret = startOfToken + replacement.length;
  input.setSelectionRange(newCaret, newCaret);
  hideMentionPopup(popup);
  input.focus();
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
