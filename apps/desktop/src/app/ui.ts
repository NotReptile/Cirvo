import type { CallManager, CallSnapshot } from "../call/callManager";
import type { VoiceChannelManager, VoiceSnapshot } from "../call/voiceChannelManager";
import type { ApiError, HttpClient } from "../network/httpClient";
import type { RealtimeClient, RealtimeEvent } from "../realtime/realtimeClient";
import { icon } from "./icons";
import { clearStoredServerUrl, getStoredServerUrl, isProductionShell } from "./serverConfig";

// Backend параллельно принимает до 10 (см. parseAttachmentIDs в message/module.go).
const MAX_ATTACHMENTS = 10;

interface Me {
  id: string;
  email: string;
  username: string;
  displayName?: string;
  isRoot?: boolean;
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

type ModalKind = "profile" | "members" | "audit" | "search" | "notifications" | "admin" | "channelSettings" | null;

// D.4 — per-channel permission overrides.
interface RoleOverride {
  roleCode: string;
  granted: string[];
  denied: string[];
}

interface ChannelPermissionsView {
  channelId: string;
  actions: string[];
  roles: string[];
  overrides: RoleOverride[];
}

interface ChannelSettingsState {
  channelId: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  data: ChannelPermissionsView | null;
  // Локальная карта (roleCode → action → "inherit" | "grant" | "deny").
  // Меняем её, при сохранении сворачиваем в overrides[].
  draft: Record<string, Record<string, "inherit" | "grant" | "deny">>;
}

const ACTION_LABELS_RU: Record<string, string> = {
  "message.write": "Писать сообщения",
  "message.react": "Ставить реакции",
  "message.attach": "Прикреплять файлы",
  "message.mention": "Упоминать @username",
  "channel.manage_members": "Управлять участниками",
  "channel.update": "Изменять канал"
};

const ROLE_LABELS_RU: Record<string, string> = {
  admin: "Админ",
  moderator: "Модератор",
  member: "Участник"
};

// D.2 — Admin panel.
type AdminTab = "settings" | "users" | "metrics";

interface AdminUser {
  id: string;
  email: string;
  username: string;
  displayName?: string;
  isRoot: boolean;
  bannedAt?: string;
  bannedReason?: string;
  createdAt: string;
  lastSeenAt?: string;
  activeSession: boolean;
}

interface ServerSettings {
  maxUsers: number;
  maxWorkspaces: number;
  maxChannelsPerWorkspace: number;
  maxMessageBytes: number;
  maxAttachmentBytes: number;
  storageQuotaBytes: number;
  messageRetentionDays: number;
  registrationOpen: boolean;
  updatedAt: string;
  updatedByUserId?: string;
}

interface ServerMetrics {
  userCount: number;
  bannedUserCount: number;
  workspaceCount: number;
  channelCount: number;
  messageCount: number;
  activeSessions24h: number;
  storageBytes: number;
  mediaObjectCount: number;
  databaseSizeBytes: number;
  storageQuotaBytes: number;
  storageQuotaUsedRatio?: number;
}

interface RetentionStats {
  messagesDeleted: number;
  mediaDeleted: number;
  bytesFreed: number;
}

interface AdminState {
  tab: AdminTab;
  settings: ServerSettings | null;
  settingsDraft: Partial<ServerSettings> | null;
  settingsSaving: boolean;
  settingsError: string | null;
  users: AdminUser[];
  usersQuery: string;
  usersLoading: boolean;
  usersTotal: number;
  metrics: ServerMetrics | null;
  metricsLoading: boolean;
  error: string | null;
  retentionRunning: boolean;
  retentionLast: RetentionStats | null;
}

// C.8: in-app уведомления.
interface NotificationPayload {
  actorId?: string;
  workspaceId?: string;
  channelId?: string;
  messageId?: string;
  callId?: string;
  snippet?: string;
}

interface NotificationItem {
  id: string;
  kind: "mention" | "reply" | "call_incoming";
  payload: NotificationPayload;
  createdAt: string;
  readAt?: string;
}

interface SearchHit {
  id: string;
  channelId: string;
  channelName: string;
  authorId: string;
  body: string;
  highlight: string;
  createdAt: string;
}

interface SearchState {
  query: string;
  loading: boolean;
  hits: SearchHit[];
  error: string | null;
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
  // C.5: unread indicators
  unread: Record<string, number>;                 // channelId → count
  selectedChannelLastReadAt: string | null;       // фриз lastReadAt на момент входа — для divider'а
  // C.7: поиск сообщений
  search: SearchState;
  // C.8: in-app уведомления
  notifications: NotificationItem[];
  notificationsUnread: number;
  notificationsLoading: boolean;
  // D.2: admin panel
  admin: AdminState;
  // D.4: channel permission overrides
  channelSettings: ChannelSettingsState;
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
  restoreScrollBottom: null,
  unread: {},
  selectedChannelLastReadAt: null,
  search: { query: "", loading: false, hits: [], error: null },
  notifications: [],
  notificationsUnread: 0,
  notificationsLoading: false,
  admin: {
    tab: "settings",
    settings: null,
    settingsDraft: null,
    settingsSaving: false,
    settingsError: null,
    users: [],
    usersQuery: "",
    usersLoading: false,
    usersTotal: 0,
    metrics: null,
    metricsLoading: false,
    error: null,
    retentionRunning: false,
    retentionLast: null
  },
  channelSettings: {
    channelId: null,
    loading: false,
    saving: false,
    error: null,
    data: null,
    draft: {}
  }
};

// LRU-кэш blob-URL'ов превью: ключ — оригинальный media-URL (с /thumb для
// миниатюр), значение — blob:-URL, созданный через URL.createObjectURL.
// Без ограничения размера blob'ы утекают (раньше Map рос без верха, при
// длинных сессиях на активном канале десятки MB неосвобождённых блобов).
// Map в JS сохраняет порядок вставки → старая запись = первая в keys().
// При hit'е перевставляем ключ, чтобы он стал «свежим». При выселении
// зовём URL.revokeObjectURL, иначе Chrome держит blob в памяти.
const MEDIA_BLOB_CACHE_MAX = 80;
const mediaBlobStore = new Map<string, string>();

const mediaBlobCache = {
  get(key: string): string | undefined {
    const val = mediaBlobStore.get(key);
    if (val !== undefined) {
      mediaBlobStore.delete(key);
      mediaBlobStore.set(key, val);
    }
    return val;
  },
  set(key: string, val: string): void {
    if (mediaBlobStore.has(key)) mediaBlobStore.delete(key);
    mediaBlobStore.set(key, val);
    while (mediaBlobStore.size > MEDIA_BLOB_CACHE_MAX) {
      const oldestKey = mediaBlobStore.keys().next().value;
      if (oldestKey === undefined) break;
      const oldUrl = mediaBlobStore.get(oldestKey);
      mediaBlobStore.delete(oldestKey);
      if (oldUrl) {
        try { URL.revokeObjectURL(oldUrl); } catch {}
      }
    }
  }
};

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
        pickerForMessageId: null,
        notifications: [],
        notificationsUnread: 0
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
    void loadNotifications();
    void requestBrowserNotificationPermission();
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
  state.unread = {};
  render();
  const data = await httpClient.get<{ items: Channel[] }>(`/api/v1/workspaces/${id}/channels`);
  state.channels = data.items ?? [];
  // Резолвинг authorId → имя в сообщениях. Не блокируем загрузку каналов.
  void loadMembers();
  void loadUnread(id);
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
  state.selectedChannelLastReadAt = null;
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
  // Параллельно: read-receipt (для divider'а) и сами сообщения.
  // lastReadAt фризим ДО mark-as-read, чтобы divider остался виден.
  const [readState, data] = await Promise.all([
    httpClient
      .get<{ lastReadAt?: string }>(`/api/v1/channels/${id}/read`)
      .catch(() => ({} as { lastReadAt?: string })),
    httpClient.get<{ items: Message[]; nextCursor?: string }>(`/api/v1/channels/${id}/messages?limit=50`)
  ]);
  if (state.selectedChannelId !== id) return; // юзер уже сменил канал
  state.messages = (data.items ?? []).slice().reverse();
  state.messagesCursor = data.nextCursor || null;
  state.messagesHasMore = !!data.nextCursor;
  state.stickToBottom = true;
  state.selectedChannelLastReadAt = readState.lastReadAt ?? null;
  state.unread[id] = 0;
  render();
  // Авто-отметка прочитанным: последнее сообщение текущей выборки
  // (если оно не моё — иначе незачем). Не ждём ответа.
  const last = state.messages[state.messages.length - 1];
  if (last && last.authorId !== state.me?.id) {
    void markChannelRead(id, last.id);
  }
}

async function loadUnread(workspaceId: string): Promise<void> {
  try {
    const data = await httpClient.get<{ items: { channelId: string; unreadCount: number }[] }>(
      `/api/v1/workspaces/${workspaceId}/unread`
    );
    if (state.selectedWorkspaceId !== workspaceId) return;
    const map: Record<string, number> = {};
    for (const it of data.items ?? []) {
      // Активный канал считается прочитанным, не надо мигать badge'м на нём.
      map[it.channelId] = it.channelId === state.selectedChannelId ? 0 : it.unreadCount;
    }
    state.unread = map;
    render();
  } catch (err) {
    state.status = describeError(err);
  }
}

async function markChannelRead(channelId: string, messageId: string): Promise<void> {
  try {
    await httpClient.post(`/api/v1/channels/${channelId}/read`, { messageId });
  } catch {
    // молча — read-receipt не критичен
  }
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

// C.7: поиск. Запросы шлются с debounce'ом в attachShellHandlers, здесь —
// сам fetch. searchToken защищает от гонки: если за время запроса юзер
// дописал ещё букв, старый ответ выбросим.
let searchToken = 0;

async function runSearch(query: string): Promise<void> {
  const wsId = state.selectedWorkspaceId;
  const q = query.trim();
  state.search.query = q;
  if (!wsId || q.length < 2) {
    state.search.loading = false;
    state.search.hits = [];
    state.search.error = null;
    render();
    return;
  }
  const myToken = ++searchToken;
  state.search.loading = true;
  state.search.error = null;
  render();
  try {
    const data = await httpClient.get<{ items: SearchHit[] }>(
      `/api/v1/workspaces/${wsId}/search?q=${encodeURIComponent(q)}&limit=25`
    );
    if (myToken !== searchToken) return;
    state.search.hits = data.items ?? [];
    state.search.loading = false;
    render();
  } catch (err) {
    if (myToken !== searchToken) return;
    state.search.loading = false;
    state.search.error = describeError(err);
    state.search.hits = [];
    render();
  }
}

// Прыжок к сообщению из результатов: переключиться на канал, дождаться
// загрузки списка, попытаться найти DOM-узел и подсветить. Если
// сообщение вне первой страницы — просто переключаем канал (lazy
// pagination C.4 подгрузит при скролле вверх).
async function jumpToSearchHit(hit: SearchHit): Promise<void> {
  state.modal = null;
  if (hit.channelId !== state.selectedChannelId) {
    await selectChannel(hit.channelId);
  } else {
    render();
  }
  // селектор messageItem использует [data-message-id], если у нас такого
  // нет — нужно его навесить в renderMessage. Пробуем найти по id класса.
  requestAnimationFrame(() => {
    const el = rootEl.querySelector<HTMLElement>(`.message[data-id="${hit.id}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("highlight");
      setTimeout(() => el.classList.remove("highlight"), 1500);
    }
  });
}

// C.8 — in-app уведомления.

async function loadNotifications(): Promise<void> {
  state.notificationsLoading = true;
  try {
    const [list, count] = await Promise.all([
      httpClient.get<{ items: NotificationItem[] }>("/api/v1/notifications?limit=30"),
      httpClient.get<{ unread: number }>("/api/v1/notifications/count")
    ]);
    state.notifications = list.items ?? [];
    state.notificationsUnread = count.unread ?? 0;
  } catch (err) {
    state.status = describeError(err);
  } finally {
    state.notificationsLoading = false;
    render();
  }
}

function handleIncomingNotification(p: {
  id: string;
  kind: NotificationItem["kind"];
  createdAt: string;
  payload: NotificationPayload;
}): void {
  // Дедуп: если уже видели (мульти-сессия одного юзера) — игнорируем.
  if (state.notifications.some((n) => n.id === p.id)) return;
  const item: NotificationItem = {
    id: p.id,
    kind: p.kind,
    payload: p.payload,
    createdAt: p.createdAt
  };
  state.notifications = [item, ...state.notifications].slice(0, 50);
  state.notificationsUnread += 1;
  render();
  maybeShowBrowserNotification(item);
}

// Браузерное уведомление показываем ТОЛЬКО когда окно неактивно
// (document.hidden). Когда юзер активен — обновится badge + dropdown,
// дёргать системный popup незачем.
function maybeShowBrowserNotification(item: NotificationItem): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && document.visibilityState !== "hidden") return;
  const title = notificationTitle(item);
  const body = notificationBody(item);
  try {
    const n = new Notification(title, { body, tag: item.id });
    n.onclick = () => {
      window.focus();
      void openNotification(item);
      n.close();
    };
  } catch {
    /* старые браузеры могут кидать TypeError */
  }
}

function notificationTitle(item: NotificationItem): string {
  const actor = item.payload.actorId ? describePeer(item.payload.actorId) : "—";
  switch (item.kind) {
    case "mention":
      return `${actor} упомянул вас`;
    case "reply":
      return `${actor} ответил на ваше сообщение`;
    case "call_incoming":
      return `Входящий звонок от ${actor}`;
  }
}

function notificationBody(item: NotificationItem): string {
  if (item.kind === "call_incoming") return "Нажмите, чтобы открыть RuCord";
  return item.payload.snippet ?? "";
}

async function requestBrowserNotificationPermission(): Promise<void> {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "default") return;
  try {
    await Notification.requestPermission();
  } catch {
    /* пользователь отказался или браузер не поддерживает Promise-вариант */
  }
}

async function openNotification(item: NotificationItem): Promise<void> {
  state.modal = null;
  // Mark as read локально и на сервере (fire-and-forget).
  if (!item.readAt) {
    item.readAt = new Date().toISOString();
    state.notificationsUnread = Math.max(0, state.notificationsUnread - 1);
    void httpClient.post(`/api/v1/notifications/${item.id}/read`).catch(() => {
      /* idempotent */
    });
  }
  const targetChannel = item.payload.channelId;
  const targetWorkspace = item.payload.workspaceId;
  if (targetWorkspace && targetWorkspace !== state.selectedWorkspaceId) {
    await selectWorkspace(targetWorkspace);
  }
  if (targetChannel && targetChannel !== state.selectedChannelId) {
    await selectChannel(targetChannel);
  } else {
    render();
  }
  const messageID = item.payload.messageId;
  if (messageID) {
    requestAnimationFrame(() => {
      const el = rootEl.querySelector<HTMLElement>(`.message[data-id="${messageID}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("highlight");
        setTimeout(() => el.classList.remove("highlight"), 1500);
      }
    });
  }
}

async function markAllNotificationsRead(): Promise<void> {
  try {
    await httpClient.post("/api/v1/notifications/read");
    state.notifications = state.notifications.map((n) =>
      n.readAt ? n : { ...n, readAt: new Date().toISOString() }
    );
    state.notificationsUnread = 0;
    render();
  } catch (err) {
    state.status = describeError(err);
    render();
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
  // C.8: уведомления приходят с UserID-routing (workspaceId/channelId не
  // обязательны), обрабатываем до проверки channelId ниже.
  if (event.event === "notification.created") {
    handleIncomingNotification(event.payload as {
      id: string;
      kind: NotificationItem["kind"];
      createdAt: string;
      payload: NotificationPayload;
    });
    return;
  }
  // C.5: события для не-активных каналов обрабатываем отдельно (unread).
  if (event.channelId && event.channelId !== state.selectedChannelId) {
    if (event.event === "message.created") {
      const msg = event.payload as Message;
      if (msg.authorId !== state.me?.id) {
        state.unread[event.channelId] = (state.unread[event.channelId] ?? 0) + 1;
        render();
      }
    } else if (event.event === "channel.read") {
      const p = event.payload as { userId: string; channelId: string };
      if (p.userId === state.me?.id) {
        state.unread[p.channelId] = 0;
        render();
      }
    }
    return;
  }
  if (event.channelId !== state.selectedChannelId) return;
  switch (event.event) {
    case "message.created": {
      const msg = event.payload as Message;
      if (state.messages.some((m) => m.id === msg.id)) return;
      state.messages = [...state.messages, { ...msg, reactions: msg.reactions ?? {} }];
      // Активный канал + юзер у низа → отмечаем прочитанным (своё сообщение
      // тоже двигает курсор, чтобы при возврате не висел divider от старого).
      if (state.stickToBottom && state.selectedChannelId) {
        void markChannelRead(state.selectedChannelId, msg.id);
      }
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

// G.2.a: список input/textarea, чьи value+selection+focus нужно сохранить
// между ре-рендерами, чтобы фокус и набранный текст не терялись. Селекторы
// уникальные в DOM на момент срабатывания render(). Не покрывает auth-форму:
// её ре-рендеры триггерятся только переключением вкладки, что и должно
// очищать поля.
const PRESERVED_INPUT_SELECTORS = [
  '#send-form input[name="body"]',
  "#search-input",
  "#admin-user-search"
];

interface InputSnapshot {
  selector: string;
  value: string;
  selStart: number | null;
  selEnd: number | null;
  hadFocus: boolean;
}

function snapshotPreservedInputs(): InputSnapshot[] {
  const out: InputSnapshot[] = [];
  for (const sel of PRESERVED_INPUT_SELECTORS) {
    const el = rootEl.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel);
    if (!el) continue;
    out.push({
      selector: sel,
      value: el.value,
      selStart: el.selectionStart,
      selEnd: el.selectionEnd,
      hadFocus: document.activeElement === el
    });
  }
  return out;
}

function restorePreservedInputs(snapshots: InputSnapshot[]): void {
  for (const snap of snapshots) {
    const el = rootEl.querySelector<HTMLInputElement | HTMLTextAreaElement>(snap.selector);
    if (!el) continue;
    // Не затираем, если новый input уже содержит значение (например, программно
    // очищенный composer после успешной отправки — там value="" намеренно).
    if (snap.value && !el.value) {
      el.value = snap.value;
    }
    if (snap.hadFocus) {
      try {
        el.focus({ preventScroll: true });
        if (snap.selStart !== null && snap.selEnd !== null) {
          el.setSelectionRange(snap.selStart, snap.selEnd);
        }
      } catch {}
    }
  }
}

// Снимок уже загруженных image-слотов: data-media-url → innerHTML с <img>.
// После innerHTML-перезаписи в renderShell() свежие .attach-image слоты
// рендерятся как placeholder «Загрузка…», потом JS-loop ставит туда <img>
// — отсюда мигание превью на каждый ре-рендер. Восстанавливаем innerHTML
// сразу после renderShell(), чтобы browser не переразмечал и не
// пере-декодировал картинку.
function snapshotImageSlots(): Map<string, string> {
  const out = new Map<string, string>();
  const slots = rootEl.querySelectorAll<HTMLDivElement>(".attach-image[data-media-url]");
  for (const slot of Array.from(slots)) {
    const url = slot.dataset.mediaUrl;
    if (!url) continue;
    // Сохраняем только если внутри уже стоит готовый <img> — иначе нет смысла
    // переносить placeholder, он и так нарисуется заново.
    if (slot.querySelector("img")) {
      out.set(url, slot.innerHTML);
    }
  }
  return out;
}

function restoreImageSlots(snap: Map<string, string>): void {
  if (snap.size === 0) return;
  const slots = rootEl.querySelectorAll<HTMLDivElement>(".attach-image[data-media-url]");
  for (const slot of Array.from(slots)) {
    const url = slot.dataset.mediaUrl;
    if (!url) continue;
    const cached = snap.get(url);
    if (cached) slot.innerHTML = cached;
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
  const inputSnap = snapshotPreservedInputs();
  const imageSnap = snapshotImageSlots();
  renderShell();
  restoreImageSlots(imageSnap);
  restorePreservedInputs(inputSnap);
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
        ${isProductionShell() && getStoredServerUrl() ? `
          <div class="auth-server-strip">
            <span>Сервер: <code>${escapeHtml(getStoredServerUrl() ?? "")}</code></span>
            <button type="button" class="ghost auth-switch-server">Сменить</button>
          </div>
        ` : ""}
      </div>
    </div>
  `;
  const switchBtn = rootEl.querySelector<HTMLButtonElement>(".auth-switch-server");
  if (switchBtn) {
    switchBtn.addEventListener("click", () => {
      if (!confirm("Отключиться от текущего сервера и ввести новый адрес? Локальные токены будут удалены.")) return;
      try { localStorage.removeItem("rucord:tokens"); } catch {}
      clearStoredServerUrl();
      window.location.reload();
    });
  }
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
          ${renderBellButton()}
          ${me?.isRoot ? `<button id="open-admin" class="ghost" title="Админ-панель" aria-label="Админ-панель">🛡</button>` : ""}
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
        <form id="create-workspace" class="inline-form create-workspace-form" data-slug-touched="false">
          <div class="create-workspace-row">
            <input name="name" placeholder="Имя нового воркспейса" required />
            <button type="submit" title="Создать">+</button>
          </div>
          <details class="create-workspace-advanced">
            <summary>Адрес (генерируется автоматически)</summary>
            <input name="slug" placeholder="a-z, 0-9, -" title="3–64 символа, строчные a-z, 0-9, -, не может начинаться/заканчиваться дефисом" />
          </details>
        </form>
        <form id="accept-invite" class="inline-form">
          <input name="code" placeholder="Код инвайта" required />
          <button type="submit" title="Принять">↵</button>
        </form>
        ${state.selectedWorkspaceId ? renderChannelsBlock() : ""}
        ${state.selectedWorkspaceId ? renderSearchButton() : ""}
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

// Маппинг action-кодов из internal/auditlog/auditlog.go в человекочитаемые
// глаголы + иконку категории. Если код не известен (новый action, забыли
// добавить) — fallback к сырому коду в describeAuditEntry, чтобы не
// потерять видимость новой активности в логе.
const AUDIT_ACTION_INFO: Record<string, { ru: string; icon: string }> = {
  "workspace.created": { ru: "создал воркспейс", icon: "🏠" },
  "workspace.member.added": { ru: "добавил участника", icon: "👥" },
  "channel.created": { ru: "создал канал", icon: "📁" },
  "channel.member.added": { ru: "добавил в канал", icon: "➕" },
  "channel.member.removed": { ru: "убрал из канала", icon: "➖" },
  "channel.permissions.updated": { ru: "обновил права канала", icon: "🔒" },
  "message.deleted": { ru: "удалил сообщение", icon: "🗑" },
  "invite.created": { ru: "создал инвайт", icon: "🔗" },
  "invite.revoked": { ru: "отозвал инвайт", icon: "✖" },
  "invite.used": { ru: "использовал инвайт", icon: "✓" },
  "profile.updated": { ru: "обновил профиль", icon: "✎" },
  "user.banned": { ru: "забанил пользователя", icon: "🚫" },
  "user.unbanned": { ru: "разбанил пользователя", icon: "🔓" },
  "user.deleted": { ru: "удалил пользователя", icon: "🗑" },
  "server.settings.updated": { ru: "изменил настройки сервера", icon: "⚙" },
  "server.retention.sweep": { ru: "запустил очистку", icon: "🧹" }
};

interface AuditDescription {
  icon: string;
  actor: string;
  verb: string;
  target: string;
  raw: boolean;
}

function describeAuditEntry(e: AuditEntry): AuditDescription {
  const info = AUDIT_ACTION_INFO[e.action];
  const actor = e.actorId ? describePeer(e.actorId) : "система";

  let target = "";
  switch (e.targetType) {
    case "user": {
      target = describePeer(e.targetId);
      break;
    }
    case "channel":
    case "channel_member": {
      const ch = state.channels.find((c) => c.id === e.targetId);
      target = ch ? `#${ch.name}` : `канал ${shortId(e.targetId)}`;
      break;
    }
    case "workspace": {
      const ws = state.workspaces.find((w) => w.id === e.targetId);
      target = ws ? ws.name : `воркспейс ${shortId(e.targetId)}`;
      break;
    }
    case "message":
      target = `сообщение ${shortId(e.targetId)}`;
      break;
    case "invite":
      target = `инвайт ${shortId(e.targetId)}`;
      break;
    case "server_settings":
    case "server":
      target = "";
      break;
    default:
      target = `${e.targetType} ${shortId(e.targetId)}`;
  }

  if (info) {
    return { icon: info.icon, actor, verb: info.ru, target, raw: false };
  }
  return { icon: "•", actor, verb: e.action, target, raw: true };
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
        .map((ch) => {
          const unread = state.unread[ch.id] ?? 0;
          const cls = [
            ch.id === state.selectedChannelId ? "active" : "",
            unread > 0 ? "has-unread" : ""
          ]
            .filter(Boolean)
            .join(" ");
          const badge = unread > 0 ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>` : "";
          return `
        <li class="${cls}" data-ch="${ch.id}">
          <span class="channel-prefix">${channelPrefix(ch)}</span>
          <span class="channel-name">${escapeHtml(ch.name)}</span>
          ${badge}
        </li>
      `;
        })
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

function renderBellButton(): string {
  const count = state.notificationsUnread;
  const badge = count > 0
    ? `<span class="bell-badge">${count > 99 ? "99+" : count}</span>`
    : "";
  return `<button id="open-notifications" class="ghost bell-btn" title="Уведомления" aria-label="Уведомления">🔔${badge}</button>`;
}

function renderSearchButton(): string {
  return `<button id="open-search" class="ghost wide-btn">🔍 Поиск</button>`;
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
  const ws = state.workspaces.find((w) => w.id === channel.workspaceId);
  const canManage = !!ws && ["owner", "admin"].includes(ws.role ?? "");
  return `
    <header class="channel-header">
      <div>
        <h2>${channel.isPrivate ? "🔒" : "#"} ${escapeHtml(channel.name)}</h2>
        ${channel.topic ? `<div class="topic">${escapeHtml(channel.topic)}</div>` : ""}
      </div>
      ${canManage ? `<button id="open-channel-settings" class="ghost" title="Настройки канала" aria-label="Настройки канала">⚙</button>` : ""}
    </header>
    ${canSend ? `<div id="drop-zone" class="drop-zone" hidden>
      <div class="drop-zone-inner">📎 Отпусти, чтобы прикрепить файлы</div>
    </div>` : ""}
    <div id="message-list" class="message-list">
      ${renderMessagesWithDivider()}
    </div>
    ${renderJumpToUnread()}
    ${state.pendingUploads.length > 0 ? renderPendingUploads() : ""}
    ${renderReplyBar()}
    <div id="mention-popup" class="mention-popup" hidden></div>
    <form id="send-form" class="send-form">
      <label class="attach-btn ${canSend ? "" : "disabled"}" title="Прикрепить файлы (до ${MAX_ATTACHMENTS})">
        📎
        <input type="file" id="attach-input" multiple hidden ${canSend ? "" : "disabled"} />
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

async function uploadFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  const slotsLeft = MAX_ATTACHMENTS - state.pendingUploads.length;
  if (slotsLeft <= 0) {
    state.status = `Достигнут лимит вложений (${MAX_ATTACHMENTS}).`;
    render();
    return;
  }
  let truncated = false;
  if (files.length > slotsLeft) {
    files = files.slice(0, slotsLeft);
    truncated = true;
  }
  state.uploadInFlight = true;
  render();
  const results = await Promise.allSettled(
    files.map((f) => httpClient.uploadFile<PendingUpload>("/api/v1/uploads", f))
  );
  const uploaded: PendingUpload[] = [];
  let firstError: unknown = null;
  for (const r of results) {
    if (r.status === "fulfilled") uploaded.push(r.value);
    else if (firstError === null) firstError = r.reason;
  }
  if (uploaded.length > 0) {
    state.pendingUploads = [...state.pendingUploads, ...uploaded];
  }
  if (firstError) {
    state.status = describeError(firstError);
  } else if (truncated) {
    state.status = `Часть файлов отброшена — лимит ${MAX_ATTACHMENTS} вложений.`;
  }
  state.uploadInFlight = false;
  render();
}

function attachDropZoneHandlers(): void {
  const content = rootEl.querySelector<HTMLElement>("main.content");
  const zone = rootEl.querySelector<HTMLDivElement>("#drop-zone");
  if (!content || !zone) return;
  let depth = 0;
  const show = () => { zone.hidden = false; };
  const hide = () => { depth = 0; zone.hidden = true; };
  content.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    show();
  });
  content.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  content.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth--;
    if (depth <= 0) hide();
  });
  content.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hide();
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
    if (files.length > 0) await uploadFiles(files);
  });
}

function hasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "Files") return true;
  }
  return false;
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

// C.5: pill "↓ N новых" — показываем когда юзер не у низа и есть
// новые сообщения в этом канале (есть divider). Клик скроллит к
// divider'у, в крайнем случае — к низу. Реализовано через
// stickToBottom: если юзер пин'нут к низу, скрываем.
function renderJumpToUnread(): string {
  if (state.stickToBottom) return "";
  const cutoff = state.selectedChannelLastReadAt ? Date.parse(state.selectedChannelLastReadAt) : NaN;
  if (Number.isNaN(cutoff)) return "";
  const newCount = state.messages.filter(
    (m) => Date.parse(m.createdAt) > cutoff && m.authorId !== state.me?.id
  ).length;
  if (newCount === 0) return "";
  return `<button id="jump-to-unread" class="jump-to-unread">↓ ${newCount} ${pluralizeNew(newCount)}</button>`;
}

function pluralizeNew(n: number): string {
  return n % 10 === 1 && n % 100 !== 11 ? "новое" : "новых";
}

// C.5: рендер с разделителем "Новые сообщения" перед первым
// сообщением, чей createdAt позже зафиксированного lastReadAt.
// lastReadAt фризим в selectChannel, чтобы divider не «уплыл» когда
// мы автомаркаем канал прочитанным после загрузки.
function renderMessagesWithDivider(): string {
  const cutoff = state.selectedChannelLastReadAt ? Date.parse(state.selectedChannelLastReadAt) : NaN;
  let dividerInserted = false;
  return state.messages
    .map((m) => {
      let prefix = "";
      if (
        !dividerInserted &&
        !Number.isNaN(cutoff) &&
        Date.parse(m.createdAt) > cutoff &&
        m.authorId !== state.me?.id
      ) {
        prefix = `<div class="new-messages-divider"><span>Новые сообщения</span></div>`;
        dividerInserted = true;
      }
      return prefix + renderMessage(m);
    })
    .join("");
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
  if (state.modal === "search") return renderSearchModal();
  if (state.modal === "notifications") return renderNotificationsModal();
  if (state.modal === "admin") return renderAdminModal();
  if (state.modal === "channelSettings") return renderChannelSettingsModal();
  return "";
}

function renderNotificationsModal(): string {
  const items = state.notifications;
  const body = (() => {
    if (state.notificationsLoading) return `<div class="search-empty">Загрузка…</div>`;
    if (items.length === 0) return `<div class="search-empty">Нет уведомлений</div>`;
    return `<ul class="notif-list">
      ${items.map(renderNotificationItem).join("")}
    </ul>`;
  })();
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide" role="dialog">
        <div class="modal-header">
          <h3>Уведомления</h3>
          <div class="modal-header-actions">
            ${state.notificationsUnread > 0
              ? `<button id="notif-mark-all" class="ghost">Прочитано всё</button>`
              : ""}
            <button class="ghost modal-close-btn" data-modal-close>✕</button>
          </div>
        </div>
        <div class="modal-body">${body}</div>
      </div>
    </div>
  `;
}

function renderNotificationItem(n: NotificationItem): string {
  const unread = !n.readAt;
  const title = notificationTitle(n);
  const body = notificationBody(n);
  const kindIcon =
    n.kind === "call_incoming" ? "📞" :
    n.kind === "reply" ? "↩" : "@";
  return `
    <li class="notif-item ${unread ? "unread" : ""}" data-notif-id="${n.id}">
      <span class="notif-kind">${kindIcon}</span>
      <div class="notif-body">
        <div class="notif-title">${escapeHtml(title)}</div>
        ${body ? `<div class="notif-snippet">${escapeHtml(body)}</div>` : ""}
        <div class="notif-time">${escapeHtml(formatTime(n.createdAt))}</div>
      </div>
    </li>
  `;
}

function renderSearchModal(): string {
  const ws = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  if (!ws) return "";
  const { query, loading, hits, error } = state.search;
  const body = (() => {
    if (error) return `<div class="search-empty error">${escapeHtml(error)}</div>`;
    if (loading) return `<div class="search-empty">Ищу…</div>`;
    if (query.trim().length < 2) return `<div class="search-empty">Введите минимум 2 символа</div>`;
    if (hits.length === 0) return `<div class="search-empty">Ничего не найдено</div>`;
    return `<ul class="search-results">
      ${hits.map(renderSearchHit).join("")}
    </ul>`;
  })();
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide" role="dialog">
        <div class="modal-header">
          <h3>Поиск · ${escapeHtml(ws.name)}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="modal-body">
          <input id="search-input" class="search-input" type="text" autocomplete="off"
                 placeholder="Поиск по сообщениям…" value="${escapeHtml(query)}" />
          ${body}
        </div>
      </div>
    </div>
  `;
}

function renderSearchHit(hit: SearchHit): string {
  const author = describePeer(hit.authorId);
  // ts_headline вернул body с sentinel'ами ⟨MARK⟩…⟨/MARK⟩. Экранируем
  // ВСЁ как обычный текст, потом превращаем sentinel'ы в <mark>. Так в
  // <mark> попадают только escape'нутые куски пользовательского ввода.
  const safe = escapeHtml(hit.highlight || hit.body);
  const highlighted = safe
    .replace(/⟨MARK⟩/g, '<mark class="search-mark">')
    .replace(/⟨\/MARK⟩/g, "</mark>");
  return `
    <li class="search-hit" data-hit-id="${hit.id}" data-hit-channel="${hit.channelId}">
      <div class="search-hit-head">
        <span class="search-hit-channel">#${escapeHtml(hit.channelName)}</span>
        <span class="search-hit-author">${escapeHtml(author)}</span>
        <span class="search-hit-time">${escapeHtml(formatTime(hit.createdAt))}</span>
      </div>
      <div class="search-hit-body">${highlighted}</div>
    </li>
  `;
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
                : `<ul class="audit-list">
                    ${state.auditEntries
                      .map((e) => {
                        const d = describeAuditEntry(e);
                        const verbHtml = d.raw
                          ? `<code>${escapeHtml(d.verb)}</code>`
                          : escapeHtml(d.verb);
                        return `
                          <li class="audit-item${d.raw ? " audit-raw" : ""}">
                            <span class="audit-icon" aria-hidden="true">${d.icon}</span>
                            <div class="audit-body">
                              <div class="audit-line">
                                <span class="audit-actor">${escapeHtml(d.actor)}</span>
                                <span class="audit-verb">${verbHtml}</span>
                                ${d.target ? `<span class="audit-target">${escapeHtml(d.target)}</span>` : ""}
                              </div>
                              <div class="audit-time">${formatTime(e.createdAt)}</div>
                            </div>
                          </li>
                        `;
                      })
                      .join("")}
                  </ul>`
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
    // Members нужны для резолва UUID → displayName в журнале. Тянем
    // параллельно с audit-ом, не блокируем основной запрос.
    const needMembers = state.members.length === 0 && !state.membersLoading;
    await Promise.all([
      loadAudit(),
      needMembers ? loadMembers() : Promise.resolve()
    ]);
  });

  rootEl.querySelector<HTMLButtonElement>("#open-notifications")?.addEventListener("click", () => {
    state.modal = "notifications";
    render();
    void loadNotifications();
  });

  rootEl.querySelector<HTMLButtonElement>("#open-admin")?.addEventListener("click", () => {
    state.modal = "admin";
    state.admin.tab = "settings";
    state.admin.error = null;
    render();
    void loadAdminTab("settings");
  });

  attachAdminHandlers();

  rootEl.querySelector<HTMLButtonElement>("#open-channel-settings")?.addEventListener("click", () => {
    if (!state.selectedChannelId) return;
    state.modal = "channelSettings";
    state.channelSettings = {
      channelId: state.selectedChannelId,
      loading: true,
      saving: false,
      error: null,
      data: null,
      draft: {}
    };
    render();
    void loadChannelPermissions();
  });

  attachChannelSettingsHandlers();

  rootEl.querySelector<HTMLButtonElement>("#notif-mark-all")?.addEventListener("click", () => {
    void markAllNotificationsRead();
  });

  rootEl.querySelectorAll<HTMLElement>(".notif-item").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.notifId;
      if (!id) return;
      const item = state.notifications.find((n) => n.id === id);
      if (item) void openNotification(item);
    });
  });

  rootEl.querySelector<HTMLButtonElement>("#open-search")?.addEventListener("click", () => {
    state.modal = "search";
    state.search = { query: state.search.query, loading: false, hits: state.search.hits, error: null };
    render();
    // фокус и каретка в конец после render()
    const input = rootEl.querySelector<HTMLInputElement>("#search-input");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });

  // Debounce поиска на input. 200мс достаточно чтобы юзер допечатал
  // слово и сервер не молотил каждое нажатие. Прямой DOM-update inside
  // modal-body — иначе render() сбрасывал бы фокус и каретку.
  const searchInput = rootEl.querySelector<HTMLInputElement>("#search-input");
  if (searchInput) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    searchInput.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      const value = searchInput.value;
      timer = setTimeout(() => {
        void runSearch(value);
      }, 200);
    });
  }

  rootEl.querySelectorAll<HTMLElement>(".search-hit").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.hitId;
      const ch = el.dataset.hitChannel;
      if (!id || !ch) return;
      const hit = state.search.hits.find((h) => h.id === id);
      if (hit) void jumpToSearchHit(hit);
    });
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
      state.me = {
        id: updated.id, email: updated.email, username: updated.username,
        displayName: updated.displayName, isRoot: state.me?.isRoot
      };
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
    const files = target.files ? Array.from(target.files) : [];
    target.value = "";
    if (files.length === 0) return;
    await uploadFiles(files);
  });

  attachDropZoneHandlers();

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
    // Если restoreImageSlots уже вернул сюда готовый <img> — не пересоздаём,
    // иначе browser декодирует картинку заново и она мигает.
    if (slot.querySelector("img")) return;
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
        // Между запросом и резолвом мог пройти ре-рендер — повторно
        // выбираем slot по url, иначе пишем в осиротевший элемент.
        const fresh = rootEl.querySelector<HTMLDivElement>(
          `.attach-image[data-media-url="${CSS.escape(url)}"]`
        );
        (fresh ?? slot).innerHTML = `<img src="${blobUrl}" alt="" />`;
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

    // G.1.c: Ctrl+V вставка вложений из буфера. Любые file-items в
    // clipboardData (картинка скриншота, скопированный файл из проводника) —
    // прогоняем через uploadFiles. Текстовая вставка — стандартное поведение
    // браузера, не трогаем (e.preventDefault не вызываем, если файлов нет).
    composerInput.addEventListener("paste", (ev) => {
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

  rootEl.querySelector<HTMLButtonElement>("#jump-to-unread")?.addEventListener("click", () => {
    const divider = rootEl.querySelector<HTMLElement>(".new-messages-divider");
    if (divider) {
      divider.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      const list = rootEl.querySelector<HTMLDivElement>("#message-list");
      if (list) list.scrollTop = list.scrollHeight;
    }
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

// ============================================================
// D.2 — Admin panel
// ============================================================

function renderAdminModal(): string {
  const a = state.admin;
  const tabs: { key: AdminTab; label: string }[] = [
    { key: "settings", label: "Настройки" },
    { key: "users", label: "Пользователи" },
    { key: "metrics", label: "Метрики" }
  ];
  const tabsHtml = tabs.map((t) =>
    `<button class="admin-tab ${a.tab === t.key ? "active" : ""}" data-admin-tab="${t.key}">${t.label}</button>`
  ).join("");
  let body = "";
  if (a.tab === "settings") body = renderAdminSettings();
  else if (a.tab === "users") body = renderAdminUsers();
  else if (a.tab === "metrics") body = renderAdminMetrics();

  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide admin-modal" role="dialog">
        <div class="modal-header">
          <h3>Админ-панель</h3>
          <div class="modal-header-actions">
            <button class="ghost modal-close-btn" data-modal-close>✕</button>
          </div>
        </div>
        <div class="admin-tabs">${tabsHtml}</div>
        ${a.error ? `<div class="admin-error">${escapeHtml(a.error)}</div>` : ""}
        <div class="modal-body admin-body">${body}</div>
      </div>
    </div>
  `;
}

function renderAdminSettings(): string {
  const a = state.admin;
  if (!a.settings) return `<div class="search-empty">Загрузка…</div>`;
  const s = { ...a.settings, ...a.settingsDraft };
  const updatedAt = a.settings.updatedAt ? formatTime(a.settings.updatedAt) : "—";
  const numberField = (key: keyof ServerSettings, label: string, hint?: string) => `
    <label class="admin-field">
      <span class="admin-field-label">${escapeHtml(label)}</span>
      <input type="number" min="0" name="${String(key)}" value="${String(s[key] ?? 0)}" />
      ${hint ? `<span class="admin-field-hint">${escapeHtml(hint)}</span>` : ""}
    </label>
  `;
  const saving = a.settingsSaving ? "Сохраняю…" : "Сохранить";
  return `
    <form id="admin-settings-form" class="admin-form">
      <div class="admin-grid">
        ${numberField("maxUsers", "Лимит пользователей", "0 = безлимит")}
        ${numberField("maxWorkspaces", "Лимит воркспейсов", "0 = безлимит")}
        ${numberField("maxChannelsPerWorkspace", "Каналов на воркспейс", "0 = безлимит")}
        ${numberField("maxMessageBytes", "Размер сообщения, байт", "0 = безлимит")}
        ${numberField("maxAttachmentBytes", "Размер вложения, байт", "0 = безлимит")}
        ${numberField("storageQuotaBytes", "Квота хранилища, байт", "0 = безлимит (D.3)")}
        ${numberField("messageRetentionDays", "Срок хранения сообщений, дни", "0 = бессрочно (D.3)")}
        <label class="admin-field admin-field-bool">
          <input type="checkbox" name="registrationOpen" ${s.registrationOpen ? "checked" : ""} />
          <span>Открытая регистрация</span>
        </label>
      </div>
      <div class="admin-actions">
        <span class="admin-meta">Обновлено: ${escapeHtml(updatedAt)}</span>
        <button type="submit" class="primary" ${a.settingsSaving ? "disabled" : ""}>${saving}</button>
      </div>
      ${a.settingsError ? `<div class="admin-error">${escapeHtml(a.settingsError)}</div>` : ""}
    </form>
  `;
}

function renderAdminUsers(): string {
  const a = state.admin;
  const meId = state.me?.id;
  const rows = a.users.map((u) => {
    const isMe = u.id === meId;
    const status = u.bannedAt
      ? `<span class="badge banned">забанен</span>`
      : u.activeSession
        ? `<span class="badge active">активен</span>`
        : `<span class="badge">офлайн</span>`;
    const role = u.isRoot ? `<span class="badge root">root</span>` : "";
    const banBtn = u.isRoot || isMe
      ? ""
      : u.bannedAt
        ? `<button class="ghost admin-user-action" data-action="unban" data-user="${u.id}">Разбан</button>`
        : `<button class="ghost admin-user-action" data-action="ban" data-user="${u.id}">Бан</button>`;
    const delBtn = u.isRoot || isMe
      ? ""
      : `<button class="ghost danger admin-user-action" data-action="delete" data-user="${u.id}">Удалить</button>`;
    const display = u.displayName ? `${escapeHtml(u.displayName)} (@${escapeHtml(u.username)})` : `@${escapeHtml(u.username)}`;
    return `
      <tr>
        <td><div class="admin-user-cell"><div>${display}</div><div class="admin-user-email">${escapeHtml(u.email)}</div></div></td>
        <td>${role} ${status}</td>
        <td class="admin-user-meta">
          <div>Создан: ${escapeHtml(formatDate(u.createdAt))}</div>
          ${u.lastSeenAt ? `<div>Был: ${escapeHtml(formatTime(u.lastSeenAt))}</div>` : ""}
          ${u.bannedReason ? `<div class="admin-ban-reason">«${escapeHtml(u.bannedReason)}»</div>` : ""}
        </td>
        <td class="admin-user-actions">${banBtn}${delBtn}</td>
      </tr>
    `;
  }).join("");
  return `
    <div class="admin-users-toolbar">
      <input id="admin-users-search" type="search" placeholder="Поиск по email / username…" value="${escapeHtml(a.usersQuery)}" />
      <span class="admin-meta">Всего: ${a.usersTotal}</span>
    </div>
    ${a.usersLoading ? `<div class="search-empty">Загрузка…</div>` : a.users.length === 0
      ? `<div class="search-empty">Никого не найдено</div>`
      : `<table class="admin-users-table">
          <thead><tr><th>Пользователь</th><th>Статус</th><th>Информация</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
    }
  `;
}

function renderAdminMetrics(): string {
  const a = state.admin;
  if (a.metricsLoading || !a.metrics) return `<div class="search-empty">Загрузка…</div>`;
  const m = a.metrics;
  const card = (label: string, value: string, sub?: string) => `
    <div class="admin-metric-card">
      <div class="admin-metric-label">${escapeHtml(label)}</div>
      <div class="admin-metric-value">${escapeHtml(value)}</div>
      ${sub ? `<div class="admin-metric-sub">${escapeHtml(sub)}</div>` : ""}
    </div>
  `;
  const storageSub = m.storageQuotaBytes > 0
    ? `Квота: ${formatBytesLarge(m.storageQuotaBytes)} (${Math.round((m.storageQuotaUsedRatio ?? 0) * 100)}%)`
    : `Без квоты`;
  return `
    <div class="admin-metric-grid">
      ${card("Пользователи", String(m.userCount), `Забанено: ${m.bannedUserCount}`)}
      ${card("Воркспейсы", String(m.workspaceCount))}
      ${card("Каналы", String(m.channelCount))}
      ${card("Сообщения", String(m.messageCount))}
      ${card("Активные сессии (24ч)", String(m.activeSessions24h))}
      ${card("Файлов", String(m.mediaObjectCount), `Размер: ${formatBytesLarge(m.storageBytes)}`)}
      ${card("Хранилище", formatBytesLarge(m.storageBytes), storageSub)}
      ${card("Размер БД", formatBytesLarge(m.databaseSizeBytes))}
    </div>
    <div class="admin-actions">
      <button id="admin-metrics-refresh" class="ghost">Обновить</button>
      <button id="admin-retention-run" class="ghost" ${a.retentionRunning ? "disabled" : ""}>
        ${a.retentionRunning ? "Чищу…" : "Запустить очистку"}
      </button>
    </div>
    ${a.retentionLast ? `
      <div class="admin-meta admin-retention-result">
        Удалено: ${a.retentionLast.messagesDeleted} сообщ., ${a.retentionLast.mediaDeleted} файлов
        (${formatBytesLarge(a.retentionLast.bytesFreed)})
      </div>
    ` : ""}
  `;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString();
}

function formatBytesLarge(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

async function loadAdminTab(tab: AdminTab): Promise<void> {
  state.admin.error = null;
  if (tab === "settings") await loadAdminSettings();
  else if (tab === "users") await loadAdminUsers();
  else if (tab === "metrics") await loadAdminMetrics();
}

async function loadAdminSettings(): Promise<void> {
  try {
    const s = await httpClient.get<ServerSettings>("/api/v1/server/settings");
    state.admin.settings = s;
    state.admin.settingsDraft = null;
    state.admin.settingsError = null;
    render();
  } catch (err) {
    state.admin.error = describeError(err);
    render();
  }
}

async function loadAdminUsers(): Promise<void> {
  state.admin.usersLoading = true;
  render();
  try {
    const q = state.admin.usersQuery.trim();
    const url = q
      ? `/api/v1/server/users?q=${encodeURIComponent(q)}&limit=100`
      : `/api/v1/server/users?limit=100`;
    const resp = await httpClient.get<{ items: AdminUser[]; total: number }>(url);
    state.admin.users = resp.items;
    state.admin.usersTotal = resp.total;
  } catch (err) {
    state.admin.error = describeError(err);
  } finally {
    state.admin.usersLoading = false;
    render();
  }
}

async function loadAdminMetrics(): Promise<void> {
  state.admin.metricsLoading = true;
  render();
  try {
    state.admin.metrics = await httpClient.get<ServerMetrics>("/api/v1/server/metrics");
  } catch (err) {
    state.admin.error = describeError(err);
  } finally {
    state.admin.metricsLoading = false;
    render();
  }
}

function attachAdminHandlers(): void {
  rootEl.querySelectorAll<HTMLButtonElement>(".admin-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.adminTab as AdminTab;
      if (!next || state.admin.tab === next) return;
      state.admin.tab = next;
      state.admin.error = null;
      render();
      void loadAdminTab(next);
    });
  });

  const settingsForm = rootEl.querySelector<HTMLFormElement>("#admin-settings-form");
  if (settingsForm) {
    settingsForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!state.admin.settings) return;
      const data = new FormData(settingsForm);
      const numKeys: (keyof ServerSettings)[] = [
        "maxUsers", "maxWorkspaces", "maxChannelsPerWorkspace",
        "maxMessageBytes", "maxAttachmentBytes",
        "storageQuotaBytes", "messageRetentionDays"
      ];
      const payload: Record<string, unknown> = {};
      for (const k of numKeys) {
        const raw = data.get(String(k));
        if (raw == null) continue;
        const v = Number(raw);
        if (Number.isFinite(v) && v >= 0) payload[k] = v;
      }
      payload.registrationOpen = data.get("registrationOpen") === "on";
      state.admin.settingsSaving = true;
      state.admin.settingsError = null;
      render();
      try {
        state.admin.settings = await httpClient.put<ServerSettings>("/api/v1/server/settings", payload);
        state.admin.settingsDraft = null;
      } catch (err) {
        state.admin.settingsError = describeError(err);
      } finally {
        state.admin.settingsSaving = false;
        render();
      }
    });
  }

  const searchInput = rootEl.querySelector<HTMLInputElement>("#admin-users-search");
  if (searchInput) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    searchInput.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      const value = searchInput.value;
      timer = setTimeout(() => {
        state.admin.usersQuery = value;
        void loadAdminUsers();
      }, 250);
    });
  }

  rootEl.querySelectorAll<HTMLButtonElement>(".admin-user-action").forEach((btn) => {
    btn.addEventListener("click", () => {
      const userId = btn.dataset.user;
      const action = btn.dataset.action;
      if (!userId || !action) return;
      void runAdminUserAction(userId, action);
    });
  });

  rootEl.querySelector<HTMLButtonElement>("#admin-metrics-refresh")?.addEventListener("click", () => {
    void loadAdminMetrics();
  });

  rootEl.querySelector<HTMLButtonElement>("#admin-retention-run")?.addEventListener("click", () => {
    if (!window.confirm("Запустить очистку по retention-политике? Старые сообщения и orphan-файлы будут удалены безвозвратно.")) return;
    void runRetentionSweep();
  });
}

async function runRetentionSweep(): Promise<void> {
  state.admin.retentionRunning = true;
  state.admin.error = null;
  render();
  try {
    state.admin.retentionLast = await httpClient.post<RetentionStats>("/api/v1/server/retention/run", {});
    await loadAdminMetrics();
  } catch (err) {
    state.admin.error = describeError(err);
  } finally {
    state.admin.retentionRunning = false;
    render();
  }
}

async function runAdminUserAction(userId: string, action: string): Promise<void> {
  try {
    if (action === "ban") {
      const reason = window.prompt("Причина бана (необязательно):", "") ?? "";
      await httpClient.post(`/api/v1/server/users/${userId}/ban`, reason ? { reason } : {});
    } else if (action === "unban") {
      await httpClient.post(`/api/v1/server/users/${userId}/unban`, {});
    } else if (action === "delete") {
      if (!window.confirm("Удалить пользователя? Действие необратимо.")) return;
      await httpClient.del(`/api/v1/server/users/${userId}`);
    } else {
      return;
    }
    await loadAdminUsers();
  } catch (err) {
    state.admin.error = describeError(err);
    render();
  }
}

// ============================================================
// D.4 — Channel permission overrides
// ============================================================

function renderChannelSettingsModal(): string {
  const cs = state.channelSettings;
  const channel = state.channels.find((c) => c.id === cs.channelId);
  const title = channel
    ? `Настройки · ${channel.isPrivate ? "🔒" : "#"} ${escapeHtml(channel.name)}`
    : "Настройки канала";
  const body = (() => {
    if (cs.loading) return `<div class="search-empty">Загрузка…</div>`;
    if (!cs.data) return `<div class="search-empty">Нет данных</div>`;
    return renderChannelPermissionsTable();
  })();
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide channel-settings-modal" role="dialog">
        <div class="modal-header">
          <h3>${title}</h3>
          <div class="modal-header-actions">
            <button class="ghost modal-close-btn" data-modal-close>✕</button>
          </div>
        </div>
        ${cs.error ? `<div class="admin-error">${escapeHtml(cs.error)}</div>` : ""}
        <div class="modal-body">${body}</div>
      </div>
    </div>
  `;
}

function renderChannelPermissionsTable(): string {
  const cs = state.channelSettings;
  if (!cs.data) return "";
  const { actions, roles } = cs.data;
  const cs2 = cs;
  const head = `<tr>
    <th class="perm-action-col">Действие</th>
    ${roles.map((r) => `<th>${escapeHtml(ROLE_LABELS_RU[r] ?? r)}</th>`).join("")}
  </tr>`;
  const body = actions.map((a) => {
    const label = ACTION_LABELS_RU[a] ?? a;
    const cells = roles.map((role) => {
      const value = cs2.draft[role]?.[a] ?? "inherit";
      return `
        <td>
          <select class="perm-select" data-role="${role}" data-action="${escapeHtml(a)}">
            <option value="inherit" ${value === "inherit" ? "selected" : ""}>Наследовать</option>
            <option value="grant" ${value === "grant" ? "selected" : ""}>Разрешить</option>
            <option value="deny" ${value === "deny" ? "selected" : ""}>Запретить</option>
          </select>
        </td>
      `;
    }).join("");
    return `<tr><td class="perm-action-col">${escapeHtml(label)}</td>${cells}</tr>`;
  }).join("");
  return `
    <div class="perm-help">
      «Наследовать» оставляет право от workspace-роли. «Разрешить» даёт право,
      даже если базовая роль его не имеет. «Запретить» отнимает.
      Owner не подчиняется overrides.
    </div>
    <table class="perm-table">
      <thead>${head}</thead>
      <tbody>${body}</tbody>
    </table>
    <div class="admin-actions">
      <button id="channel-perm-save" class="primary" ${cs.saving ? "disabled" : ""}>
        ${cs.saving ? "Сохраняю…" : "Сохранить"}
      </button>
    </div>
  `;
}

async function loadChannelPermissions(): Promise<void> {
  const cs = state.channelSettings;
  if (!cs.channelId) return;
  try {
    const data = await httpClient.get<ChannelPermissionsView>(`/api/v1/channels/${cs.channelId}/permissions`);
    state.channelSettings.data = data;
    state.channelSettings.draft = buildDraftFromOverrides(data);
    state.channelSettings.loading = false;
    state.channelSettings.error = null;
  } catch (err) {
    state.channelSettings.loading = false;
    state.channelSettings.error = describeError(err);
  }
  render();
}

function buildDraftFromOverrides(data: ChannelPermissionsView): Record<string, Record<string, "inherit" | "grant" | "deny">> {
  const draft: Record<string, Record<string, "inherit" | "grant" | "deny">> = {};
  for (const role of data.roles) {
    draft[role] = {};
    for (const action of data.actions) {
      draft[role][action] = "inherit";
    }
  }
  for (const ov of data.overrides) {
    if (!draft[ov.roleCode]) continue;
    for (const a of ov.granted) draft[ov.roleCode][a] = "grant";
    for (const a of ov.denied) draft[ov.roleCode][a] = "deny";
  }
  return draft;
}

function draftToOverrides(): RoleOverride[] {
  const out: RoleOverride[] = [];
  const draft = state.channelSettings.draft;
  for (const role of Object.keys(draft)) {
    const granted: string[] = [];
    const denied: string[] = [];
    for (const action of Object.keys(draft[role])) {
      const v = draft[role][action];
      if (v === "grant") granted.push(action);
      else if (v === "deny") denied.push(action);
    }
    if (granted.length === 0 && denied.length === 0) continue;
    out.push({ roleCode: role, granted, denied });
  }
  return out;
}

function attachChannelSettingsHandlers(): void {
  // <select> меняем напрямую в state.channelSettings.draft без render(),
  // чтобы фокус и позиция скролла в модалке не дёргались.
  rootEl.querySelectorAll<HTMLSelectElement>(".perm-select").forEach((sel) => {
    sel.addEventListener("change", () => {
      const role = sel.dataset.role;
      const action = sel.dataset.action;
      if (!role || !action) return;
      const value = sel.value as "inherit" | "grant" | "deny";
      if (!state.channelSettings.draft[role]) state.channelSettings.draft[role] = {};
      state.channelSettings.draft[role][action] = value;
    });
  });

  rootEl.querySelector<HTMLButtonElement>("#channel-perm-save")?.addEventListener("click", () => {
    void saveChannelPermissions();
  });
}

async function saveChannelPermissions(): Promise<void> {
  const cs = state.channelSettings;
  if (!cs.channelId) return;
  state.channelSettings.saving = true;
  state.channelSettings.error = null;
  render();
  try {
    const data = await httpClient.put<ChannelPermissionsView>(
      `/api/v1/channels/${cs.channelId}/permissions`,
      { overrides: draftToOverrides() }
    );
    state.channelSettings.data = data;
    state.channelSettings.draft = buildDraftFromOverrides(data);
    state.status = "Права канала сохранены";
  } catch (err) {
    state.channelSettings.error = describeError(err);
  } finally {
    state.channelSettings.saving = false;
    render();
  }
}
