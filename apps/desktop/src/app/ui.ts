import type { CallManager, CallSnapshot } from "../call/callManager";
import type { VoiceChannelManager, VoiceSnapshot } from "../call/voiceChannelManager";
import type { ApiError, HttpClient } from "../network/httpClient";
import type { RealtimeClient, RealtimeEvent } from "../realtime/realtimeClient";
import { icon } from "./icons";
import type { ScreenShareQuality } from "../call/voiceChannelManager";
import { clearStoredServerUrl, getStoredServerUrl, isProductionShell } from "./serverConfig";

// Backend параллельно принимает до 10 (см. parseAttachmentIDs в message/module.go).
const MAX_ATTACHMENTS = 10;

// setTransientStatus — статусная подсказка (например, «Иконка обновлена»),
// которая сама исчезает через 3.5с. Без этого надписи зависают пока не
// случится следующее обновление state.
let _statusTimer: ReturnType<typeof setTimeout> | null = null;
function setTransientStatus(msg: string): void {
  state.status = msg;
  if (_statusTimer) clearTimeout(_statusTimer);
  _statusTimer = setTimeout(() => {
    if (state.status === msg) {
      state.status = "";
      render();
    }
    _statusTimer = null;
  }, 3500);
  render();
}

// Draft per-channel в localStorage. Незавершённый текст переживает
// переключение каналов и refresh. Чистится при успешной отправке.
const DRAFT_KEY_PREFIX = "rucord:draft:";
function loadDraft(channelId: string | null | undefined): string {
  if (!channelId) return "";
  try {
    return localStorage.getItem(DRAFT_KEY_PREFIX + channelId) ?? "";
  } catch {
    return "";
  }
}
function saveDraft(channelId: string | null | undefined, value: string): void {
  if (!channelId) return;
  try {
    if (value) localStorage.setItem(DRAFT_KEY_PREFIX + channelId, value);
    else localStorage.removeItem(DRAFT_KEY_PREFIX + channelId);
  } catch {}
}

// H.8: presenceMode — выбранный юзером режим. "online"/"idle"/"dnd"/
// "invisible". Для других юзеров invisible маскируется на бэке как
// "offline" (см. effective_mode). У state.me хранится реальный режим.
type PresenceMode = "online" | "idle" | "dnd" | "invisible" | "offline";

interface Me {
  id: string;
  email: string;
  username: string;
  displayName?: string;
  isRoot?: boolean;
  avatarMediaId?: string;
  presenceMode?: PresenceMode;
  customStatus?: string;
}

interface Workspace {
  id: string;
  slug: string;
  name: string;
  ownerId: string;
  role?: string;
  avatarMediaId?: string;
  welcomeChannelId?: string;
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
  userIds?: string[];
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

// H.9: kind — 'user' (дефолт; обычное сообщение) или 'system_*' (плашки).
// Старые сервера до миграции 22 поле не возвращают; считаем тогда 'user'.
type MessageKind = "user" | "system_join" | "system_call" | "system_channel_event";

interface Message {
  id: string;
  channelId: string;
  authorId: string;
  body: string;
  kind?: MessageKind;
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
  online?: boolean;
  avatarMediaId?: string;
  presenceMode?: PresenceMode;
  customStatus?: string;
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

// G.8: личные сообщения. peer — то же, что приходит из бэка (peerView).
// Online/presence маскируется на бэке (invisible → offline).
interface DMPeer {
  userId: string;
  username: string;
  displayName?: string;
  online: boolean;
  avatarMediaId?: string;
  presenceMode?: PresenceMode;
  customStatus?: string;
}

interface DMItem {
  channelId: string;
  peer: DMPeer;
  createdAt: string;
  lastMessageAt?: string;
  unreadCount: number;
}

type ModalKind = "profile" | "members" | "audit" | "search" | "notifications" | "admin" | "channelSettings" | "workspaceRoles" | "welcomeChannel" | "createChannel" | "workspaceSettings" | "userProfile" | null;

// H.10: workspaceSettings — модалка с табами Обзор/Welcome/Роли/Удалить.
// Для не-owner'а вкладка «Удалить» скрыта (permission.WorkspaceDelete
// выдаётся только owner-роли).
type WorkspaceSettingsTab = "overview" | "welcome" | "roles" | "delete";

interface WorkspaceSettingsState {
  workspaceId: string | null;
  tab: WorkspaceSettingsTab;
  draftName: string;
  saving: boolean;
  error: string | null;
  // typed-confirm: имя воркспейса должно быть набрано точно, чтобы
  // активировалась кнопка «Удалить» (anti-mistake).
  deleteTyped: string;
  // PATCH /welcome-channel редактируется отдельно — без отдельного draft'а,
  // потому что save идёт сразу при смене <select>.
  welcomeSaving: boolean;
}

// H.6: state модалки создания канала. roles загружается лениво (GET
// /workspaces/{ws}/roles) при открытии для приватного канала. На submit:
// POST /workspaces/{ws}/channels, и если приватный + выбраны роли —
// PUT /channels/{id}/permissions с granted=['channel.view'].
interface CreateChannelState {
  workspaceId: string | null;
  kind: "text" | "voice";
  name: string;
  isPrivate: boolean;
  selectedRoles: Set<string>;
  roles: WorkspaceRole[];
  rolesLoading: boolean;
  saving: boolean;
  error: string | null;
}

interface WorkspaceRole {
  id: string;
  workspaceId: string;
  code: string;
  name: string;
  color?: string;
  position: number;
  hoisted: boolean;
  baseActionMask: string[];
  system: boolean;
  memberUserIds: string[];
}

interface WorkspaceRoleDraft {
  name: string;
  color: string;
  position: number;
  hoisted: boolean;
  baseActionMask: string[];
}

interface WorkspaceRolesState {
  workspaceId: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  roles: WorkspaceRole[];
  selectedRoleId: string | null;
  draft: WorkspaceRoleDraft | null;
}

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
  "channel.create": "Создавать каналы",
  "channel.update": "Изменять канал",
  "channel.delete": "Удалять каналы",
  "channel.manage_members": "Управлять участниками канала",
  "message.moderate": "Модерировать чужие сообщения",
  "invite.manage": "Управлять инвайтами",
  "audit.read": "Читать журнал событий",
  "member.manage_role": "Менять роли участников",
  "member.kick": "Кикать участников",
  "workspace.update": "Изменять воркспейс"
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
  workspaceRoles: WorkspaceRolesState;
  // H.7: цвета ролей текущего воркспейса. Загружается параллельно с
  // members при selectWorkspace и после save в roles-модалке. Ключ —
  // role.code, значение — color (null если не задан). Если ничего не
  // загружено / роль не найдена — fallback к хардкод-палитре в
  // getRoleColor() (для отображения до окончания загрузки).
  roleColors: Record<string, string | null>;
  // Контекстное меню канала: ПКМ на элементе списка → плавающее меню
  // (Переименовать / Удалить / Скопировать ID). null = меню закрыто.
  channelMenu: { channelId: string; x: number; y: number } | null;
  workspaceMenu: { workspaceId: string; x: number; y: number } | null;
  // Volume per-remote: ключ — sessionId участника voice-канала либо
  // спец-ключ "call-remote" для 1-к-1 собеседника. Значение 0..1, при
  // отсутствии ключа применяем 1 (default). Хранится в памяти, на
  // refresh сбрасывается — соответствует ожиданию Discord.
  voiceVolumes: Record<string, number>;
  // Popup управления громкостью: ПКМ на чужом voice-tile.
  voiceVolumeMenu: { key: string; label: string; x: number; y: number } | null;
  // H.8: попап под avatar'ом в user-strip. Открывается на клик кнопки
  // статуса; содержит радиокнопки per-mode + поле customStatus.
  statusMenu: { x: number; y: number; draftMode: PresenceMode; draftCustom: string } | null;
  auditFilter: { action: string; actor: string };
  // Правая панель участников (Discord-style). На широких экранах открыта
  // по умолчанию, кнопка в channel-header сворачивает.
  memberSidebarOpen: boolean;
  userProfileTarget: string | null;
  // Клиентский mute каналов: Set channelId. Подавляет browser-notification
  // и unread-индикатор для канала. Не персистится на бэке (MVP) —
  // на refresh сбрасывается, как в Discord-default-state до сохранения.
  mutedChannels: Set<string>;
  // Пресет качества демонстрации экрана. Применяется при следующем
  // toggleScreenShare; меняется через `<select>` рядом с кнопкой
  // «Поделиться экраном». Персистится в localStorage.
  screenShareQuality: ScreenShareQualityKey;
  // G.8: личные сообщения. dmMode переключает ch-panel между списком
  // каналов воркспейса и списком DM. dms — список DM (channelId+peer
  // +unread+lastMessageAt). dmFindQuery — фильтр в home-экране DM.
  // dmUnreadTotal — для badge на DM-rail-иконке.
  dmMode: boolean;
  dms: DMItem[];
  dmsLoading: boolean;
  dmFindQuery: string;
  dmFindError: string | null;
  dmOpening: boolean;
  dmUnreadTotal: number;
  // H.6: модалка создания канала (заменила window.prompt).
  createChannel: CreateChannelState;
  // H.10: модалка настроек воркспейса (шестерёнка в ch-panel-header).
  workspaceSettings: WorkspaceSettingsState;
  // G.10: профиль-модалка в Discord-стиле. profileEdit определяет какое
  // поле в режиме inline-edit (null = просмотр). Все draft'ы / ошибка
  // живут тут, а не в отдельной модалке-форме — UI остаётся одной картой.
  profileEdit: ProfileEditState;
}

interface ProfileEditState {
  field: "displayName" | "password" | null;
  draftDisplayName: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  saving: boolean;
  error: string | null;
  // one-shot status под кнопкой сохранения (например, «Пароль обновлён»),
  // живёт до следующего открытия редактора или закрытия модалки.
  okMessage: string | null;
}

export type ScreenShareQualityKey = "720p30" | "1080p30" | "1080p60" | "1440p30";

export const SCREEN_SHARE_PRESETS: Record<ScreenShareQualityKey, ScreenShareQuality> = {
  "720p30":  { width: 1280, height: 720,  frameRate: 30, maxBitrate: 2_500_000 },
  "1080p30": { width: 1920, height: 1080, frameRate: 30, maxBitrate: 5_000_000 },
  "1080p60": { width: 1920, height: 1080, frameRate: 60, maxBitrate: 8_000_000 },
  "1440p30": { width: 2560, height: 1440, frameRate: 30, maxBitrate: 10_000_000 }
};

const SCREEN_SHARE_QUALITY_LS = "rucord:screenShareQuality";

function loadScreenShareQuality(): ScreenShareQualityKey {
  try {
    const v = localStorage.getItem(SCREEN_SHARE_QUALITY_LS);
    if (v && v in SCREEN_SHARE_PRESETS) return v as ScreenShareQualityKey;
  } catch { /* ignore */ }
  return "1080p30";
}

interface VoicePeekParticipant {
  userId: string;
  sessionId: string;
  username: string;
  displayName?: string;
  joinedAt: string;
  screenSharing?: boolean;
  cameraOn?: boolean;
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
  },
  workspaceRoles: {
    workspaceId: null,
    loading: false,
    saving: false,
    error: null,
    roles: [],
    selectedRoleId: null,
    draft: null
  },
  roleColors: {},
  channelMenu: null,
  workspaceMenu: null,
  voiceVolumes: {},
  voiceVolumeMenu: null,
  statusMenu: null,
  auditFilter: { action: "", actor: "" },
  memberSidebarOpen: true,
  userProfileTarget: null,
  mutedChannels: new Set(),
  screenShareQuality: loadScreenShareQuality(),
  dmMode: false,
  dms: [],
  dmsLoading: false,
  dmFindQuery: "",
  dmFindError: null,
  dmOpening: false,
  dmUnreadTotal: 0,
  createChannel: {
    workspaceId: null,
    kind: "text",
    name: "",
    isPrivate: false,
    selectedRoles: new Set(),
    roles: [],
    rolesLoading: false,
    saving: false,
    error: null
  },
  workspaceSettings: {
    workspaceId: null,
    tab: "overview",
    draftName: "",
    saving: false,
    error: null,
    deleteTyped: "",
    welcomeSaving: false
  },
  profileEdit: {
    field: null,
    draftDisplayName: "",
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
    saving: false,
    error: null,
    okMessage: null
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

// GIF play-on-hover для ws-rail: статичный first-frame блоба, нарисованный
// в canvas и сохранённый как data:URL. По default используем его в <img>,
// на hover свапаем src на анимированный blob URL. Только для ws-rail-icon;
// в чате/member-sidebar gif играется всегда (юзер уже смотрит).
const gifStaticCache = new Map<string, string>();
function insertWsRailImg(slot: HTMLButtonElement, animatedUrl: string, staticUrl?: string): void {
  const def = staticUrl ?? animatedUrl;
  const escAnim = escapeHtml(animatedUrl);
  const escDef = escapeHtml(def);
  slot.insertAdjacentHTML(
    "afterbegin",
    `<img class="ws-rail-img" src="${escDef}" data-anim-src="${escAnim}" data-static-src="${escDef}" alt="" />`
  );
}

function extractFirstFrame(blob: Blob, blobUrl: string): Promise<string | null> {
  if (blob.type !== "image/gif") return Promise.resolve(null);
  return new Promise<string | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth || 64;
        c.height = img.naturalHeight || 64;
        const ctx = c.getContext("2d");
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(img, 0, 0);
        resolve(c.toDataURL("image/png"));
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = blobUrl;
  });
}

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

  installGlobalKeyboardShortcuts();
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
        notificationsUnread: 0,
        dmMode: false,
        dms: [],
        dmUnreadTotal: 0,
        dmFindQuery: "",
        dmFindError: null
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
    void loadDMs();
    void requestBrowserNotificationPermission();
    startIdleAutoDetect();
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
  state.roleColors = {};
  render();
  const data = await httpClient.get<{ items: Channel[] }>(`/api/v1/workspaces/${id}/channels`);
  state.channels = data.items ?? [];
  // Резолвинг authorId → имя в сообщениях. Не блокируем загрузку каналов.
  void loadMembers();
  void loadUnread(id);
  void loadRoleColors(id);
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
  // G.8: если это DM — обнулим unread на айтеме и пересчитаем total для badge.
  const dmIdx = state.dms.findIndex((d) => d.channelId === id);
  if (dmIdx >= 0) {
    const next = state.dms.slice();
    next[dmIdx] = { ...next[dmIdx], unreadCount: 0 };
    state.dms = next;
    state.dmUnreadTotal = state.dms.reduce((acc, d) => acc + (d.unreadCount ?? 0), 0);
  }
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

// G.8: загрузка DM-листа. Зовётся на bootstrap и при входе в DM-режим
// (чтобы освежить lastMessageAt/unread, если что-то пришло пока юзер был в ws).
async function loadDMs(): Promise<void> {
  state.dmsLoading = true;
  try {
    const data = await httpClient.get<{ items: DMItem[] }>("/api/v1/dm");
    state.dms = (data.items ?? []).map((d) => ({
      ...d,
      unreadCount: d.channelId === state.selectedChannelId ? 0 : d.unreadCount
    }));
    state.dmUnreadTotal = state.dms.reduce((acc, d) => acc + (d.unreadCount ?? 0), 0);
  } catch (err) {
    state.status = describeError(err);
  } finally {
    state.dmsLoading = false;
    render();
  }
}

// Find-or-create DM с пиром (по userId или username). На успех — открыть
// канал. backend идемпотентен, повторный вызов вернёт существующий.
async function openDMWith(req: { userId?: string; username?: string }): Promise<void> {
  if (state.dmOpening) return;
  state.dmOpening = true;
  state.dmFindError = null;
  render();
  try {
    const dm = await httpClient.post<DMItem>("/api/v1/dm", req);
    // upsert в state.dms
    const idx = state.dms.findIndex((d) => d.channelId === dm.channelId);
    if (idx < 0) {
      state.dms = [dm, ...state.dms];
    } else {
      const next = state.dms.slice();
      next[idx] = { ...dm, unreadCount: 0 };
      state.dms = next;
    }
    state.dmMode = true;
    state.dmFindQuery = "";
    await selectChannel(dm.channelId);
  } catch (err) {
    state.dmFindError = describeError(err);
    render();
  } finally {
    state.dmOpening = false;
    render();
  }
}

// Переключение в DM-режим (клик на «домик» над ws-rail). Не сбрасываем
// selectedChannelId — он может указывать на DM-канал (тогда сразу его
// откроем). Иначе остаёмся на home-экране со списком DM.
function enterDMMode(): void {
  state.dmMode = true;
  state.dmFindError = null;
  // Если selectedChannelId указывает на workspace-канал — сбросим выбор,
  // чтобы content показал home-экран DM (а не сообщения чужого канала).
  const isDmChannel = state.dms.some((d) => d.channelId === state.selectedChannelId);
  if (!isDmChannel) {
    state.selectedChannelId = null;
    state.messages = [];
  }
  render();
  void loadDMs();
}

function exitDMMode(workspaceId: string): void {
  state.dmMode = false;
  state.dmFindError = null;
  void selectWorkspace(workspaceId);
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
  // H.8: DnD — пользователь явно попросил не беспокоить. Подавляем
  // системные popup'ы. Badge + dropdown в UI всё равно обновятся.
  if (state.me?.presenceMode === "dnd") return;
  // Замьюченный канал — не дёргаем системное уведомление даже на mention.
  // Звонки (call_incoming) приходят без channelId, их не глушим.
  const chId = item.payload.channelId;
  if (chId && state.mutedChannels.has(chId)) return;
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

// H.8: PUT /users/me/status. mode="online" + custom="" → сброс к дефолту.
async function saveStatus(mode: PresenceMode, customStatus: string): Promise<void> {
  try {
    const updated = await httpClient.put<{ presenceMode?: PresenceMode; customStatus?: string }>(
      "/api/v1/users/me/status",
      { mode, customStatus }
    );
    if (state.me) {
      state.me.presenceMode = (updated.presenceMode as PresenceMode | undefined) ?? mode;
      state.me.customStatus = updated.customStatus ?? "";
    }
    // H.8.i: сбрасываем флаг автоматически выставленного idle когда юзер
    // (или мы сами) уводит mode прочь от idle. Иначе idleAutoSet может
    // протечь через ручные переключения, и activity-handler ложно сочтёт
    // следующий manual-idle нашим.
    if (mode !== "idle") {
      idleAutoSet = false;
    }
    state.statusMenu = null;
    render();
  } catch (err) {
    state.status = describeError(err);
    render();
  }
}

// H.8.i: idle auto-detect. После 5 минут без mousemove/keydown/click
// клиент сам переводит presence в "idle" (если юзер был "online"). На
// первый input — возвращает в "online", но только если idle поставили
// мы автоматически (idleAutoSet=true). Если юзер вручную выбрал idle/
// dnd/invisible — не трогаем; auto-режим работает только в паре
// online↔idle.
const IDLE_THRESHOLD_MS = 5 * 60_000;
const IDLE_CHECK_INTERVAL_MS = 30_000;
let idleLastActivity = Date.now();
let idleAutoSet = false;
let idleTimer: ReturnType<typeof setInterval> | null = null;
let idleListenersAttached = false;

// Глобальные хоткеи: Esc закрывает модалку/выпадайки, Ctrl+K / Cmd+K
// открывает поиск в текущем воркспейсе (Discord/Slack-pattern).
let globalShortcutsInstalled = false;
function installGlobalKeyboardShortcuts(): void {
  if (globalShortcutsInstalled) return;
  globalShortcutsInstalled = true;
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      // Не глушим если Esc нужен внутреннему контролу (mention-popup и пр.
      // вешают свой listener на сам input и вызывают preventDefault).
      if (state.statusMenu) {
        state.statusMenu = null;
        render();
        return;
      }
      if (state.channelMenu) {
        state.channelMenu = null;
        render();
        return;
      }
      if (state.workspaceMenu) {
        state.workspaceMenu = null;
        render();
        return;
      }
      if (state.modal) {
        state.modal = null;
        state.userProfileTarget = null;
        render();
        return;
      }
    }
    // Ctrl+K / Cmd+K — открыть search-модалку. Игнорится в auth-state.
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "k" || ev.key === "K")) {
      if (!state.me) return;
      if (!state.selectedWorkspaceId) return;
      ev.preventDefault();
      state.modal = "search";
      render();
      // Фокус на инпуте — на следующем тике, когда модалка отрендерилась.
      setTimeout(() => {
        rootEl.querySelector<HTMLInputElement>("#search-input")?.focus();
      }, 0);
    }
  });
}

function startIdleAutoDetect(): void {
  if (idleListenersAttached) return;
  idleListenersAttached = true;
  const onActivity = () => {
    idleLastActivity = Date.now();
    // Если мы сами выставили idle ранее — возвращаем online на любой ввод.
    if (idleAutoSet && state.me?.presenceMode === "idle") {
      idleAutoSet = false;
      void saveStatus("online", state.me.customStatus ?? "");
    }
  };
  window.addEventListener("mousemove", onActivity, { passive: true });
  window.addEventListener("mousedown", onActivity, { passive: true });
  window.addEventListener("keydown", onActivity, { passive: true });
  window.addEventListener("touchstart", onActivity, { passive: true });
  window.addEventListener("focus", onActivity);

  if (idleTimer) clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    const me = state.me;
    if (!me) return;
    // Только переход online → idle. dnd/invisible/idle (выставлен вручную)
    // не трогаем, чтобы не перетереть осознанный выбор.
    if (me.presenceMode !== "online") return;
    if (Date.now() - idleLastActivity < IDLE_THRESHOLD_MS) return;
    idleAutoSet = true;
    void saveStatus("idle", me.customStatus ?? "");
  }, IDLE_CHECK_INTERVAL_MS);
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
  // H.8: presence.updated приходит из profile-модуля при PUT /users/me/status.
  // Бэк рассылает по всем воркспейсам автора и его DM-собеседникам;
  // invisible режим маскируется как 'offline'. Обновляем state.members
  // (если автор в текущем ws) и dms (если есть DM с автором).
  if (event.event === "presence.updated") {
    const p = event.payload as { userId: string; mode: PresenceMode; customStatus?: string };
    state.members = state.members.map((m) =>
      m.userId === p.userId
        ? { ...m, presenceMode: p.mode, online: p.mode !== "offline", customStatus: p.customStatus ?? "" }
        : m
    );
    // G.8 + H.8.iv: синхронизация peer-присутствия в DM-списке. Бэк
    // публикует presence.updated по DM-собеседникам через UserID-fanout,
    // так что для всех DM с этим юзером надо обновить дот и customStatus.
    state.dms = state.dms.map((d) =>
      d.peer.userId === p.userId
        ? {
            ...d,
            peer: {
              ...d.peer,
              presenceMode: p.mode,
              online: p.mode !== "offline",
              customStatus: p.customStatus ?? ""
            }
          }
        : d
    );
    render();
    return;
  }
  // Каналы (create/update/delete) приходят с workspaceID-routing'ом и
  // ChannelID, но могут адресовать любой канал воркспейса — обрабатываем
  // ДО фильтра по selectedChannelId, чтобы пришедший в фон новый канал
  // тоже попал в sidebar.
  if (event.event === "channel.created") {
    const ch = event.payload as Channel;
    if (ch.workspaceId !== state.selectedWorkspaceId) return;
    if (state.channels.some((c) => c.id === ch.id)) return;
    state.channels = [...state.channels, ch];
    render();
    return;
  }
  if (event.event === "channel.updated") {
    const ch = event.payload as Channel;
    if (ch.workspaceId !== state.selectedWorkspaceId) return;
    state.channels = state.channels.map((c) => (c.id === ch.id ? ch : c));
    render();
    return;
  }
  if (event.event === "channel.deleted") {
    const p = event.payload as { channelId: string; workspaceId: string };
    if (p.workspaceId !== state.selectedWorkspaceId) return;
    state.channels = state.channels.filter((c) => c.id !== p.channelId);
    if (state.selectedChannelId === p.channelId) {
      state.selectedChannelId = null;
      state.messages = [];
    }
    delete state.unread[p.channelId];
    render();
    return;
  }
  // G.8: dm.opened — фан-аут обоим участникам при создании DM (см.
  // publishDMOpened на бэке). Если у нас в state.dms ещё нет канала —
  // тянем свежий список (с peer.username/displayName/avatarMediaId).
  if (event.event === "dm.opened") {
    const p = event.payload as { channelId: string };
    if (!state.dms.some((d) => d.channelId === p.channelId)) {
      void loadDMs();
    }
    return;
  }
  // C.5: события для не-активных каналов обрабатываем отдельно (unread).
  if (event.channelId && event.channelId !== state.selectedChannelId) {
    if (event.event === "message.created") {
      const msg = event.payload as Message;
      // Замьюченный канал — не инкрементим unread (Discord-like: канал
      // в списке остаётся серым, без badge'а). Mentions всё равно приходят
      // через notification.created, обрабатываются выше.
      if (msg.authorId !== state.me?.id && !state.mutedChannels.has(event.channelId)) {
        state.unread[event.channelId] = (state.unread[event.channelId] ?? 0) + 1;
        // G.8: если канал — DM, синхронно обновим DMItem (unread + lastMessageAt)
        // и перечитаем суммарный counter для badge на DM-rail-иконке.
        const dmIdx = state.dms.findIndex((d) => d.channelId === event.channelId);
        if (dmIdx >= 0) {
          const next = state.dms.slice();
          next[dmIdx] = {
            ...next[dmIdx],
            unreadCount: (next[dmIdx].unreadCount ?? 0) + 1,
            lastMessageAt: msg.createdAt
          };
          state.dms = next;
          state.dmUnreadTotal = state.dms.reduce((acc, d) => acc + (d.unreadCount ?? 0), 0);
        }
        render();
      } else if (msg.authorId === state.me?.id) {
        // Своё сообщение в фоновом DM — обновляем только lastMessageAt
        // (для сортировки списка), unread не трогаем.
        const dmIdx = state.dms.findIndex((d) => d.channelId === event.channelId);
        if (dmIdx >= 0) {
          const next = state.dms.slice();
          next[dmIdx] = { ...next[dmIdx], lastMessageAt: msg.createdAt };
          state.dms = next;
          render();
        }
      }
    } else if (event.event === "channel.read") {
      const p = event.payload as { userId: string; channelId: string };
      if (p.userId === state.me?.id) {
        state.unread[p.channelId] = 0;
        // G.8: синхронизация DM-айтема (мульти-клиент: прочитал на телефоне).
        const dmIdx = state.dms.findIndex((d) => d.channelId === p.channelId);
        if (dmIdx >= 0) {
          const next = state.dms.slice();
          next[dmIdx] = { ...next[dmIdx], unreadCount: 0 };
          state.dms = next;
          state.dmUnreadTotal = state.dms.reduce((acc, d) => acc + (d.unreadCount ?? 0), 0);
        }
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
  "#admin-user-search",
  "#dm-find-input",
  "#audit-filter-actor"
];

interface InputSnapshot {
  selector: string;
  value: string;
  selStart: number | null;
  selEnd: number | null;
  hadFocus: boolean;
  channelTag: string | null;
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
      hadFocus: document.activeElement === el,
      channelTag: state.selectedChannelId
    });
  }
  return out;
}

function restorePreservedInputs(snapshots: InputSnapshot[]): void {
  for (const snap of snapshots) {
    const el = rootEl.querySelector<HTMLInputElement | HTMLTextAreaElement>(snap.selector);
    if (!el) continue;
    // Composer: при смене канала старый текст не переносим — draft per-channel
    // уже зашит в новый input через value-атрибут (см. loadDraft в renderChannelView).
    const isComposer = snap.selector === '#send-form input[name="body"]';
    const channelChanged = isComposer && snap.channelTag !== state.selectedChannelId;
    if (channelChanged) {
      continue;
    }
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
  const selectedDM = state.dms.find((d) => d.channelId === state.selectedChannelId);
  const selectedWorkspace = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  const canModerate = !!selectedWorkspace && ["owner", "admin", "moderator"].includes(selectedWorkspace.role ?? "");
  const dmMode = state.dmMode;
  // member-sidebar только для workspace-каналов
  const showMembers = !!selectedChannel && state.memberSidebarOpen && !dmMode;

  const dmBadge = state.dmUnreadTotal > 0
    ? `<span class="ws-rail-badge">${state.dmUnreadTotal > 99 ? "99+" : state.dmUnreadTotal}</span>`
    : "";

  rootEl.innerHTML = `
    <div class="shell${showMembers ? " with-members" : ""}">
      <aside class="ws-rail">
        <button id="ws-rail-dm" class="ws-rail-icon ws-rail-home${dmMode ? " active" : ""}" title="Личные сообщения" aria-label="Личные сообщения">
          ${icon("users")}
          ${dmBadge}
        </button>
        <div class="ws-rail-divider"></div>
        ${state.workspaces
          .map((ws) => {
            const active = !dmMode && ws.id === state.selectedWorkspaceId ? " active" : "";
            const mediaAttr = ws.avatarMediaId ? ` data-avatar-media="${escapeHtml(ws.avatarMediaId)}"` : "";
            return `
          <button class="ws-rail-icon${active}" data-ws="${ws.id}"${mediaAttr} title="${escapeHtml(ws.name)}" aria-label="${escapeHtml(ws.name)}">
            <span class="ws-rail-letter">${escapeHtml(ws.name.charAt(0).toUpperCase())}</span>
          </button>
        `;
          })
          .join("")}
        <div class="ws-rail-spacer"></div>
        <button id="ws-rail-create" class="ws-rail-icon ws-rail-add" title="Создать воркспейс" aria-label="Создать воркспейс">+</button>
        <button id="ws-rail-invite" class="ws-rail-icon ws-rail-add" title="Принять инвайт" aria-label="Принять инвайт">↵</button>
      </aside>
      <aside class="ch-panel">
        <header class="ch-panel-header">
          <span class="ch-panel-title">${dmMode ? "Личные сообщения" : (selectedWorkspace ? escapeHtml(selectedWorkspace.name) : "Нет воркспейса")}</span>
          ${!dmMode && selectedWorkspace && ["owner", "admin"].includes(selectedWorkspace.role ?? "")
            ? `<button id="open-ws-settings" class="ghost ch-panel-settings" title="Настройки воркспейса" aria-label="Настройки воркспейса">${icon("settings")}</button>`
            : ""}
        </header>
        <div class="ch-panel-body">
          ${
            dmMode
              ? renderDMSidebarList()
              : `${state.selectedWorkspaceId ? renderChannelsBlock() : `<div class="ch-panel-empty">Выбери воркспейс слева или создай новый кнопкой +.</div>`}
                 ${state.selectedWorkspaceId && canModerate ? renderInvitesBlock() : ""}`
          }
          ${renderVoiceStrip()}
        </div>
        <footer class="user-strip">
          <button id="open-status" class="user user-btn" title="Изменить статус">
            <span class="user-strip-avatar-wrap">
              ${renderAvatar({
                avatarMediaId: me?.avatarMediaId,
                fallbackText: me?.displayName || me?.username || "?",
                sizePx: 32
              })}
              <span class="presence-dot ${presenceDotClass(me?.presenceMode)}"></span>
            </span>
            <div class="user-strip-name">
              <div class="user-name">${escapeHtml(me?.displayName || me?.username || "—")}</div>
              <div class="user-sub">${me?.customStatus ? escapeHtml(me.customStatus) : presenceLabel(me?.presenceMode)}</div>
            </div>
          </button>
          <div class="user-strip-actions">
            ${renderBellButton()}
            ${me?.isRoot ? `<button id="open-admin" class="ghost" title="Админ-панель" aria-label="Админ-панель">${icon("shield")}</button>` : ""}
            <button id="open-profile" class="ghost" title="Настройки" aria-label="Настройки">${icon("settings")}</button>
          </div>
        </footer>
      </aside>
      <main class="content">
        ${
          selectedChannel
            ? renderChannelView(selectedChannel)
            : selectedDM
              ? renderDMChannelView(selectedDM)
              : dmMode
                ? renderDMHome()
                : renderEmpty()
        }
      </main>
      ${showMembers ? renderMemberSidebar() : ""}
      ${state.status ? `<div class="status-bar">${escapeHtml(state.status)}</div>` : ""}
      ${renderModal()}
      ${renderCallOverlay()}
      ${renderChannelMenu()}
      ${renderWorkspaceMenu()}
      ${renderVoiceVolumeMenu()}
      ${renderStatusMenu()}
    </div>
  `;
  attachShellHandlers();
  attachVoiceVideoStreams();
}

function renderVoiceVolumeMenu(): string {
  const menu = state.voiceVolumeMenu;
  if (!menu) return "";
  const current = Math.round((state.voiceVolumes[menu.key] ?? 1) * 100);
  return `
    <div class="channel-menu-backdrop" data-voice-volume-close></div>
    <div class="voice-volume-menu" style="left:${menu.x}px;top:${menu.y}px;" role="menu">
      <div class="channel-menu-header">${escapeHtml(menu.label)}</div>
      <label class="voice-volume-row">
        <span class="voice-volume-label">Громкость</span>
        <span class="voice-volume-value">${current}%</span>
      </label>
      <input
        id="voice-volume-slider"
        type="range"
        min="0"
        max="200"
        step="1"
        value="${current}"
        class="voice-volume-slider"
      />
      <div class="voice-volume-hint">Перетащи или нажми Reset чтобы вернуть 100%</div>
      <button class="channel-menu-item" data-voice-volume-reset>Reset до 100%</button>
    </div>
  `;
}

// H.8: цвет точки/метка для presence-mode. Для отсутствующего значения
// (старые серверы без миграции 21) считаем "online" если есть active
// session, иначе "offline" — поведение совпадает с pre-H.8.
function presenceDotClass(mode: PresenceMode | undefined | null): string {
  switch (mode) {
    case "online":
      return "presence-online";
    case "idle":
      return "presence-idle";
    case "dnd":
      return "presence-dnd";
    case "invisible":
    case "offline":
      return "presence-offline";
    default:
      return "presence-online";
  }
}

function presenceLabel(mode: PresenceMode | undefined | null): string {
  switch (mode) {
    case "online":
      return "В сети";
    case "idle":
      return "Неактивен";
    case "dnd":
      return "Не беспокоить";
    case "invisible":
      return "Невидимый";
    case "offline":
      return "Не в сети";
    default:
      return "В сети";
  }
}

const PRESENCE_OPTIONS: { mode: PresenceMode; label: string; hint: string }[] = [
  { mode: "online", label: "В сети", hint: "Виден как онлайн" },
  { mode: "idle", label: "Неактивен", hint: "Жёлтая точка, виден как онлайн" },
  { mode: "dnd", label: "Не беспокоить", hint: "Системные уведомления подавляются" },
  { mode: "invisible", label: "Невидимый", hint: "Другие видят тебя офлайн" }
];

function renderStatusMenu(): string {
  const menu = state.statusMenu;
  if (!menu) return "";
  const options = PRESENCE_OPTIONS.map((opt) => {
    const active = menu.draftMode === opt.mode ? " active" : "";
    return `
      <button class="status-menu-option${active}" data-status-mode="${opt.mode}" role="menuitemradio" aria-checked="${menu.draftMode === opt.mode}">
        <span class="presence-dot ${presenceDotClass(opt.mode)}"></span>
        <span class="status-menu-text">
          <span class="status-menu-label">${escapeHtml(opt.label)}</span>
          <span class="status-menu-hint">${escapeHtml(opt.hint)}</span>
        </span>
      </button>
    `;
  }).join("");
  return `
    <div class="channel-menu-backdrop" data-status-menu-close></div>
    <div class="status-menu" style="left:${menu.x}px;top:${menu.y}px;" role="menu">
      <div class="status-menu-list">${options}</div>
      <div class="status-menu-separator"></div>
      <label class="status-menu-custom">
        <span class="status-menu-custom-label">Кастомный статус</span>
        <input id="status-custom-input" type="text" maxlength="64" placeholder="Например: «Играю в X»" value="${escapeHtml(menu.draftCustom)}" />
      </label>
      <div class="status-menu-actions">
        <button id="status-clear" class="ghost">Очистить</button>
        <button id="status-save" class="primary">Сохранить</button>
      </div>
    </div>
  `;
}

// H.7: цвета ролей. По умолчанию подтягиваем из workspace_roles.color
// (loadRoleColors при выборе ws); хардкод-палитра ниже — fallback пока
// данные не загружены либо для роли не задан color в БД (member-роль
// в seed'е — null). member-роль без цвета остаётся дефолтным --text.
const ROLE_COLORS_FALLBACK: Record<string, string> = {
  owner: "#ed4245",
  admin: "#5865f2",
  moderator: "#3ba55c"
};

function getRoleColor(roleCode: string | undefined | null): string | undefined {
  if (!roleCode) return undefined;
  const live = state.roleColors[roleCode];
  if (live !== undefined) {
    return live ?? undefined; // null → нет цвета, undefined → не загружено
  }
  return ROLE_COLORS_FALLBACK[roleCode];
}

async function loadRoleColors(workspaceId: string): Promise<void> {
  try {
    const data = await httpClient.get<{ items: WorkspaceRole[] }>(`/api/v1/workspaces/${workspaceId}/roles`);
    // Race-guard: ответ устарел если юзер успел переключить воркспейс.
    if (state.selectedWorkspaceId !== workspaceId) return;
    const colors: Record<string, string | null> = {};
    for (const r of data.items ?? []) {
      colors[r.code] = r.color ?? null;
    }
    state.roleColors = colors;
    render();
  } catch {
    // Не критично — fallback к хардкоду в getRoleColor.
  }
}

// H.1: универсальный рендер аватара. Если есть avatarMediaId — слот с
// data-avatar-media, который attachAvatarSlots() лениво наполняет blob-URL'ом
// после рендера (через тот же mediaBlobCache что и для attach-image). Пока
// blob не загружен — внутри буква-плейсхолдер, чтобы не было пустоты.
// fallbackText — первая буква имени; sizePx — диаметр круга.
interface AvatarOpts {
  avatarMediaId?: string;
  fallbackText: string;
  sizePx: number;
  className?: string;
  online?: boolean | null;
}

function renderAvatar(opts: AvatarOpts): string {
  const letter = (opts.fallbackText || "?").charAt(0).toUpperCase();
  const dot = opts.online === undefined || opts.online === null
    ? ""
    : `<span class="avatar-dot${opts.online ? " on" : " off"}"></span>`;
  const cls = `avatar-pic ${opts.className ?? ""}`.trim();
  const style = `width:${opts.sizePx}px;height:${opts.sizePx}px;font-size:${Math.round(opts.sizePx * 0.45)}px;`;
  if (opts.avatarMediaId) {
    return `<span class="${cls} has-media" data-avatar-media="${escapeHtml(opts.avatarMediaId)}" style="${style}"><span class="avatar-letter">${escapeHtml(letter)}</span>${dot}</span>`;
  }
  return `<span class="${cls}" style="${style}"><span class="avatar-letter">${escapeHtml(letter)}</span>${dot}</span>`;
}

function renderMemberSidebar(): string {
  if (state.membersLoading && state.members.length === 0) {
    return `<aside class="member-sidebar"><div class="member-sidebar-empty">Загрузка…</div></aside>`;
  }
  const sorted = [...state.members].sort((a, b) => {
    const an = a.displayName || a.username;
    const bn = b.displayName || b.username;
    return an.localeCompare(bn, "ru");
  });
  const renderItem = (m: Member) => {
    const name = m.displayName || m.username;
    const color = getRoleColor(m.role);
    const style = color ? ` style="color:${color};"` : "";
    const effMode = m.presenceMode ?? (m.online ? "online" : "offline");
    const subline = m.customStatus
      ? `<span class="member-sidebar-status">${escapeHtml(m.customStatus)}</span>`
      : "";
    return `
      <li class="member-sidebar-item${m.online ? "" : " offline"}" data-member-user="${escapeHtml(m.userId)}">
        <span class="member-sidebar-avatar-wrap">
          ${renderAvatar({
            avatarMediaId: m.avatarMediaId,
            fallbackText: name,
            sizePx: 28
          })}
          <span class="presence-dot ${presenceDotClass(effMode)}"></span>
        </span>
        <span class="member-sidebar-body">
          <span class="member-sidebar-name"${style}>${escapeHtml(name)}</span>
          ${subline}
        </span>
      </li>
    `;
  };
  const renderGroup = (label: string, items: Member[]) =>
    items.length === 0
      ? ""
      : `<div class="member-sidebar-group">${escapeHtml(label)} — ${items.length}</div>
         <ul class="member-sidebar-list">${items.map(renderItem).join("")}</ul>`;
  // H.3: жёсткая схема «Owner — Admin — Moderator — В сети — Не в сети» до
  // ввода кастомных ролей (H.5). Hoisted-роли в онлайне идут своими секциями
  // по приоритету; member online — общая «В сети»; все офлайн — одной кучей
  // в «Не в сети» (когда H.5 закроется, hoisted=true роль будет давать
  // отдельную секцию и в офлайне тоже).
  const online = sorted.filter((m) => m.online);
  const offline = sorted.filter((m) => !m.online);
  const owners = online.filter((m) => m.role === "owner");
  const admins = online.filter((m) => m.role === "admin");
  const moderators = online.filter((m) => m.role === "moderator");
  const onlineMembers = online.filter(
    (m) => m.role !== "owner" && m.role !== "admin" && m.role !== "moderator"
  );
  return `
    <aside class="member-sidebar">
      ${renderGroup("Владелец", owners)}
      ${renderGroup("Администраторы", admins)}
      ${renderGroup("Модераторы", moderators)}
      ${renderGroup("В сети", onlineMembers)}
      ${renderGroup("Не в сети", offline)}
      ${state.members.length === 0 ? `<div class="member-sidebar-empty">Никого нет</div>` : ""}
    </aside>
  `;
}

function renderChannelMenu(): string {
  const menu = state.channelMenu;
  if (!menu) return "";
  const ch = state.channels.find((c) => c.id === menu.channelId);
  if (!ch) return "";
  const ws = state.workspaces.find((w) => w.id === ch.workspaceId);
  const canManage = !!ws && ["owner", "admin"].includes(ws.role ?? "");
  const canModerate = !!ws && ["owner", "admin", "moderator"].includes(ws.role ?? "");
  const muted = state.mutedChannels.has(ch.id);
  const hasUnread = (state.unread[ch.id] ?? 0) > 0;
  return `
    <div class="channel-menu-backdrop" data-channel-menu-close></div>
    <div class="channel-menu" style="left:${menu.x}px;top:${menu.y}px;" role="menu">
      <div class="channel-menu-header">${escapeHtml(channelPrefix(ch))} ${escapeHtml(ch.name)}</div>
      ${hasUnread ? `<button class="channel-menu-item" data-channel-action="mark-read" data-id="${ch.id}">Пометить как прочитанное</button>` : ""}
      ${canModerate ? `<button class="channel-menu-item" data-channel-action="invite" data-id="${ch.id}">Пригласить</button>` : ""}
      <button class="channel-menu-item" data-channel-action="mute" data-id="${ch.id}">${muted ? "Снять заглушение" : "Заглушить канал"}</button>
      <div class="channel-menu-separator"></div>
      ${canManage ? `<button class="channel-menu-item" data-channel-action="rename" data-id="${ch.id}">Переименовать</button>` : ""}
      ${canManage ? `<button class="channel-menu-item" data-channel-action="clone" data-id="${ch.id}">Клонировать канал</button>` : ""}
      <button class="channel-menu-item" data-channel-action="copy-id" data-id="${ch.id}">Скопировать ID</button>
      ${canManage ? `<div class="channel-menu-separator"></div><button class="channel-menu-item danger" data-channel-action="delete" data-id="${ch.id}">Удалить канал</button>` : ""}
    </div>
  `;
}

// H.2: ПКМ-меню на иконке воркспейса. Для owner/admin показывает действия
// «Загрузить иконку» / «Удалить иконку», остальным — «Скопировать ID».
function renderWorkspaceMenu(): string {
  const menu = state.workspaceMenu;
  if (!menu) return "";
  const ws = state.workspaces.find((w) => w.id === menu.workspaceId);
  if (!ws) return "";
  const canManage = ["owner", "admin"].includes(ws.role ?? "");
  return `
    <input id="workspace-avatar-input" type="file" accept="image/*" hidden />
    <div class="channel-menu-backdrop" data-workspace-menu-close></div>
    <div class="channel-menu" style="left:${menu.x}px;top:${menu.y}px;" role="menu">
      <div class="channel-menu-header">${escapeHtml(ws.name)}</div>
      ${canManage ? `<button class="channel-menu-item" data-workspace-action="upload-icon" data-id="${ws.id}">${ws.avatarMediaId ? "Сменить иконку" : "Загрузить иконку"}</button>` : ""}
      ${canManage && ws.avatarMediaId ? `<button class="channel-menu-item" data-workspace-action="remove-icon" data-id="${ws.id}">Удалить иконку</button>` : ""}
      ${canManage ? `<button class="channel-menu-item" data-workspace-action="manage-roles" data-id="${ws.id}">Настроить роли…</button>` : ""}
      ${canManage ? `<button class="channel-menu-item" data-workspace-action="welcome-channel" data-id="${ws.id}">Канал приветствия…</button>` : ""}
      <button class="channel-menu-item" data-workspace-action="copy-id" data-id="${ws.id}">Скопировать ID</button>
    </div>
  `;
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
  "workspace.updated": { ru: "изменил воркспейс", icon: "✎" },
  "workspace.member.added": { ru: "добавил участника", icon: "👥" },
  "channel.created": { ru: "создал канал", icon: "📁" },
  "channel.updated": { ru: "изменил канал", icon: "✎" },
  "channel.deleted": { ru: "удалил канал", icon: "🗑" },
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

// Возвращает inline-style="color:..." если у участника есть role-цвет
// (workspace_roles.color через getRoleColor, см. H.7). Иначе пустая
// строка — наследует дефолтный --text.
function authorColorStyle(userId: string): string {
  const m = state.members.find((x) => x.userId === userId);
  if (!m) return "";
  const color = getRoleColor(m.role);
  return color ? ` style="color:${color};"` : "";
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
  const ws = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  const canManage = !!ws && ["owner", "admin"].includes(ws.role ?? "");
  const textChannels = state.channels.filter((ch) => ch.kind === "text");
  const voiceChannels = state.channels.filter((ch) => ch.kind === "voice");
  return `
    ${renderChannelCategory("text", "Текстовые каналы", textChannels, canManage)}
    ${renderChannelCategory("voice", "Голосовые каналы", voiceChannels, canManage)}
  `;
}

function renderChannelCategory(
  kind: "text" | "voice",
  title: string,
  channels: Channel[],
  canManage: boolean
): string {
  const addBtn = canManage
    ? `<button class="ghost ch-category-add" data-create-kind="${kind}" title="Создать канал" aria-label="Создать канал">${icon("plus")}</button>`
    : "";
  const items = channels
    .map((ch) => {
      const unread = state.unread[ch.id] ?? 0;
      const muted = state.mutedChannels.has(ch.id);
      const cls = [
        ch.id === state.selectedChannelId ? "active" : "",
        unread > 0 ? "has-unread" : "",
        muted ? "muted" : ""
      ]
        .filter(Boolean)
        .join(" ");
      const badge = unread > 0 ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>` : "";
      const inlineList = kind === "voice" ? renderVoiceInlineParticipants(ch.id) : "";
      return `
        <li class="${cls}" data-ch="${ch.id}">
          <span class="channel-prefix">${channelPrefix(ch)}</span>
          <span class="channel-name">${escapeHtml(ch.name)}</span>
          ${badge}
        </li>
        ${inlineList}
      `;
    })
    .join("");
  return `
    <div class="section-title ch-category-title">
      <span>${title}</span>
      ${addBtn}
    </div>
    <ul class="channel-list">${items}</ul>
  `;
}

// Discord-style: участники voice-канала видны прямо в sidebar под названием.
// Источник: voiceSnapshot (если ты в этом канале) либо voicePeek (если канал
// выбран как «просмотр»). Для остальных каналов не показываем — для этого
// нужен периодический polling /voice/participants, отложено.
function renderVoiceInlineParticipants(channelId: string): string {
  const voice = state.voiceSnapshot;
  type P = { sessionId: string; userId: string; username?: string; displayName?: string; screenSharing?: boolean };
  let participants: P[] = [];
  let selfSessionId: string | null = null;
  if (voice && voice.channelId === channelId) {
    participants = voice.participants;
    selfSessionId = voice.selfSessionId;
  } else if (state.voicePeek?.channelId === channelId) {
    participants = state.voicePeek.participants;
  }
  if (participants.length === 0) return "";
  const items = participants
    .map((p) => {
      const member = state.members.find((m) => m.userId === p.userId);
      const avatarMediaId = p.userId === state.me?.id ? state.me?.avatarMediaId : member?.avatarMediaId;
      const name = p.displayName?.trim() || p.username || member?.displayName || member?.username || p.userId.slice(0, 8);
      const isSelf = selfSessionId !== null && p.sessionId === selfSessionId;
      const live = !!p.screenSharing || (isSelf && !!voice?.screenSharing);
      return `
        <li class="voice-inline-participant${isSelf ? " self" : ""}" data-voice-jump-user="${escapeHtml(p.userId)}">
          ${renderAvatar({ avatarMediaId, fallbackText: name, sizePx: 24 })}
          <span class="voice-inline-name">${escapeHtml(name)}</span>
          ${live ? `<span class="voice-inline-live">В ЭФИРЕ</span>` : ""}
        </li>
      `;
    })
    .join("");
  return `<ul class="voice-inline-list">${items}</ul>`;
}

// G.8: список DM в ch-panel-body (заменяет renderChannelsBlock в dm-mode).
function renderDMSidebarList(): string {
  if (state.dmsLoading && state.dms.length === 0) {
    return `<div class="ch-panel-empty">Загрузка…</div>`;
  }
  const items = [...state.dms]
    .sort((a, b) => {
      const at = a.lastMessageAt ?? a.createdAt;
      const bt = b.lastMessageAt ?? b.createdAt;
      return bt.localeCompare(at);
    })
    .map((d) => {
      const active = d.channelId === state.selectedChannelId ? " active" : "";
      const unread = d.unreadCount > 0 ? ` has-unread` : "";
      const muted = state.mutedChannels.has(d.channelId) ? " muted" : "";
      const name = d.peer.displayName || d.peer.username;
      const badge = d.unreadCount > 0
        ? `<span class="unread-badge">${d.unreadCount > 99 ? "99+" : d.unreadCount}</span>`
        : "";
      const effMode = d.peer.presenceMode ?? (d.peer.online ? "online" : "offline");
      return `
        <li class="dm-item${active}${unread}${muted}" data-dm="${escapeHtml(d.channelId)}">
          <span class="dm-item-avatar">
            ${renderAvatar({
              avatarMediaId: d.peer.avatarMediaId,
              fallbackText: name,
              sizePx: 28
            })}
            <span class="presence-dot ${presenceDotClass(effMode)}"></span>
          </span>
          <span class="dm-item-body">
            <span class="dm-item-name">${escapeHtml(name)}</span>
            ${d.peer.customStatus ? `<span class="dm-item-sub">${escapeHtml(d.peer.customStatus)}</span>` : ""}
          </span>
          ${badge}
          <button class="ghost dm-item-close" data-dm-close="${escapeHtml(d.channelId)}" title="Скрыть из списка" aria-label="Скрыть">${icon("x", { size: 14 })}</button>
        </li>
      `;
    })
    .join("");
  return `
    <div class="section-title dm-list-title">
      <span>Прямые сообщения</span>
      <button id="dm-find-btn" class="ghost ch-category-add" title="Найти или начать беседу" aria-label="Найти">${icon("plus")}</button>
    </div>
    ${state.dms.length === 0
      ? `<div class="ch-panel-empty">Пока нет личных бесед. Нажми <strong>+</strong> или открой DM из профиля участника.</div>`
      : `<ul class="dm-list">${items}</ul>`}
  `;
}

// G.8: home-экран DM (когда в dm-mode, но никакой DM не выбран).
// Поле поиска по username + список DM в виде крупных карточек.
function renderDMHome(): string {
  const errBlock = state.dmFindError
    ? `<div class="dm-home-error">${escapeHtml(state.dmFindError)}</div>`
    : "";
  const sorted = [...state.dms].sort((a, b) => {
    const at = a.lastMessageAt ?? a.createdAt;
    const bt = b.lastMessageAt ?? b.createdAt;
    return bt.localeCompare(at);
  });
  const cards = sorted.length === 0
    ? `<div class="dm-home-empty">Нет начатых бесед. Введи username сверху, чтобы начать первую.</div>`
    : `<ul class="dm-home-list">
        ${sorted.map((d) => {
          const name = d.peer.displayName || d.peer.username;
          const effMode = d.peer.presenceMode ?? (d.peer.online ? "online" : "offline");
          return `
            <li class="dm-home-card" data-dm="${escapeHtml(d.channelId)}">
              <span class="dm-home-avatar">
                ${renderAvatar({ avatarMediaId: d.peer.avatarMediaId, fallbackText: name, sizePx: 48 })}
                <span class="presence-dot ${presenceDotClass(effMode)}"></span>
              </span>
              <span class="dm-home-card-body">
                <span class="dm-home-card-name">${escapeHtml(name)}</span>
                <span class="dm-home-card-sub">${d.peer.customStatus ? escapeHtml(d.peer.customStatus) : "@" + escapeHtml(d.peer.username)}</span>
              </span>
              ${d.unreadCount > 0 ? `<span class="unread-badge">${d.unreadCount > 99 ? "99+" : d.unreadCount}</span>` : ""}
            </li>
          `;
        }).join("")}
      </ul>`;
  return `
    <div class="dm-home">
      <header class="dm-home-header">
        <h2>Личные сообщения</h2>
        <form id="dm-find-form" class="dm-home-find">
          <input id="dm-find-input"
                 name="query"
                 placeholder="Найти или начать беседу — введи username"
                 autocomplete="off"
                 maxlength="64"
                 value="${escapeHtml(state.dmFindQuery)}" />
          <button type="submit" ${state.dmOpening ? "disabled" : ""}>${state.dmOpening ? "…" : "Открыть"}</button>
        </form>
        ${errBlock}
      </header>
      ${cards}
    </div>
  `;
}

// G.8: рендер DM-канала. Использует ту же машинерию (message-list +
// composer + reply-bar + mention-popup), что и обычный text-канал, но с
// собственным header'ом (peer avatar + name + online-dot, без settings).
// canSend всегда true — DM-канал всегда принимает сообщения.
function renderDMChannelView(dm: DMItem): string {
  const name = dm.peer.displayName || dm.peer.username;
  const effMode = dm.peer.presenceMode ?? (dm.peer.online ? "online" : "offline");
  const sub = dm.peer.customStatus || "@" + dm.peer.username;
  return `
    <header class="channel-header dm-channel-header">
      <div class="dm-header-info">
        <span class="dm-header-avatar">
          ${renderAvatar({ avatarMediaId: dm.peer.avatarMediaId, fallbackText: name, sizePx: 36 })}
          <span class="presence-dot ${presenceDotClass(effMode)}"></span>
        </span>
        <div>
          <h2>${escapeHtml(name)}</h2>
          <div class="topic">${escapeHtml(sub)}</div>
        </div>
      </div>
    </header>
    <div id="drop-zone" class="drop-zone" hidden>
      <div class="drop-zone-inner">📎 Отпусти, чтобы прикрепить файлы</div>
    </div>
    <div id="message-list" class="message-list">
      ${renderMessagesWithDivider()}
    </div>
    ${renderJumpToUnread()}
    ${state.pendingUploads.length > 0 ? renderPendingUploads() : ""}
    ${renderReplyBar()}
    <div id="mention-popup" class="mention-popup" hidden></div>
    <form id="send-form" class="send-form">
      <label class="attach-btn" title="Прикрепить файлы (до ${MAX_ATTACHMENTS})">
        ${icon("paperclip")}
        <input type="file" id="attach-input" multiple hidden />
      </label>
      <input
        name="body"
        autocomplete="off"
        placeholder="Сообщение для ${escapeHtml(name)}"
        value="${escapeHtml(loadDraft(dm.channelId))}"
      />
      <button type="submit">${state.uploadInFlight ? "…" : "↑"}</button>
    </form>
  `;
}

function channelPrefix(ch: Channel): string {
  if (ch.isPrivate) return "🔒";
  if (ch.kind === "voice") return "🔊";
  return "#";
}

function renderBellButton(): string {
  const count = state.notificationsUnread;
  const badge = count > 0
    ? `<span class="bell-badge">${count > 99 ? "99+" : count}</span>`
    : "";
  return `<button id="open-notifications" class="ghost bell-btn" title="Уведомления" aria-label="Уведомления">${icon("bell")}${badge}</button>`;
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
      <div class="channel-header-actions">
        <button id="open-search" class="ghost" title="Поиск по сообщениям" aria-label="Поиск">${icon("search")}</button>
        <button id="toggle-member-sidebar" class="ghost" title="${state.memberSidebarOpen ? "Скрыть участников" : "Показать участников"}" aria-label="Участники">${icon("users")}</button>
        ${state.workspaces.find((w) => w.id === channel.workspaceId)?.role && ["owner","admin","moderator"].includes(state.workspaces.find((w) => w.id === channel.workspaceId)!.role!) ? `<button id="open-audit" class="ghost" title="Журнал событий" aria-label="Журнал событий">${icon("scroll")}</button>` : ""}
        ${canManage ? `<button id="open-channel-settings" class="ghost" title="Настройки канала" aria-label="Настройки канала">${icon("settings")}</button>` : ""}
      </div>
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
        ${icon("paperclip")}
        <input type="file" id="attach-input" multiple hidden ${canSend ? "" : "disabled"} />
      </label>
      <input
        name="body"
        autocomplete="off"
        placeholder="${canSend ? `Сообщение в #${channel.name}` : "Этот канал не принимает сообщения"}"
        ${canSend ? "" : "disabled"}
        value="${escapeHtml(canSend ? loadDraft(channel.id) : "")}"
      />
      <button type="submit" ${canSend ? "" : "disabled"}>${state.uploadInFlight ? "…" : "↑"}</button>
    </form>
  `;
}

// Селект качества демонстрации экрана (рядом с кнопкой «Поделиться
// экраном»). Применяется при следующем toggleScreenShare; если уже
// шарим — applyScreenShareQuality переприменяет cap на лету.
function renderScreenQualitySelect(): string {
  const cur = state.screenShareQuality;
  const opts = (Object.keys(SCREEN_SHARE_PRESETS) as ScreenShareQualityKey[])
    .map((k) => `<option value="${k}"${k === cur ? " selected" : ""}>${k}</option>`)
    .join("");
  return `<select class="screen-quality-select ghost" title="Качество демонстрации экрана">${opts}</select>`;
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
  //
  // Screenshare-layout: если кто-то делится экраном (self или peer),
  // его tile становится primary (большой, сверху), остальные —
  // в горизонтальной полосе под ним. peer.screenSharing приходит
  // через `voice.state` (отдельный сигналинг, см. PeerStatePayload).
  const renderTile = (p: typeof participants[number], extraClass = ""): string => {
    const name = p.displayName?.trim() || p.username || p.userId.slice(0, 8);
    const isSelf = selfSessionId !== null && p.sessionId === selfSessionId;
    const tag = isSelf ? `data-voice-self="1"` : `data-voice-peer="${escapeHtml(p.sessionId)}"`;
    const sharing = isSelf ? screenOn : !!p.screenSharing;
    const cls = `voice-tile${isSelf ? " self" : ""}${sharing ? " sharing" : ""}${extraClass ? " " + extraClass : ""}`;
    return `<div class="${cls}">
      <video class="voice-tile-video" ${tag} autoplay playsinline ${isSelf ? "muted" : ""}></video>
      <div class="voice-tile-overlay">
        <span class="voice-dot"></span>
        <span class="voice-name">${escapeHtml(name)}${isSelf ? " (вы)" : ""}</span>
        ${sharing ? `<span class="voice-tile-live">В ЭФИРЕ</span>` : ""}
      </div>
    </div>`;
  };

  const sharer = participants.find((p) => {
    const isSelf = selfSessionId !== null && p.sessionId === selfSessionId;
    return isSelf ? screenOn : !!p.screenSharing;
  });

  const tiles = participants.length === 0
    ? `<div class="muted">Пока никого. ${joined ? "Подключайся, говори :)" : "Будь первым."}</div>`
    : sharer
      ? `<div class="voice-tiles screen-layout">
          <div class="voice-primary">${renderTile(sharer, "primary")}</div>
          <div class="voice-strip-tiles">${participants
            .filter((p) => p.sessionId !== sharer.sessionId)
            .map((p) => renderTile(p))
            .join("")}</div>
        </div>`
      : `<div class="voice-tiles">${participants.map((p) => renderTile(p)).join("")}</div>`;

  const actions = joined
    ? `
      ${callIconButton("voice-mute", muted ? "mic-off" : "mic", muted ? "Включить микрофон" : "Заглушить", muted ? "danger" : "")}
      ${callIconButton("voice-camera", cameraOn ? "camera-off" : "camera", cameraOn ? "Выключить камеру" : "Включить камеру", "", screenOn)}
      ${callIconButton("voice-screen", screenOn ? "screen-off" : "screen", screenOn ? "Прекратить демо" : "Поделиться экраном", screenOn ? "active" : "")}
      ${renderScreenQualitySelect()}
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
    el.volume = state.voiceVolumes[sid] ?? 1;
  }
  const callLocal = callMgr.getLocalStream();
  const callRemote = callMgr.getRemoteStream();
  for (const el of rootEl.querySelectorAll<HTMLVideoElement>("video[data-call-self]")) {
    if (el.srcObject !== callLocal) el.srcObject = callLocal;
  }
  for (const el of rootEl.querySelectorAll<HTMLVideoElement>("video[data-call-remote]")) {
    if (el.srcObject !== callRemote) el.srcObject = callRemote;
    el.volume = state.voiceVolumes["call-remote"] ?? 1;
  }
  // Speaking-indicator: создаём/обновляем analyser-узлы для всех участников
  // (включая себя), drop'аем для тех, кого больше нет в DOM.
  refreshSpeakingIndicators(voiceLocal, callRemote);
  attachVoiceTileFullscreen();
}

// Двойной клик на voice-tile разворачивает его поверх voice-room (через
// position:fixed inset:24px), повторный клик возвращает в сетку. Один tile
// в fullscreen за раз: при разворачивании снимаем класс с остальных.
function attachVoiceTileFullscreen(): void {
  const tiles = rootEl.querySelectorAll<HTMLDivElement>(".voice-tile");
  for (const tile of Array.from(tiles)) {
    if ((tile as HTMLElement & { _fsAttached?: boolean })._fsAttached) continue;
    (tile as HTMLElement & { _fsAttached?: boolean })._fsAttached = true;
    tile.addEventListener("dblclick", () => {
      const wasFs = tile.classList.contains("fullscreen");
      for (const other of Array.from(tiles)) other.classList.remove("fullscreen");
      if (!wasFs) tile.classList.add("fullscreen");
    });
    // ПКМ на чужом тайле открывает volume-popup. На своём (self) и без
    // данных peer'а — игнор.
    tile.addEventListener("contextmenu", (ev) => {
      if (tile.classList.contains("self")) return;
      const video = tile.querySelector<HTMLVideoElement>("video[data-voice-peer]");
      const sid = video?.dataset.voicePeer;
      if (!sid) return;
      ev.preventDefault();
      const p = state.voiceSnapshot?.participants.find((x) => x.sessionId === sid);
      const label = p ? (p.displayName || p.username || sid.slice(0, 8)) : "Участник";
      const x = Math.min(ev.clientX, window.innerWidth - 280);
      const y = Math.min(ev.clientY, window.innerHeight - 200);
      state.voiceVolumeMenu = { key: sid, label, x, y };
      render();
    });
  }
  // Аналогично для 1-к-1 tile'а (call-video-tile с data-call-remote).
  const callTiles = rootEl.querySelectorAll<HTMLDivElement>(".call-video-tile");
  for (const tile of Array.from(callTiles)) {
    if ((tile as HTMLElement & { _fsAttached?: boolean })._fsAttached) continue;
    (tile as HTMLElement & { _fsAttached?: boolean })._fsAttached = true;
    const video = tile.querySelector<HTMLVideoElement>("video[data-call-remote]");
    if (!video) continue;
    tile.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const peerName = state.callSnapshot ? describePeer(state.callSnapshot.peerUserId) : "Собеседник";
      const x = Math.min(ev.clientX, window.innerWidth - 280);
      const y = Math.min(ev.clientY, window.innerHeight - 200);
      state.voiceVolumeMenu = { key: "call-remote", label: peerName, x, y };
      render();
    });
  }
}

// Speaking indicator: один общий AudioContext, по AnalyserNode на каждый
// audio-track. RAF-цикл считает RMS и переключает .speaking на .voice-tile,
// чтобы рамка тайла подсвечивалась во время речи (Discord-like). Volume
// контроль (per-remote slider) — отдельная задача в бэклоге.
interface SpeakingNode {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buffer: Uint8Array<ArrayBuffer>;
  isSpeaking: boolean;
}

let speakingCtx: AudioContext | null = null;
const speakingNodes = new Map<string, SpeakingNode>();
let speakingRaf: number | null = null;
const SPEAKING_THRESHOLD = 12; // эмпирически: тишина ~3-6, разговор 20+

function ensureSpeakingContext(): AudioContext | null {
  if (speakingCtx) return speakingCtx;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    speakingCtx = new Ctor();
    return speakingCtx;
  } catch {
    return null;
  }
}

function refreshSpeakingIndicators(voiceLocal: MediaStream | null, callRemote: MediaStream | null): void {
  const ctx = ensureSpeakingContext();
  if (!ctx) return;

  // Map<key, stream> — key используется и для DOM-селектора, и для
  // удаления нод, когда участник ушёл.
  const targets = new Map<string, MediaStream>();
  if (voiceLocal) targets.set("self", voiceLocal);
  for (const p of state.voiceSnapshot?.participants ?? []) {
    if (state.voiceSnapshot && p.sessionId === state.voiceSnapshot.selfSessionId) continue;
    const stream = voiceMgr.getRemoteStream(p.sessionId);
    if (stream) targets.set(`peer:${p.sessionId}`, stream);
  }
  if (callRemote) targets.set("call-remote", callRemote);

  // Создаём недостающие.
  for (const [key, stream] of targets) {
    if (speakingNodes.has(key)) continue;
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) continue;
    try {
      const source = ctx.createMediaStreamSource(new MediaStream([audioTracks[0]]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      speakingNodes.set(key, {
        source,
        analyser,
        buffer: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
        isSpeaking: false
      });
    } catch {
      // createMediaStreamSource может бросить, если track уже закрыт
      // (например, peer leave прямо в момент refresh). Игнорируем — на
      // следующем refresh подберём свежий stream.
    }
  }
  // Удаляем ушедших.
  for (const [key, node] of speakingNodes) {
    if (!targets.has(key)) {
      try { node.source.disconnect(); } catch {}
      try { node.analyser.disconnect(); } catch {}
      speakingNodes.delete(key);
    }
  }
  if (speakingNodes.size > 0 && speakingRaf === null) {
    speakingRaf = requestAnimationFrame(speakingLoop);
  } else if (speakingNodes.size === 0 && speakingRaf !== null) {
    cancelAnimationFrame(speakingRaf);
    speakingRaf = null;
  }
}

function speakingLoop(): void {
  for (const [key, node] of speakingNodes) {
    node.analyser.getByteFrequencyData(node.buffer);
    let sum = 0;
    for (let i = 0; i < node.buffer.length; i++) sum += node.buffer[i];
    const avg = sum / node.buffer.length;
    const speaking = avg > SPEAKING_THRESHOLD;
    if (speaking === node.isSpeaking) continue;
    node.isSpeaking = speaking;
    const selector = key === "self"
      ? ".voice-tile.self"
      : key.startsWith("peer:")
        ? `.voice-tile [data-voice-peer="${CSS.escape(key.slice(5))}"]`
        : `.call-video-tile`;
    const el = rootEl.querySelector<HTMLElement>(selector);
    const tile = el?.closest<HTMLElement>(".voice-tile, .call-video-tile");
    if (tile) tile.classList.toggle("speaking", speaking);
  }
  speakingRaf = speakingNodes.size > 0 ? requestAnimationFrame(speakingLoop) : null;
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

// reactionTooltip — «Маша, Петя и ещё 3 поставили 👍». Поле userIds —
// упорядочено по created_at (см. SQL агрегатор). Имена резолвятся через
// state.members + state.me; неизвестные UUID показываются как «кто-то».
function reactionTooltip(emoji: string, agg: ReactionAgg): string {
  const ids = agg.userIds ?? [];
  if (ids.length === 0) return `${emoji} · реакций: ${agg.count}`;
  const names = ids.map((id) => {
    if (id === state.me?.id) return "Вы";
    const m = state.members.find((mm) => mm.userId === id);
    return m?.displayName || m?.username || "кто-то";
  });
  const head = names.slice(0, 6);
  const rest = names.length - head.length;
  let list = head.join(", ");
  if (rest > 0) list += ` и ещё ${rest}`;
  return `${list} — ${emoji}`;
}

function renderReplySnippet(reply: ReplySnippet | undefined): string {
  if (!reply) return "";
  if (reply.deleted) {
    return `<div class="reply-snippet deleted">
      <span class="reply-arrow">${icon("reply", { size: 14 })}</span>
      <span class="muted">исходное сообщение удалено</span>
    </div>`;
  }
  const author = describePeer(reply.authorId);
  const member = state.members.find((m) => m.userId === reply.authorId);
  const avatar = renderAvatar({
    avatarMediaId: member?.avatarMediaId,
    fallbackText: author,
    sizePx: 16,
    className: "reply-avatar"
  });
  const color = member ? getRoleColor(member.role) : undefined;
  const authorStyle = color ? ` style="color:${color};"` : "";
  return `<div class="reply-snippet" data-jump-id="${escapeHtml(reply.messageId)}" title="Перейти к исходному">
    <span class="reply-arrow">${icon("reply", { size: 14 })}</span>
    ${avatar}
    <span class="reply-author"${authorStyle}>${escapeHtml(author)}</span>
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
  const GROUP_WINDOW_MS = 7 * 60 * 1000;
  let dividerInserted = false;
  let prev: Message | null = null;
  let prevDayKey: string | null = null;
  const out: string[] = [];
  for (const m of state.messages) {
    let dividerHere = false;
    // Date separator при пересечении границы суток (Discord-style: «18 мая 2026»
    // тонкой линией с label по центру).
    const dayKey = dayKeyOf(m.createdAt);
    if (dayKey && dayKey !== prevDayKey) {
      out.push(`<div class="day-divider"><span>${escapeHtml(dayLabel(m.createdAt))}</span></div>`);
      dividerHere = true;
    }
    prevDayKey = dayKey;
    if (
      !dividerInserted &&
      !Number.isNaN(cutoff) &&
      Date.parse(m.createdAt) > cutoff &&
      m.authorId !== state.me?.id
    ) {
      out.push(`<div class="new-messages-divider"><span>Новые сообщения</span></div>`);
      dividerInserted = true;
      dividerHere = true;
    }
    const isSystem = !!m.kind && m.kind !== "user";
    const prevIsSystem = prev ? !!prev.kind && prev.kind !== "user" : false;
    const grouped =
      !!prev &&
      !dividerHere &&
      !isSystem &&
      !prevIsSystem &&
      prev.authorId === m.authorId &&
      !m.replyTo &&
      state.editingMessageId !== m.id &&
      Date.parse(m.createdAt) - Date.parse(prev.createdAt) < GROUP_WINDOW_MS;
    out.push(renderMessage(m, grouped));
    prev = m;
  }
  return out.join("");
}

function dayKeyOf(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sod = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((sod(now) - sod(d)) / 86400000);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Вчера";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
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
const SPOILER_RE = /\|\|([^|\n]+?)\|\|/g;

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
  text = text.replace(SPOILER_RE, '<span class="spoiler" data-spoiler>$1</span>');

  // 7) Возврат плейсхолдеров.
  return text.replace(/(\d+)/g, (_, idx: string) => placeholders[Number(idx)] ?? "");
}

function renderMessage(m: Message, grouped: boolean = false): string {
  // H.9: system-сообщения — плашка без аватара/реакций/edit/reply. body —
  // fallback-текст с бэка; resolveSystemText даёт более точную русскую
  // формулировку, если автор в state.members (свежие данные).
  if (m.kind && m.kind !== "user") {
    return renderSystemMessage(m);
  }
  const isMine = state.me?.id === m.authorId;
  const selectedWorkspace = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  const canModerate = !!selectedWorkspace && ["owner", "admin", "moderator"].includes(selectedWorkspace.role ?? "");
  const canDelete = isMine || canModerate;
  const isEditing = state.editingMessageId === m.id;
  const reactions = Object.entries(m.reactions ?? {});
  const pickerOpen = state.pickerForMessageId === m.id;

  const authorName = describePeer(m.authorId);
  const authorMember = state.members.find((mem) => mem.userId === m.authorId);
  const authorAvatarId = m.authorId === state.me?.id
    ? state.me?.avatarMediaId
    : authorMember?.avatarMediaId;
  const authorCustomStatus = m.authorId === state.me?.id
    ? state.me?.customStatus
    : authorMember?.customStatus;
  const authorTitle = authorCustomStatus ? ` title="${escapeHtml(authorCustomStatus)}"` : "";
  const avatarHtml = renderAvatar({
    avatarMediaId: authorAvatarId,
    fallbackText: authorName,
    sizePx: 40,
    className: "message-avatar"
  });

  if (isEditing) {
    return `
      <div class="message" data-id="${m.id}">
        ${avatarHtml}
        <div class="message-content">
          <div class="message-meta">
            <span class="author"${authorColorStyle(m.authorId)}>${escapeHtml(authorName)}</span>
            <span class="timestamp" title="${escapeHtml(formatTime(m.createdAt))}">${formatTimeSmart(m.createdAt)}</span>
          </div>
          <form class="edit-form" data-edit-id="${m.id}">
            <input name="body" value="${escapeHtml(m.body)}" autofocus />
            <button type="submit" class="primary">Сохранить</button>
            <button type="button" class="ghost cancel-edit" data-id="${m.id}">Отмена</button>
          </form>
        </div>
      </div>
    `;
  }

  const groupedCls = grouped ? " message-grouped" : "";
  const avatarSlot = grouped
    ? `<span class="message-avatar message-avatar-spacer" aria-hidden="true"><span class="grouped-timestamp" title="${escapeHtml(formatTime(m.createdAt))}">${escapeHtml(formatTimeSmartShort(m.createdAt))}</span></span>`
    : avatarHtml;
  const metaBlock = grouped
    ? `<div class="message-meta message-meta-grouped">
        <span class="message-actions">
          <button class="ghost action-react" data-id="${m.id}" title="Реакция">${icon("smile")}</button>
          <button class="ghost action-reply" data-id="${m.id}" data-author="${escapeHtml(m.authorId)}" title="Ответить">${icon("reply")}</button>
          ${isMine ? `<button class="ghost action-edit" data-id="${m.id}" title="Редактировать">${icon("pencil")}</button>` : ""}
          ${canDelete ? `<button class="ghost action-delete" data-id="${m.id}" title="Удалить">${icon("trash")}</button>` : ""}
        </span>
      </div>`
    : `<div class="message-meta">
        <span class="author"${authorColorStyle(m.authorId)}${authorTitle}>${escapeHtml(authorName)}</span>${isMine ? ` <span class="author-mine">· вы</span>` : ""}
        <span class="timestamp" title="${escapeHtml(formatTime(m.createdAt))}">${formatTimeSmart(m.createdAt)}${m.editedAt ? " · изменено" : ""}</span>
        <span class="message-actions">
          <button class="ghost action-react" data-id="${m.id}" title="Реакция">${icon("smile")}</button>
          <button class="ghost action-reply" data-id="${m.id}" data-author="${escapeHtml(m.authorId)}" title="Ответить">${icon("reply")}</button>
          ${isMine ? `<button class="ghost action-edit" data-id="${m.id}" title="Редактировать">${icon("pencil")}</button>` : ""}
          ${canDelete ? `<button class="ghost action-delete" data-id="${m.id}" title="Удалить">${icon("trash")}</button>` : ""}
        </span>
      </div>`;
  return `
    <div class="message${groupedCls}" data-id="${m.id}">
      ${avatarSlot}
      <div class="message-content">
      ${renderReplySnippet(m.replyTo)}
      ${metaBlock}
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
                <button class="reaction-chip${agg.mine ? " mine" : ""}" data-react-toggle="${m.id}" data-emoji="${escapeHtml(emoji)}" title="${escapeHtml(reactionTooltip(emoji, agg))}">
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
    </div>
  `;
}

function renderSystemMessage(m: Message): string {
  // Иконка по kind. system_join — стрелка-вход; system_call — телефон;
  // system_channel_event — pencil (реорг канала). Старые kind'ы кроме
  // 'user' могут прилететь от свежего бэка с обновлённой матрицей —
  // fallback на info-точку.
  const iconName =
    m.kind === "system_join"
      ? "log-out"
      : m.kind === "system_call"
        ? "phone"
        : m.kind === "system_channel_event"
          ? "pencil"
          : "smile";
  // Имя автора режется через state.members (свежий displayName) с
  // фолбэком на body (бэк уже подставил displayName при создании).
  const authorName = describePeer(m.authorId);
  // body уже содержит читабельный текст. Если в state.members есть
  // displayName новее, чем на момент join'а, не подменяем — body —
  // зафиксированный «срез истории», как и должно быть для плашки.
  const text = m.body || `${authorName} (${m.kind})`;
  return `
    <div class="message message-system" data-id="${m.id}">
      <span class="message-system-icon">${icon(iconName, { size: 16 })}</span>
      <span class="message-system-text">${escapeHtml(text)}</span>
      <span class="message-system-time" title="${escapeHtml(formatTime(m.createdAt))}">${formatTimeSmart(m.createdAt)}</span>
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
  if (state.modal === "workspaceRoles") return renderWorkspaceRolesModal();
  if (state.modal === "welcomeChannel") return renderWelcomeChannelModal();
  if (state.modal === "createChannel") return renderCreateChannelModal();
  if (state.modal === "workspaceSettings") return renderWorkspaceSettingsModal();
  if (state.modal === "userProfile") return renderUserProfilePopup();
  return "";
}

// Discord-style user profile popup — компактная карточка для просмотра
// чужого профиля. Открывается кликом по member-sidebar и по author'у в
// сообщении (TODO). Read-only с двумя action'ами: «Сообщение» (DM) и
// «Позвонить». Источник данных — state.members[userId], плюс fallback
// на state.dms.peer для DM-сценариев.
function renderUserProfilePopup(): string {
  const userId = state.userProfileTarget;
  if (!userId) return "";
  const member = state.members.find((m) => m.userId === userId);
  const dm = state.dms.find((d) => d.peer.userId === userId);
  const name = member?.displayName || member?.username || dm?.peer.displayName || dm?.peer.username || "Пользователь";
  const username = member?.username || dm?.peer.username || "";
  const avatarMediaId = member?.avatarMediaId || dm?.peer.avatarMediaId;
  const presenceMode = member?.presenceMode || dm?.peer.presenceMode;
  const customStatus = member?.customStatus || dm?.peer.customStatus;
  const role = member?.role;
  const isSelf = userId === state.me?.id;
  const inCall = state.callSnapshot !== null;
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal user-profile-popup" role="dialog">
        <div class="user-profile-banner"></div>
        <button class="user-profile-close" data-modal-close title="Закрыть">✕</button>
        <div class="user-profile-avatar-row">
          <div class="user-profile-avatar-wrap">
            ${renderAvatar({ avatarMediaId, fallbackText: name, sizePx: 80, className: "user-profile-avatar" })}
            ${presenceMode ? `<span class="user-profile-dot ${presenceDotClass(presenceMode)}"></span>` : ""}
          </div>
        </div>
        <div class="user-profile-card">
          <div class="user-profile-name">${escapeHtml(name)}</div>
          ${username ? `<div class="user-profile-username">@${escapeHtml(username)}</div>` : ""}
          ${customStatus ? `<div class="user-profile-status">${escapeHtml(customStatus)}</div>` : ""}
          ${role ? `<div class="user-profile-role"><span class="role-badge role-${escapeHtml(role)}">${escapeHtml(role)}</span></div>` : ""}
          ${
            isSelf
              ? ""
              : `<div class="user-profile-actions">
                  <button class="primary user-profile-dm" data-user-id="${escapeHtml(userId)}">${icon("reply")} Сообщение</button>
                  ${!inCall ? `<button class="ghost user-profile-call" data-user-id="${escapeHtml(userId)}">${icon("phone")} Позвонить</button>` : ""}
                </div>`
          }
        </div>
      </div>
    </div>
  `;
}

function openUserProfile(userId: string): void {
  state.userProfileTarget = userId;
  state.modal = "userProfile";
  render();
}

// H.10: модалка настроек воркспейса. Табы:
//   - Обзор: name (PATCH), slug (readonly), иконка (PUT/DELETE /avatar)
//   - Welcome: select text-канала (PUT /welcome-channel)
//   - Роли: shortcut к существующей workspaceRoles-модалке
//   - Удалить: danger-zone, только owner; typed-confirm + DELETE
function openWorkspaceSettings(workspaceId: string): void {
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  state.workspaceSettings = {
    workspaceId,
    tab: "overview",
    draftName: ws.name,
    saving: false,
    error: null,
    deleteTyped: "",
    welcomeSaving: false
  };
  state.modal = "workspaceSettings";
  render();
}

const WS_TABS: { id: WorkspaceSettingsTab; label: string }[] = [
  { id: "overview", label: "Обзор" },
  { id: "welcome", label: "Канал приветствия" },
  { id: "roles", label: "Роли" },
  { id: "delete", label: "Удалить" }
];

function renderWorkspaceSettingsModal(): string {
  const wsSet = state.workspaceSettings;
  const ws = state.workspaces.find((w) => w.id === wsSet.workspaceId);
  if (!ws) return "";
  const isOwner = ws.role === "owner";
  const tabs = WS_TABS.filter((t) => t.id !== "delete" || isOwner);
  const tabBar = tabs.map((t) => {
    const active = t.id === wsSet.tab ? " active" : "";
    const danger = t.id === "delete" ? " danger" : "";
    return `<button class="ws-settings-tab${active}${danger}" data-ws-tab="${t.id}">${escapeHtml(t.label)}</button>`;
  }).join("");
  let body = "";
  if (wsSet.tab === "overview") body = renderWSOverviewTab(ws);
  else if (wsSet.tab === "welcome") body = renderWSWelcomeTab(ws);
  else if (wsSet.tab === "roles") body = renderWSRolesTab(ws);
  else if (wsSet.tab === "delete") body = renderWSDeleteTab(ws);
  const errBlock = wsSet.error ? `<div class="modal-error">${escapeHtml(wsSet.error)}</div>` : "";
  return `
    <input id="ws-settings-avatar-input" type="file" accept="image/*" hidden />
    <div class="modal-backdrop" data-modal-close>
      <div class="modal ws-settings-modal" role="dialog">
        <div class="modal-header">
          <h3>Настройки · ${escapeHtml(ws.name)}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="ws-settings-shell">
          <nav class="ws-settings-tabs">${tabBar}</nav>
          <div class="ws-settings-body">
            ${body}
            ${errBlock}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderWSOverviewTab(ws: Workspace): string {
  const wsSet = state.workspaceSettings;
  const avatarBlock = `
    <div class="ws-settings-avatar-block">
      ${renderAvatar({
        avatarMediaId: ws.avatarMediaId,
        fallbackText: ws.name,
        sizePx: 96,
        className: "ws-settings-avatar"
      })}
      <div class="ws-settings-avatar-actions">
        <button id="ws-settings-avatar-upload" class="ghost">${ws.avatarMediaId ? "Сменить иконку" : "Загрузить иконку"}</button>
        ${ws.avatarMediaId ? `<button id="ws-settings-avatar-remove" class="ghost danger">Удалить</button>` : ""}
        <div class="cc-field-hint">PNG/JPG, до 25 MiB. Будет видна всем участникам.</div>
      </div>
    </div>
  `;
  return `
    ${avatarBlock}
    <label class="cc-field">
      <span class="cc-field-label">Название</span>
      <input id="ws-settings-name" type="text" maxlength="64" value="${escapeHtml(wsSet.draftName)}" />
    </label>
    <label class="cc-field">
      <span class="cc-field-label">Адрес (slug)</span>
      <input type="text" value="${escapeHtml(ws.slug)}" disabled />
      <span class="cc-field-hint">Slug нельзя сменить — это стабильный идентификатор, на нём держатся ссылки и инвайты.</span>
    </label>
    <div class="modal-footer">
      <button id="ws-settings-save" class="primary" ${wsSet.saving || wsSet.draftName.trim() === ws.name ? "disabled" : ""}>
        ${wsSet.saving ? "Сохранение…" : "Сохранить"}
      </button>
    </div>
  `;
}

function renderWSWelcomeTab(ws: Workspace): string {
  const textChannels = state.channels.filter((c) => c.workspaceId === ws.id && c.kind === "text");
  const current = ws.welcomeChannelId ?? "";
  const options = [
    `<option value="">— не присылать —</option>`,
    ...textChannels.map((c) => `<option value="${c.id}"${c.id === current ? " selected" : ""}>#${escapeHtml(c.name)}</option>`)
  ].join("");
  return `
    <p class="modal-hint">Канал, в который автоматически прилетает плашка «X присоединился к серверу» при принятии инвайта.</p>
    <label class="cc-field">
      <span class="cc-field-label">Welcome-канал</span>
      <select id="ws-settings-welcome" class="cc-field-select" ${state.workspaceSettings.welcomeSaving ? "disabled" : ""}>${options}</select>
      ${state.workspaceSettings.welcomeSaving ? `<span class="cc-field-hint">Сохранение…</span>` : ""}
    </label>
  `;
}

function renderWSRolesTab(ws: Workspace): string {
  return `
    <p class="modal-hint">Кастомные роли, права и назначения участников.</p>
    <button id="ws-settings-open-roles" class="primary">Открыть редактор ролей · ${escapeHtml(ws.name)}</button>
  `;
}

function renderWSDeleteTab(ws: Workspace): string {
  const wsSet = state.workspaceSettings;
  const matches = wsSet.deleteTyped.trim() === ws.name;
  return `
    <div class="ws-settings-danger">
      <h4>Удалить воркспейс</h4>
      <p class="modal-hint">Это действие <strong>необратимо</strong>. Будут удалены все каналы, сообщения, вложения, роли и инвайты. Восстановить нельзя.</p>
      <label class="cc-field">
        <span class="cc-field-label">Введи название «${escapeHtml(ws.name)}» для подтверждения</span>
        <input id="ws-settings-delete-input" type="text" autocomplete="off" placeholder="${escapeHtml(ws.name)}" value="${escapeHtml(wsSet.deleteTyped)}" />
      </label>
      <div class="modal-footer">
        <button id="ws-settings-delete-btn" class="danger" ${matches && !wsSet.saving ? "" : "disabled"}>
          ${wsSet.saving ? "Удаление…" : "Удалить воркспейс навсегда"}
        </button>
      </div>
    </div>
  `;
}

function attachWorkspaceSettingsHandlers(): void {
  if (state.modal !== "workspaceSettings") return;
  const wsSet = state.workspaceSettings;
  const ws = state.workspaces.find((w) => w.id === wsSet.workspaceId);
  if (!ws) return;

  rootEl.querySelectorAll<HTMLButtonElement>("[data-ws-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.wsTab as WorkspaceSettingsTab;
      state.workspaceSettings.tab = tab;
      state.workspaceSettings.error = null;
      render();
    });
  });

  // --- Обзор ---
  const nameInput = rootEl.querySelector<HTMLInputElement>("#ws-settings-name");
  nameInput?.addEventListener("input", () => {
    state.workspaceSettings.draftName = nameInput.value;
    // обновим только Save-кнопку (без render() чтобы фокус не слетел)
    const btn = rootEl.querySelector<HTMLButtonElement>("#ws-settings-save");
    if (btn) btn.disabled = state.workspaceSettings.saving || nameInput.value.trim() === ws.name || !nameInput.value.trim();
  });
  rootEl.querySelector<HTMLButtonElement>("#ws-settings-save")?.addEventListener("click", () => {
    void saveWorkspaceName();
  });

  // Avatar upload — переиспользуем поток workspaceMenu (POST /uploads
  // → PUT /workspaces/{id}/avatar). Кнопка триггерит hidden input.
  rootEl.querySelector<HTMLButtonElement>("#ws-settings-avatar-upload")?.addEventListener("click", () => {
    rootEl.querySelector<HTMLInputElement>("#ws-settings-avatar-input")?.click();
  });
  rootEl.querySelector<HTMLInputElement>("#ws-settings-avatar-input")?.addEventListener("change", async (e) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      state.workspaceSettings.error = "Иконка должна быть картинкой";
      render();
      return;
    }
    try {
      state.status = "Загрузка иконки…";
      render();
      const uploaded = await httpClient.uploadFile<PendingUpload>("/api/v1/uploads", file);
      const updated = await httpClient.put<Workspace>(`/api/v1/workspaces/${ws.id}/avatar`, { mediaId: uploaded.id });
      state.workspaces = state.workspaces.map((w) => (w.id === ws.id ? { ...w, avatarMediaId: updated.avatarMediaId } : w));
      setTransientStatus("Иконка обновлена");
    } catch (err) {
      state.workspaceSettings.error = describeError(err);
      state.status = "";
      render();
    } finally {
      input.value = "";
    }
  });
  rootEl.querySelector<HTMLButtonElement>("#ws-settings-avatar-remove")?.addEventListener("click", async () => {
    try {
      const updated = await httpClient.del<Workspace>(`/api/v1/workspaces/${ws.id}/avatar`);
      state.workspaces = state.workspaces.map((w) => (w.id === ws.id ? { ...w, avatarMediaId: updated.avatarMediaId } : w));
      setTransientStatus("Иконка удалена");
    } catch (err) {
      state.workspaceSettings.error = describeError(err);
      render();
    }
  });

  // --- Welcome ---
  const welcomeSelect = rootEl.querySelector<HTMLSelectElement>("#ws-settings-welcome");
  welcomeSelect?.addEventListener("change", async () => {
    const value = welcomeSelect.value || null;
    state.workspaceSettings.welcomeSaving = true;
    render();
    try {
      const updated = await httpClient.put<Workspace>(`/api/v1/workspaces/${ws.id}/welcome-channel`, { channelId: value });
      state.workspaces = state.workspaces.map((w) => (w.id === ws.id ? { ...w, welcomeChannelId: updated.welcomeChannelId } : w));
      state.status = "Welcome-канал обновлён";
    } catch (err) {
      state.workspaceSettings.error = describeError(err);
    } finally {
      state.workspaceSettings.welcomeSaving = false;
      render();
    }
  });

  // --- Роли ---
  rootEl.querySelector<HTMLButtonElement>("#ws-settings-open-roles")?.addEventListener("click", () => {
    // Закрываем эту модалку и открываем roles-модалку. openWorkspaceRolesModal
    // сам ставит state.modal = "workspaceRoles" и тянет роли.
    void openWorkspaceRolesModal(ws.id);
  });

  // --- Удалить ---
  const delInput = rootEl.querySelector<HTMLInputElement>("#ws-settings-delete-input");
  delInput?.addEventListener("input", () => {
    state.workspaceSettings.deleteTyped = delInput.value;
    // обновим только кнопку — render() сбросил бы каретку
    const btn = rootEl.querySelector<HTMLButtonElement>("#ws-settings-delete-btn");
    if (btn) btn.disabled = state.workspaceSettings.saving || delInput.value.trim() !== ws.name;
  });
  rootEl.querySelector<HTMLButtonElement>("#ws-settings-delete-btn")?.addEventListener("click", () => {
    void deleteWorkspace();
  });
}

async function saveWorkspaceName(): Promise<void> {
  const wsSet = state.workspaceSettings;
  const ws = state.workspaces.find((w) => w.id === wsSet.workspaceId);
  if (!ws) return;
  const name = wsSet.draftName.trim();
  if (!name || name === ws.name) return;
  wsSet.saving = true;
  wsSet.error = null;
  render();
  try {
    const updated = await httpClient.patch<Workspace>(`/api/v1/workspaces/${ws.id}`, { name });
    state.workspaces = state.workspaces.map((w) => (w.id === ws.id ? { ...w, name: updated.name } : w));
    state.workspaceSettings.draftName = updated.name;
    setTransientStatus("Воркспейс обновлён");
  } catch (err) {
    wsSet.error = describeError(err);
  } finally {
    wsSet.saving = false;
    render();
  }
}

async function deleteWorkspace(): Promise<void> {
  const wsSet = state.workspaceSettings;
  const ws = state.workspaces.find((w) => w.id === wsSet.workspaceId);
  if (!ws) return;
  if (wsSet.deleteTyped.trim() !== ws.name) return;
  wsSet.saving = true;
  wsSet.error = null;
  render();
  try {
    await httpClient.del(`/api/v1/workspaces/${ws.id}`);
    // Локальная очистка: убираем ws и его каналы, переключаемся на первый
    // оставшийся (или ни на что, если воркспейсов больше нет).
    state.workspaces = state.workspaces.filter((w) => w.id !== ws.id);
    state.channels = state.channels.filter((c) => c.workspaceId !== ws.id);
    if (state.selectedWorkspaceId === ws.id) {
      state.selectedWorkspaceId = null;
      state.selectedChannelId = null;
      state.messages = [];
    }
    state.modal = null;
    state.status = `Воркспейс «${ws.name}» удалён`;
    if (state.workspaces.length > 0) {
      await selectWorkspace(state.workspaces[0].id);
    } else {
      render();
    }
  } catch (err) {
    wsSet.error = describeError(err);
    wsSet.saving = false;
    render();
  }
}

// G.10: enter/leave inline-edit mode для поля профиля. Сбрасываем draft'ы
// и error при каждом переходе — чтобы открытие «Изменить пароль» не показало
// ошибку от прошлой попытки.
function startProfileEdit(field: "displayName" | "password"): void {
  state.profileEdit = {
    field,
    draftDisplayName: state.me?.displayName ?? "",
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
    saving: false,
    error: null,
    okMessage: null
  };
  render();
  // фокус на первое поле редактора
  requestAnimationFrame(() => {
    const sel = field === "displayName" ? "#profile-display-input" : "#profile-pw-current";
    rootEl.querySelector<HTMLInputElement>(sel)?.focus();
  });
}

function cancelProfileEdit(): void {
  state.profileEdit.field = null;
  state.profileEdit.error = null;
  state.profileEdit.okMessage = null;
  render();
}

function attachProfileEditHandlers(): void {
  if (state.modal !== "profile") return;

  rootEl.querySelectorAll<HTMLButtonElement>("[data-profile-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const f = btn.dataset.profileEdit as "displayName" | "password" | undefined;
      if (f) startProfileEdit(f);
    });
  });
  rootEl.querySelectorAll<HTMLButtonElement>("[data-profile-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => cancelProfileEdit());
  });

  // --- displayName edit ---
  const dnInput = rootEl.querySelector<HTMLInputElement>("#profile-display-input");
  dnInput?.addEventListener("input", () => {
    state.profileEdit.draftDisplayName = dnInput.value;
  });
  rootEl.querySelector<HTMLButtonElement>("#profile-display-save")?.addEventListener("click", () => {
    void saveDisplayName();
  });

  // --- password edit (live state без render()) ---
  const pwCur = rootEl.querySelector<HTMLInputElement>("#profile-pw-current");
  pwCur?.addEventListener("input", () => { state.profileEdit.currentPassword = pwCur.value; });
  const pwNew = rootEl.querySelector<HTMLInputElement>("#profile-pw-new");
  pwNew?.addEventListener("input", () => { state.profileEdit.newPassword = pwNew.value; });
  const pwConfirm = rootEl.querySelector<HTMLInputElement>("#profile-pw-confirm");
  pwConfirm?.addEventListener("input", () => { state.profileEdit.confirmPassword = pwConfirm.value; });
  rootEl.querySelector<HTMLButtonElement>("#profile-pw-save")?.addEventListener("click", () => {
    void savePassword();
  });
}

async function saveDisplayName(): Promise<void> {
  const pe = state.profileEdit;
  const trimmed = pe.draftDisplayName.trim();
  pe.saving = true;
  pe.error = null;
  render();
  try {
    const updated = await httpClient.put<Me & { updatedAt: string }>("/api/v1/users/me", {
      displayName: trimmed
    });
    state.me = {
      id: updated.id, email: updated.email, username: updated.username,
      displayName: updated.displayName, isRoot: state.me?.isRoot,
      avatarMediaId: updated.avatarMediaId ?? state.me?.avatarMediaId,
      presenceMode: state.me?.presenceMode,
      customStatus: state.me?.customStatus
    };
    state.profileEdit.field = null;
    state.profileEdit.saving = false;
    setTransientStatus("Имя обновлено");
  } catch (err) {
    pe.saving = false;
    pe.error = describeError(err);
    render();
  }
}

async function savePassword(): Promise<void> {
  const pe = state.profileEdit;
  if (pe.currentPassword === "") {
    pe.error = "Введи текущий пароль";
    render();
    return;
  }
  if (pe.newPassword.length < 8) {
    pe.error = "Новый пароль — минимум 8 символов";
    render();
    return;
  }
  if (pe.newPassword !== pe.confirmPassword) {
    pe.error = "Подтверждение не совпадает с новым паролем";
    render();
    return;
  }
  pe.saving = true;
  pe.error = null;
  pe.okMessage = null;
  render();
  try {
    await httpClient.post("/api/v1/users/me/password", {
      currentPassword: pe.currentPassword,
      newPassword: pe.newPassword
    });
    state.profileEdit.field = null;
    state.profileEdit.saving = false;
    state.profileEdit.currentPassword = "";
    state.profileEdit.newPassword = "";
    state.profileEdit.confirmPassword = "";
    setTransientStatus("Пароль обновлён");
  } catch (err) {
    pe.saving = false;
    pe.error = describeError(err);
    render();
  }
}

// H.6: открыть модалку. Параллельно (не блокируя render) тянем список
// ролей воркспейса — нужны для секции «Доступ» при isPrivate=true.
function openCreateChannelModal(workspaceId: string, kind: "text" | "voice"): void {
  state.createChannel = {
    workspaceId,
    kind,
    name: "",
    isPrivate: false,
    selectedRoles: new Set(),
    roles: state.createChannel.workspaceId === workspaceId ? state.createChannel.roles : [],
    rolesLoading: true,
    saving: false,
    error: null
  };
  state.modal = "createChannel";
  render();
  void loadRolesForCreateChannel(workspaceId);
  // фокус на input имени
  requestAnimationFrame(() => {
    rootEl.querySelector<HTMLInputElement>("#create-channel-name")?.focus();
  });
}

async function loadRolesForCreateChannel(workspaceId: string): Promise<void> {
  try {
    const data = await httpClient.get<{ items: WorkspaceRole[] }>(`/api/v1/workspaces/${workspaceId}/roles`);
    if (state.createChannel.workspaceId !== workspaceId) return; // race-guard
    state.createChannel.roles = (data.items ?? []).sort((a, b) => b.position - a.position);
    state.createChannel.rolesLoading = false;
    render();
  } catch (err) {
    if (state.createChannel.workspaceId !== workspaceId) return;
    state.createChannel.rolesLoading = false;
    state.createChannel.error = describeError(err);
    render();
  }
}

function renderCreateChannelModal(): string {
  const cc = state.createChannel;
  const ws = state.workspaces.find((w) => w.id === cc.workspaceId);
  if (!ws) return "";
  const kindLabel = cc.kind === "voice" ? "голосовой" : "текстовый";
  const rolesBlock = !cc.isPrivate
    ? `<div class="modal-hint">Канал виден всем участникам воркспейса.</div>`
    : cc.rolesLoading
      ? `<div class="modal-hint">Загрузка ролей…</div>`
      : cc.roles.length === 0
        ? `<div class="modal-hint">Нет ролей в воркспейсе.</div>`
        : `
          <div class="cc-roles-label">Выбери роли, которые увидят канал</div>
          <ul class="cc-roles-list">
            ${cc.roles.map((r) => {
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
            }).join("")}
          </ul>
        `;
  const errBlock = cc.error ? `<div class="modal-error">${escapeHtml(cc.error)}</div>` : "";
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal cc-modal" role="dialog">
        <div class="modal-header">
          <h3>Создать ${kindLabel} канал · ${escapeHtml(ws.name)}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="modal-body">
          <label class="cc-field">
            <span class="cc-field-label">Название</span>
            <input id="create-channel-name" type="text" autocomplete="off"
                   maxlength="64" placeholder="новый-канал" value="${escapeHtml(cc.name)}" />
          </label>
          <label class="cc-field cc-field-toggle">
            <input id="create-channel-private" type="checkbox" ${cc.isPrivate ? "checked" : ""} />
            <span class="cc-field-toggle-body">
              <span class="cc-field-label">🔒 Приватный канал</span>
              <span class="cc-field-hint">Видят только выбранные роли + админы. Можно сменить позже в настройках канала.</span>
            </span>
          </label>
          <div class="cc-roles">${rolesBlock}</div>
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

function attachCreateChannelHandlers(): void {
  if (state.modal !== "createChannel") return;
  const nameInput = rootEl.querySelector<HTMLInputElement>("#create-channel-name");
  nameInput?.addEventListener("input", () => {
    state.createChannel.name = nameInput.value;
    // не зовём render() — иначе фокус слетит. error чистим при наборе.
    if (state.createChannel.error) {
      state.createChannel.error = null;
      // лёгкий update DOM-узла без render'а
      const err = rootEl.querySelector<HTMLElement>(".modal-error");
      if (err) err.remove();
    }
  });

  const privateToggle = rootEl.querySelector<HTMLInputElement>("#create-channel-private");
  privateToggle?.addEventListener("change", () => {
    state.createChannel.isPrivate = privateToggle.checked;
    render();
  });

  rootEl.querySelectorAll<HTMLInputElement>("[data-cc-role]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.ccRole;
      if (!id) return;
      const next = new Set(state.createChannel.selectedRoles);
      if (cb.checked) next.add(id);
      else next.delete(id);
      state.createChannel.selectedRoles = next;
    });
  });

  rootEl.querySelector<HTMLButtonElement>("#create-channel-submit")?.addEventListener("click", () => {
    void submitCreateChannel();
  });
}

async function submitCreateChannel(): Promise<void> {
  const cc = state.createChannel;
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
    const ch = await httpClient.post<Channel>(`/api/v1/workspaces/${cc.workspaceId}/channels`, {
      kind: cc.kind,
      name,
      isPrivate: cc.isPrivate
    });
    // Для приватного канала с выбранными ролями — выдаём channel.view
    // overrides отдельным запросом. owner всегда видит (короткое замыкание
    // в backend permission-резолвере), поэтому его не включаем.
    if (cc.isPrivate && cc.selectedRoles.size > 0) {
      const overrides = cc.roles
        .filter((r) => cc.selectedRoles.has(r.id) && r.code !== "owner")
        .map((r) => ({ roleCode: r.code, granted: ["channel.view"], denied: [] }));
      if (overrides.length > 0) {
        try {
          await httpClient.put(`/api/v1/channels/${ch.id}/permissions`, { overrides });
        } catch (err) {
          // Канал уже создан — не валим целиком, просто сообщим в status.
          state.status = `Канал создан, но не удалось выдать доступ: ${describeError(err)}`;
        }
      }
    }
    state.channels = [...state.channels, ch];
    state.modal = null;
    cc.saving = false;
    await selectChannel(ch.id);
  } catch (err) {
    cc.saving = false;
    cc.error = describeError(err);
    render();
  }
}

// H.9: модалка выбора welcome-канала. state.workspaces содержит
// welcomeChannelId — отрисовываем select из text-каналов воркспейса.
function renderWelcomeChannelModal(): string {
  const ws = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  if (!ws) return "";
  const textChannels = state.channels.filter((c) => c.workspaceId === ws.id && c.kind === "text");
  const current = ws.welcomeChannelId ?? "";
  const opts = textChannels
    .map((c) => `<option value="${c.id}"${c.id === current ? " selected" : ""}>#${escapeHtml(c.name)}</option>`)
    .join("");
  return `
    <div class="modal-backdrop" data-modal-close></div>
    <div class="modal welcome-channel-modal" role="dialog" aria-modal="true">
      <header class="modal-header">
        <h3>Канал приветствия</h3>
        <button class="ghost" data-modal-close aria-label="Закрыть">✕</button>
      </header>
      <div class="modal-body">
        <p class="modal-hint">Сюда будет приходить плашка «X присоединился к серверу», когда новый участник принимает инвайт.</p>
        <label class="welcome-channel-field">
          <span>Канал</span>
          <select id="welcome-channel-select">
            <option value=""${current === "" ? " selected" : ""}>— не присылать —</option>
            ${opts}
          </select>
        </label>
      </div>
      <footer class="modal-footer">
        <button class="ghost" data-modal-close>Отмена</button>
        <button id="welcome-channel-save" class="primary">Сохранить</button>
      </footer>
    </div>
  `;
}

async function openWelcomeChannelModal(workspaceId: string): Promise<void> {
  if (state.selectedWorkspaceId !== workspaceId) {
    await selectWorkspace(workspaceId);
  }
  state.modal = "welcomeChannel";
  render();
}

async function saveWelcomeChannel(workspaceId: string, channelId: string | null): Promise<void> {
  try {
    const updated = await httpClient.put<Workspace>(
      `/api/v1/workspaces/${workspaceId}/welcome-channel`,
      { channelId: channelId || null }
    );
    state.workspaces = state.workspaces.map((w) =>
      w.id === workspaceId ? { ...w, welcomeChannelId: updated.welcomeChannelId } : w
    );
    state.modal = null;
    state.status = channelId ? "Канал приветствия обновлён" : "Канал приветствия отключён";
  } catch (err) {
    state.status = describeError(err);
  }
  render();
}

// Полный список action-кодов для cherry-pick checkboxes. Должен совпадать
// с permission.AllActions в бэке (порядок важен только для UI).
const ALL_PERMISSION_ACTIONS = [
  "channel.create", "channel.update", "channel.delete", "channel.manage_members",
  "message.moderate", "invite.manage", "audit.read",
  "member.manage_role", "member.kick",
  "message.write", "message.react", "message.attach", "message.mention",
  "workspace.update"
];

function renderWorkspaceRolesModal(): string {
  const rs = state.workspaceRoles;
  const ws = state.workspaces.find((w) => w.id === rs.workspaceId);
  if (!ws) return "";
  const selected = rs.roles.find((r) => r.id === rs.selectedRoleId);
  const draft = rs.draft;

  const list = `
    <div class="roles-list">
      <div class="roles-list-header">
        <span>Роли</span>
        <button id="role-create" class="ghost" title="Создать роль">+</button>
      </div>
      <ul>
        ${rs.roles.map((r) => `
          <li class="roles-list-item ${r.id === rs.selectedRoleId ? "active" : ""}" data-select-role="${r.id}">
            <span class="role-color-dot" style="background:${r.color ?? "var(--text-mute)"};"></span>
            <span class="role-name">${escapeHtml(r.name)}</span>
            ${r.system ? `<span class="role-badge">sys</span>` : ""}
            ${r.hoisted ? `<span class="role-badge">★</span>` : ""}
            <span class="role-count">${r.memberUserIds.length}</span>
          </li>
        `).join("")}
      </ul>
    </div>
  `;

  const detail = (() => {
    if (!selected || !draft) return `<div class="roles-empty">Выберите роль или создайте новую</div>`;
    const dirty =
      draft.name !== selected.name ||
      draft.color !== (selected.color ?? "") ||
      draft.position !== selected.position ||
      draft.hoisted !== selected.hoisted ||
      JSON.stringify([...draft.baseActionMask].sort()) !== JSON.stringify([...selected.baseActionMask].sort());
    return `
      <div class="roles-detail">
        <div class="roles-detail-header">
          <input id="role-name" class="role-name-input" value="${escapeHtml(draft.name)}" maxlength="64" ${selected.system && selected.code === "owner" ? "disabled" : ""} />
          <span class="role-code-hint">code: ${escapeHtml(selected.code)}${selected.system ? " · system" : ""}</span>
        </div>
        <div class="roles-detail-row">
          <label class="role-field">
            <span>Цвет</span>
            <input id="role-color" type="color" value="${escapeHtml(draft.color || "#888888")}" />
            ${draft.color ? `<button id="role-color-clear" class="ghost" title="Без цвета">✕</button>` : ""}
          </label>
          <label class="role-field">
            <span>Позиция</span>
            <input id="role-position" type="number" min="0" step="1" value="${draft.position}" />
          </label>
          <label class="role-field role-field-check">
            <input id="role-hoisted" type="checkbox" ${draft.hoisted ? "checked" : ""} />
            <span>Отдельная секция в списке участников</span>
          </label>
        </div>
        <div class="roles-detail-section">
          <div class="roles-section-title">Права</div>
          <div class="roles-actions-grid">
            ${ALL_PERMISSION_ACTIONS.map((a) => `
              <label class="role-action-check">
                <input type="checkbox" data-role-action="${a}" ${draft.baseActionMask.includes(a) ? "checked" : ""} />
                <span>${escapeHtml(ACTION_LABELS_RU[a] ?? a)}</span>
              </label>
            `).join("")}
          </div>
        </div>
        <div class="roles-detail-section">
          <div class="roles-section-title">Участники (${selected.memberUserIds.length})</div>
          <div class="roles-members-grid">
            ${renderRoleMembersAssignment(selected)}
          </div>
        </div>
        <div class="roles-detail-actions">
          <button id="role-save" class="primary" ${dirty && !rs.saving ? "" : "disabled"}>${rs.saving ? "Сохраняем…" : "Сохранить"}</button>
          ${!selected.system ? `<button id="role-delete" class="danger">Удалить роль</button>` : ""}
          ${rs.error ? `<span class="roles-error">${escapeHtml(rs.error)}</span>` : ""}
        </div>
      </div>
    `;
  })();

  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide roles-modal" role="dialog">
        <div class="modal-header">
          <h3>Роли · ${escapeHtml(ws.name)}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="modal-body roles-modal-body">
          ${list}
          ${detail}
        </div>
      </div>
    </div>
  `;
}

async function openWorkspaceRolesModal(workspaceId: string): Promise<void> {
  state.modal = "workspaceRoles";
  state.workspaceRoles = {
    workspaceId,
    loading: true,
    saving: false,
    error: null,
    roles: [],
    selectedRoleId: null,
    draft: null
  };
  render();
  // Гарантируем что текущий ws соответствует — иначе renderRoleMembersAssignment
  // покажет state.members не от того воркспейса.
  if (state.selectedWorkspaceId !== workspaceId) {
    await selectWorkspace(workspaceId);
  } else if (state.members.length === 0) {
    await loadMembers();
  }
  await reloadWorkspaceRoles();
}

async function reloadWorkspaceRoles(): Promise<void> {
  const wsId = state.workspaceRoles.workspaceId;
  if (!wsId) return;
  state.workspaceRoles.loading = true;
  render();
  try {
    const data = await httpClient.get<{ items: WorkspaceRole[] }>(`/api/v1/workspaces/${wsId}/roles`);
    state.workspaceRoles.roles = data.items ?? [];
    if (!state.workspaceRoles.selectedRoleId && state.workspaceRoles.roles.length > 0) {
      state.workspaceRoles.selectedRoleId = state.workspaceRoles.roles[0].id;
    }
    syncWorkspaceRoleDraft();
    state.workspaceRoles.error = null;
  } catch (err) {
    state.workspaceRoles.error = describeError(err);
  } finally {
    state.workspaceRoles.loading = false;
    render();
  }
}

function syncWorkspaceRoleDraft(): void {
  const rs = state.workspaceRoles;
  const sel = rs.roles.find((r) => r.id === rs.selectedRoleId);
  if (!sel) {
    rs.draft = null;
    return;
  }
  rs.draft = {
    name: sel.name,
    color: sel.color ?? "",
    position: sel.position,
    hoisted: sel.hoisted,
    baseActionMask: [...sel.baseActionMask]
  };
}

function attachWorkspaceRolesHandlers(): void {
  if (state.modal !== "workspaceRoles") return;
  const rs = state.workspaceRoles;

  rootEl.querySelectorAll<HTMLElement>("[data-select-role]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.selectRole;
      if (!id || rs.selectedRoleId === id) return;
      rs.selectedRoleId = id;
      rs.error = null;
      syncWorkspaceRoleDraft();
      render();
    });
  });

  rootEl.querySelector<HTMLButtonElement>("#role-create")?.addEventListener("click", async () => {
    const wsId = rs.workspaceId;
    if (!wsId) return;
    const name = window.prompt("Имя новой роли:")?.trim();
    if (!name) return;
    const code = window.prompt("Код роли (a-z, 0-9, _-; уникальный в воркспейсе):", slugify(name))?.trim();
    if (!code) return;
    try {
      const created = await httpClient.post<WorkspaceRole>(`/api/v1/workspaces/${wsId}/roles`, {
        code,
        name,
        baseActionMask: ["message.write", "message.react", "message.attach", "message.mention"]
      });
      rs.selectedRoleId = created.id;
      await reloadWorkspaceRoles();
    } catch (err) {
      rs.error = describeError(err);
      render();
    }
  });

  // Все правки draft'а — напрямую в state без render(), чтобы не дёргать
  // фокус. render() зовём только перед сохранением и после ответа сервера.
  const draft = rs.draft;
  if (draft) {
    rootEl.querySelector<HTMLInputElement>("#role-name")?.addEventListener("input", (ev) => {
      draft.name = (ev.target as HTMLInputElement).value;
    });
    rootEl.querySelector<HTMLInputElement>("#role-color")?.addEventListener("input", (ev) => {
      draft.color = (ev.target as HTMLInputElement).value;
    });
    rootEl.querySelector<HTMLButtonElement>("#role-color-clear")?.addEventListener("click", () => {
      draft.color = "";
      render();
    });
    rootEl.querySelector<HTMLInputElement>("#role-position")?.addEventListener("input", (ev) => {
      const n = parseInt((ev.target as HTMLInputElement).value, 10);
      draft.position = Number.isFinite(n) ? n : 0;
    });
    rootEl.querySelector<HTMLInputElement>("#role-hoisted")?.addEventListener("change", (ev) => {
      draft.hoisted = (ev.target as HTMLInputElement).checked;
    });
    rootEl.querySelectorAll<HTMLInputElement>("[data-role-action]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const action = cb.dataset.roleAction;
        if (!action) return;
        if (cb.checked && !draft.baseActionMask.includes(action)) {
          draft.baseActionMask.push(action);
        } else if (!cb.checked) {
          draft.baseActionMask = draft.baseActionMask.filter((a) => a !== action);
        }
      });
    });
  }

  rootEl.querySelector<HTMLButtonElement>("#role-save")?.addEventListener("click", async () => {
    const wsId = rs.workspaceId;
    const sel = rs.roles.find((r) => r.id === rs.selectedRoleId);
    if (!wsId || !sel || !rs.draft) return;
    rs.saving = true;
    rs.error = null;
    render();
    try {
      const body: Record<string, unknown> = {
        name: rs.draft.name.trim(),
        position: rs.draft.position,
        hoisted: rs.draft.hoisted,
        baseActionMask: rs.draft.baseActionMask
      };
      // null цвета = «без цвета», иначе шлём hex.
      body.color = rs.draft.color ? rs.draft.color : null;
      const updated = await httpClient.patch<WorkspaceRole>(`/api/v1/workspaces/${wsId}/roles/${sel.id}`, body);
      rs.roles = rs.roles.map((r) => (r.id === updated.id ? updated : r));
      syncWorkspaceRoleDraft();
      // H.7: цвет роли мог поменяться — обновить кеш для member-sidebar
      // и .author в сообщениях.
      if (state.selectedWorkspaceId === wsId) {
        state.roleColors[updated.code] = updated.color ?? null;
      }
    } catch (err) {
      rs.error = describeError(err);
    } finally {
      rs.saving = false;
      render();
    }
  });

  rootEl.querySelector<HTMLButtonElement>("#role-delete")?.addEventListener("click", async () => {
    const wsId = rs.workspaceId;
    const sel = rs.roles.find((r) => r.id === rs.selectedRoleId);
    if (!wsId || !sel) return;
    if (!window.confirm(`Удалить роль «${sel.name}»? Назначения участникам исчезнут.`)) return;
    try {
      await httpClient.del(`/api/v1/workspaces/${wsId}/roles/${sel.id}`);
      rs.selectedRoleId = null;
      await reloadWorkspaceRoles();
    } catch (err) {
      rs.error = describeError(err);
      render();
    }
  });

  rootEl.querySelectorAll<HTMLInputElement>("[data-role-member]").forEach((cb) => {
    cb.addEventListener("change", async () => {
      const wsId = rs.workspaceId;
      const sel = rs.roles.find((r) => r.id === rs.selectedRoleId);
      const userId = cb.dataset.roleMember;
      if (!wsId || !sel || !userId) return;
      const previousChecked = !cb.checked;
      try {
        if (cb.checked) {
          await httpClient.post(`/api/v1/workspaces/${wsId}/roles/${sel.id}/members/${userId}`);
          sel.memberUserIds = [...sel.memberUserIds, userId];
        } else {
          await httpClient.del(`/api/v1/workspaces/${wsId}/roles/${sel.id}/members/${userId}`);
          sel.memberUserIds = sel.memberUserIds.filter((x) => x !== userId);
        }
      } catch (err) {
        cb.checked = previousChecked;
        rs.error = describeError(err);
        render();
      }
    });
  });
}

function renderRoleMembersAssignment(role: WorkspaceRole): string {
  // state.members — участники текущего канала. Для назначения нужны все
  // участники воркспейса; на данный момент в state.members лежат участники
  // ws (member-sidebar). Если пусто — лениво подсказываем загрузить.
  if (state.members.length === 0) {
    return `<div class="roles-empty">Откройте панель участников хотя бы раз, чтобы прогрузить список — он используется здесь же.</div>`;
  }
  const isOwnerRole = role.code === "owner";
  const sorted = [...state.members].sort((a, b) =>
    (a.displayName || a.username).localeCompare(b.displayName || b.username, "ru")
  );
  return sorted.map((m) => {
    const has = role.memberUserIds.includes(m.userId);
    return `
      <label class="role-member-row${isOwnerRole ? " locked" : ""}">
        <input type="checkbox" data-role-member="${escapeHtml(m.userId)}" ${has ? "checked" : ""} ${isOwnerRole ? "disabled" : ""} />
        <span>${escapeHtml(m.displayName || m.username)}</span>
        <span class="role-member-sub">@${escapeHtml(m.username)}</span>
      </label>
    `;
  }).join("");
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
        <div class="notif-time" title="${escapeHtml(formatTime(n.createdAt))}">${escapeHtml(formatTimeSmart(n.createdAt))}</div>
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
        <span class="search-hit-time" title="${escapeHtml(formatTime(hit.createdAt))}">${escapeHtml(formatTimeSmart(hit.createdAt))}</span>
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
          ${renderAuditFilter()}
          ${
            state.auditLoading
              ? `<div class="invites-empty">Загрузка…</div>`
              : (() => {
                  const filtered = applyAuditFilter(state.auditEntries);
                  if (state.auditEntries.length === 0) return `<div class="invites-empty">Событий пока нет</div>`;
                  if (filtered.length === 0) return `<div class="invites-empty">Под фильтр ничего не подошло</div>`;
                  return `<ul class="audit-list">
                    ${filtered
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
                  </ul>`;
                })()
          }
        </div>
      </div>
    </div>
  `;
}

function renderAuditFilter(): string {
  const f = state.auditFilter;
  const opts = Object.entries(AUDIT_ACTION_INFO)
    .map(([code, info]) => `<option value="${escapeHtml(code)}"${f.action === code ? " selected" : ""}>${escapeHtml(info.ru)}</option>`)
    .join("");
  return `
    <div class="audit-filter">
      <select id="audit-filter-action">
        <option value=""${!f.action ? " selected" : ""}>Все события</option>
        ${opts}
      </select>
      <input id="audit-filter-actor" type="text" placeholder="Имя автора…" value="${escapeHtml(f.actor)}" />
      ${(f.action || f.actor) ? `<button id="audit-filter-clear" class="ghost" title="Сбросить">✕</button>` : ""}
    </div>
  `;
}

function applyAuditFilter(entries: AuditEntry[]): AuditEntry[] {
  const f = state.auditFilter;
  const actorQ = f.actor.trim().toLowerCase();
  if (!f.action && !actorQ) return entries;
  return entries.filter((e) => {
    if (f.action && e.action !== f.action) return false;
    if (actorQ) {
      const actorName = e.actorId ? describePeer(e.actorId).toLowerCase() : "система";
      if (!actorName.includes(actorQ)) return false;
    }
    return true;
  });
}

// G.10: профиль-модалка в Discord-стиле — карточка с акцентным баннером
// (там же кнопка change-avatar), крупным аватаром поверх границы баннера,
// именем+username под ним, и списком inline-edit полей. Только один field
// активен одновременно (state.profileEdit.field), остальные показывают
// статичное значение и кнопку «Изменить».
function renderProfileModal(): string {
  const me = state.me;
  if (!me) return "";
  const editing = state.profileEdit.field;
  const displayName = me.displayName || me.username;
  return `
    <input id="profile-avatar-input" type="file" accept="image/*" hidden />
    <div class="modal-backdrop" data-modal-close>
      <div class="modal profile-card" role="dialog">
        <div class="profile-banner">
          <button class="ghost modal-close-btn profile-close" data-modal-close aria-label="Закрыть">✕</button>
        </div>
        <div class="profile-card-head">
          <div class="profile-card-avatar-wrap">
            ${renderAvatar({
              avatarMediaId: me.avatarMediaId,
              fallbackText: displayName,
              sizePx: 96,
              className: "profile-card-avatar"
            })}
            <button id="profile-avatar-upload" class="profile-card-avatar-edit" title="Сменить аватар">
              ${icon("pencil", { size: 14 })}
            </button>
            ${me.avatarMediaId
              ? `<button id="profile-avatar-remove" class="profile-card-avatar-remove" title="Удалить аватар">${icon("trash", { size: 12 })}</button>`
              : ""}
          </div>
          <div class="profile-card-name">
            <div class="profile-card-display">${escapeHtml(displayName)}</div>
            <div class="profile-card-username">@${escapeHtml(me.username)}</div>
          </div>
        </div>
        <div class="profile-card-fields">
          ${renderProfileField({
            label: "Отображаемое имя",
            value: me.displayName || "—",
            field: "displayName",
            editing: editing === "displayName",
            body: renderProfileEditDisplayName(me.displayName ?? "")
          })}
          ${renderProfileField({
            label: "Имя пользователя",
            value: "@" + me.username,
            field: "username",
            editing: false,
            disabled: true,
            disabledHint: "Username нельзя сменить — стабильный идентификатор для упоминаний @user.",
            body: ""
          })}
          ${renderProfileField({
            label: "Электронная почта",
            value: me.email,
            field: "email",
            editing: false,
            disabled: true,
            disabledHint: "Смена email требует подтверждения по почте — не реализовано (F.6).",
            body: ""
          })}
          ${renderProfileField({
            label: "Пароль",
            value: "••••••••",
            field: "password",
            editing: editing === "password",
            body: renderProfileEditPassword()
          })}
        </div>
        <div class="profile-card-footer">
          <button id="profile-logout-btn" class="profile-logout-btn">${icon("log-out")} Выйти из аккаунта</button>
        </div>
      </div>
    </div>
  `;
}

interface ProfileFieldOpts {
  label: string;
  value: string;
  field: "displayName" | "username" | "email" | "password";
  editing: boolean;
  disabled?: boolean;
  disabledHint?: string;
  body: string;
}

function renderProfileField(opts: ProfileFieldOpts): string {
  if (opts.editing) {
    return `
      <div class="profile-field profile-field-editing" data-profile-field="${opts.field}">
        <div class="profile-field-label">${escapeHtml(opts.label)}</div>
        ${opts.body}
      </div>
    `;
  }
  const action = opts.disabled
    ? `<span class="profile-field-disabled" title="${escapeHtml(opts.disabledHint ?? "")}">недоступно</span>`
    : `<button class="ghost profile-field-edit" data-profile-edit="${opts.field}">Изменить</button>`;
  return `
    <div class="profile-field" data-profile-field="${opts.field}">
      <div class="profile-field-info">
        <div class="profile-field-label">${escapeHtml(opts.label)}</div>
        <div class="profile-field-value${opts.disabled ? " is-disabled" : ""}">${escapeHtml(opts.value)}</div>
        ${opts.disabled && opts.disabledHint ? `<div class="profile-field-hint">${escapeHtml(opts.disabledHint)}</div>` : ""}
      </div>
      ${action}
    </div>
  `;
}

function renderProfileEditDisplayName(currentValue: string): string {
  const pe = state.profileEdit;
  const errBlock = pe.error ? `<div class="modal-error">${escapeHtml(pe.error)}</div>` : "";
  return `
    <input id="profile-display-input" type="text" maxlength="64"
           placeholder="${escapeHtml(currentValue || "Как тебя видят другие")}"
           value="${escapeHtml(pe.draftDisplayName)}" />
    ${errBlock}
    <div class="profile-field-actions">
      <button class="ghost" data-profile-cancel>Отмена</button>
      <button id="profile-display-save" class="primary" ${pe.saving ? "disabled" : ""}>
        ${pe.saving ? "Сохранение…" : "Сохранить"}
      </button>
    </div>
  `;
}

function renderProfileEditPassword(): string {
  const pe = state.profileEdit;
  const errBlock = pe.error ? `<div class="modal-error">${escapeHtml(pe.error)}</div>` : "";
  const okBlock = pe.okMessage ? `<div class="profile-field-ok">${escapeHtml(pe.okMessage)}</div>` : "";
  return `
    <div class="profile-pw-grid">
      <label>
        <span class="profile-pw-label">Текущий пароль</span>
        <input id="profile-pw-current" type="password" autocomplete="current-password" value="${escapeHtml(pe.currentPassword)}" />
      </label>
      <label>
        <span class="profile-pw-label">Новый пароль (мин. 8)</span>
        <input id="profile-pw-new" type="password" autocomplete="new-password" minlength="8" value="${escapeHtml(pe.newPassword)}" />
      </label>
      <label>
        <span class="profile-pw-label">Подтверждение</span>
        <input id="profile-pw-confirm" type="password" autocomplete="new-password" minlength="8" value="${escapeHtml(pe.confirmPassword)}" />
      </label>
    </div>
    ${errBlock}
    ${okBlock}
    <div class="profile-field-actions">
      <button class="ghost" data-profile-cancel>Отмена</button>
      <button id="profile-pw-save" class="primary" ${pe.saving ? "disabled" : ""}>
        ${pe.saving ? "Сохранение…" : "Сохранить пароль"}
      </button>
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
        ${!isSelf ? `<button class="ghost member-dm" data-user-id="${m.userId}" title="Личное сообщение">${icon("reply")}</button>` : ""}
        ${showCall ? `<button class="ghost member-call" data-user-id="${m.userId}" title="Позвонить">${icon("phone")}</button>` : ""}
        ${showKick ? `<button class="ghost member-kick" data-user-id="${m.userId}" title="Удалить">${icon("trash")}</button>` : ""}
      </td>
    </tr>
  `;
}

function attachShellHandlers(): void {
  rootEl.querySelector<HTMLButtonElement>("#profile-logout-btn")?.addEventListener("click", () => {
    if (!confirm("Выйти из аккаунта?")) return;
    void httpClient.logout();
  });

  rootEl.querySelector<HTMLButtonElement>("#open-profile")?.addEventListener("click", () => {
    state.modal = "profile";
    render();
  });

  rootEl.querySelector<HTMLButtonElement>("#open-status")?.addEventListener("click", (ev) => {
    const target = ev.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    // Открываем popup НАД user-strip'ом (Discord-like): фиксируем нижний
    // край popup'а к верху кнопки. Слева — у кнопки.
    state.statusMenu = {
      x: Math.max(8, rect.left),
      y: Math.max(8, rect.top - 8),
      draftMode: (state.me?.presenceMode as PresenceMode) ?? "online",
      draftCustom: state.me?.customStatus ?? ""
    };
    render();
  });

  rootEl.querySelector<HTMLElement>("[data-status-menu-close]")?.addEventListener("click", () => {
    state.statusMenu = null;
    render();
  });

  rootEl.querySelectorAll<HTMLButtonElement>("[data-status-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!state.statusMenu) return;
      state.statusMenu.draftMode = btn.dataset.statusMode as PresenceMode;
      render();
    });
  });

  const statusCustomInput = rootEl.querySelector<HTMLInputElement>("#status-custom-input");
  if (statusCustomInput) {
    statusCustomInput.addEventListener("input", () => {
      if (state.statusMenu) state.statusMenu.draftCustom = statusCustomInput.value;
    });
  }

  rootEl.querySelector<HTMLButtonElement>("#status-clear")?.addEventListener("click", () => {
    if (!state.statusMenu) return;
    state.statusMenu.draftCustom = "";
    void saveStatus("online", "");
  });

  rootEl.querySelector<HTMLButtonElement>("#status-save")?.addEventListener("click", () => {
    if (!state.statusMenu) return;
    const { draftMode, draftCustom } = state.statusMenu;
    void saveStatus(draftMode, draftCustom);
  });

  rootEl.querySelector<HTMLButtonElement>("#open-members")?.addEventListener("click", async () => {
    state.modal = "members";
    render();
    await loadMembers();
  });

  rootEl.querySelector<HTMLSelectElement>("#audit-filter-action")?.addEventListener("change", (ev) => {
    state.auditFilter.action = (ev.currentTarget as HTMLSelectElement).value;
    render();
  });
  rootEl.querySelector<HTMLInputElement>("#audit-filter-actor")?.addEventListener("input", (ev) => {
    state.auditFilter.actor = (ev.currentTarget as HTMLInputElement).value;
    // Без render() — обновляем только список. Но фильтр живёт в state и
    // applyAuditFilter, поэтому надо ререндер. Каретку сохраняем через PRESERVED_INPUT_SELECTORS.
    render();
  });
  rootEl.querySelector<HTMLButtonElement>("#audit-filter-clear")?.addEventListener("click", () => {
    state.auditFilter = { action: "", actor: "" };
    render();
  });

  rootEl.querySelector<HTMLButtonElement>("#open-audit")?.addEventListener("click", async () => {
    state.modal = "audit";
    state.auditFilter = { action: "", actor: "" };
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

  attachProfileEditHandlers();

  // G.10: кнопка «карандаш» поверх аватара триггерит hidden file-input.
  rootEl.querySelector<HTMLButtonElement>("#profile-avatar-upload")?.addEventListener("click", () => {
    rootEl.querySelector<HTMLInputElement>("#profile-avatar-input")?.click();
  });

  // H.1: загрузка аватара. Двухступенчато: (1) POST /uploads c image-файлом
  // через существующий attachment-pipeline → получаем mediaId; (2) PUT
  // /users/me/avatar c этим mediaId → бэк ставит users.avatar_media_id и
  // возвращает обновлённую meView. Делаем поэтапно а не одним multipart'ом,
  // чтобы переиспользовать уже работающую загрузку файлов (квоты, ACL,
  // MinIO-pipeline).
  rootEl.querySelector<HTMLInputElement>("#profile-avatar-input")?.addEventListener("change", async (e) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      state.status = "Аватар должен быть картинкой";
      render();
      return;
    }
    try {
      state.status = "Загрузка аватара…";
      render();
      const uploaded = await httpClient.uploadFile<PendingUpload>("/api/v1/uploads", file);
      const updated = await httpClient.put<Me & { updatedAt: string }>(
        "/api/v1/users/me/avatar",
        { mediaId: uploaded.id }
      );
      if (state.me) {
        state.me = {
          ...state.me,
          avatarMediaId: updated.avatarMediaId,
          displayName: updated.displayName ?? state.me.displayName
        };
      }
      setTransientStatus("Аватар обновлён");
    } catch (err) {
      state.status = describeError(err);
      render();
    } finally {
      input.value = "";
    }
  });

  rootEl.querySelector<HTMLButtonElement>("#profile-avatar-remove")?.addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      const updated = await httpClient.del<Me & { updatedAt: string }>("/api/v1/users/me/avatar");
      if (state.me) {
        state.me = { ...state.me, avatarMediaId: undefined, displayName: updated.displayName ?? state.me.displayName };
      }
      setTransientStatus("Аватар удалён");
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

  rootEl.querySelectorAll<HTMLButtonElement>(".member-dm").forEach((btn) => {
    btn.addEventListener("click", () => {
      const userId = btn.dataset.userId;
      if (!userId) return;
      state.modal = null;
      void openDMWith({ userId });
    });
  });

  // Клик по карточке в member-sidebar → Discord-style profile-popup
  // с кнопками «Сообщение» и «Позвонить». Self-клик игнорится.
  rootEl.querySelectorAll<HTMLElement>(".member-sidebar-item[data-member-user]").forEach((el) => {
    el.addEventListener("click", () => {
      const userId = el.getAttribute("data-member-user");
      if (!userId || userId === state.me?.id) return;
      openUserProfile(userId);
    });
  });

  rootEl.querySelector<HTMLButtonElement>(".user-profile-dm")?.addEventListener("click", (ev) => {
    const userId = (ev.currentTarget as HTMLButtonElement).dataset.userId;
    if (!userId) return;
    state.modal = null;
    state.userProfileTarget = null;
    void openDMWith({ userId });
  });

  rootEl.querySelector<HTMLButtonElement>(".user-profile-call")?.addEventListener("click", async (ev) => {
    const userId = (ev.currentTarget as HTMLButtonElement).dataset.userId;
    if (!userId) return;
    try {
      state.modal = null;
      state.userProfileTarget = null;
      await callMgr.placeCall(userId);
    } catch (err) {
      state.status = describeError(err);
      render();
    }
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
        const preset = SCREEN_SHARE_PRESETS[state.screenShareQuality];
        await voiceMgr.toggleScreenShare(preset);
      } catch (err) {
        state.status = describeError(err);
        render();
      }
    });
  }
  for (const sel of rootEl.querySelectorAll<HTMLSelectElement>(".screen-quality-select")) {
    sel.addEventListener("change", () => {
      const v = sel.value;
      if (v in SCREEN_SHARE_PRESETS) {
        state.screenShareQuality = v as ScreenShareQualityKey;
        try { localStorage.setItem("rucord:screenShareQuality", v); } catch { /* ignore */ }
        // Если уже шарим — переприменяем encoding без переподключения.
        const snap = voiceMgr.getSnapshot();
        if (snap.screenSharing) {
          void voiceMgr.applyScreenShareQuality(SCREEN_SHARE_PRESETS[v as ScreenShareQualityKey]);
        }
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

  rootEl.querySelector<HTMLButtonElement>("#ws-rail-dm")?.addEventListener("click", () => {
    enterDMMode();
  });

  rootEl.querySelectorAll<HTMLElement>("[data-ws]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.ws;
      if (!id) return;
      if (state.dmMode) {
        exitDMMode(id);
      } else if (id !== state.selectedWorkspaceId) {
        void selectWorkspace(id);
      }
    });
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const id = el.dataset.ws;
      if (!id) return;
      const x = Math.min(ev.clientX, window.innerWidth - 220);
      const y = Math.min(ev.clientY, window.innerHeight - 160);
      state.workspaceMenu = { workspaceId: id, x, y };
      render();
    });
  });

  rootEl.querySelectorAll<HTMLLIElement>("[data-ch]").forEach((li) => {
    li.addEventListener("click", () => {
      const id = li.dataset.ch;
      if (id && id !== state.selectedChannelId) void selectChannel(id);
    });
    li.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const id = li.dataset.ch;
      if (!id) return;
      // Меню рендерится absolute по координатам курсора; зажимаем по краям
      // вьюпорта, чтобы не уехать за экран (ширина меню ~200px).
      const x = Math.min(ev.clientX, window.innerWidth - 220);
      const y = Math.min(ev.clientY, window.innerHeight - 160);
      state.channelMenu = { channelId: id, x, y };
      render();
    });
  });

  // G.8: клик на DM-айтем в sidebar или home-карточку
  rootEl.querySelectorAll<HTMLElement>("[data-dm]").forEach((el) => {
    el.addEventListener("click", (ev) => {
      // Игнорим клик на кнопке закрытия — обрабатывается отдельным listener'ом.
      if ((ev.target as HTMLElement).closest("[data-dm-close]")) return;
      const id = el.dataset.dm;
      if (id && id !== state.selectedChannelId) void selectChannel(id);
    });
  });

  // Скрытие DM из списка (клиентский UX-фильтр; backend всё ещё хранит канал,
  // в любой момент можно открыть заново через find). Не путать с «удалить
  // DM навсегда» — этого нет ни на бэке, ни в Discord-like UX.
  rootEl.querySelectorAll<HTMLButtonElement>("[data-dm-close]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const id = btn.dataset.dmClose;
      if (!id) return;
      state.dms = state.dms.filter((d) => d.channelId !== id);
      if (state.selectedChannelId === id) {
        state.selectedChannelId = null;
        state.messages = [];
      }
      // Не пересчитываем dmUnreadTotal — скрытый DM продолжит приходить
      // через realtime и заново появится при openDMWith или dm.opened.
      render();
    });
  });

  // Кнопка «+» в DM-sidebar — сбросить выбор и показать home (фокус инпута).
  rootEl.querySelector<HTMLButtonElement>("#dm-find-btn")?.addEventListener("click", () => {
    state.selectedChannelId = null;
    state.messages = [];
    state.dmFindError = null;
    render();
    rootEl.querySelector<HTMLInputElement>("#dm-find-input")?.focus();
  });

  // Форма «Найти или начать беседу» на home-экране DM.
  const dmFindForm = rootEl.querySelector<HTMLFormElement>("#dm-find-form");
  const dmFindInput = rootEl.querySelector<HTMLInputElement>("#dm-find-input");
  if (dmFindForm && dmFindInput) {
    dmFindInput.addEventListener("input", () => {
      state.dmFindQuery = dmFindInput.value;
      // не вызываем render(), чтобы не сбросить каретку — query фиксируется при submit
    });
    dmFindForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const raw = dmFindInput.value.trim().toLowerCase().replace(/^@/, "");
      if (!raw) {
        state.dmFindError = "Введи username";
        render();
        return;
      }
      void openDMWith({ username: raw });
    });
  }

  rootEl.querySelector<HTMLElement>("[data-channel-menu-close]")?.addEventListener("click", () => {
    state.channelMenu = null;
    render();
  });

  rootEl.querySelector<HTMLElement>("[data-workspace-menu-close]")?.addEventListener("click", () => {
    state.workspaceMenu = null;
    render();
  });

  // H.2: ПКМ-меню воркспейса — загрузка/удаление иконки + copy ID.
  // Upload — двухступенчатый: POST /uploads (existing media-pipeline,
  // переиспользует квоты и MinIO-store), затем PUT /workspaces/{id}/avatar
  // с полученным mediaId. Все права проверяет бэк.
  rootEl.querySelectorAll<HTMLButtonElement>("[data-workspace-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.workspaceAction;
      const id = btn.dataset.id;
      if (!id || !action) return;
      state.workspaceMenu = null;
      const ws = state.workspaces.find((w) => w.id === id);
      if (!ws) {
        render();
        return;
      }
      if (action === "copy-id") {
        try {
          await navigator.clipboard.writeText(id);
          state.status = `ID воркспейса «${ws.name}» скопирован`;
        } catch {
          state.status = "Не удалось скопировать";
        }
        render();
        return;
      }
      if (action === "remove-icon") {
        if (!window.confirm(`Удалить иконку воркспейса «${ws.name}»?`)) {
          render();
          return;
        }
        try {
          const updated = await httpClient.del<Workspace>(`/api/v1/workspaces/${id}/avatar`);
          state.workspaces = state.workspaces.map((w) => (w.id === id ? { ...w, avatarMediaId: updated.avatarMediaId } : w));
        } catch (err) {
          state.status = describeError(err);
        }
        render();
        return;
      }
      if (action === "upload-icon") {
        const input = rootEl.querySelector<HTMLInputElement>("#workspace-avatar-input");
        if (!input) {
          render();
          return;
        }
        input.onchange = async () => {
          const file = input.files?.[0];
          input.value = "";
          if (!file) return;
          try {
            const uploaded = await httpClient.uploadFile<PendingUpload>("/api/v1/uploads", file);
            const updated = await httpClient.put<Workspace>(`/api/v1/workspaces/${id}/avatar`, { mediaId: uploaded.id });
            state.workspaces = state.workspaces.map((w) => (w.id === id ? { ...w, avatarMediaId: updated.avatarMediaId } : w));
            state.status = `Иконка воркспейса «${ws.name}» обновлена`;
          } catch (err) {
            state.status = describeError(err);
          }
          render();
        };
        input.click();
        return;
      }
      if (action === "manage-roles") {
        await openWorkspaceRolesModal(id);
        return;
      }
      if (action === "welcome-channel") {
        await openWelcomeChannelModal(id);
        return;
      }
    });
  });

  attachWorkspaceRolesHandlers();

  rootEl.querySelector<HTMLButtonElement>("#welcome-channel-save")?.addEventListener("click", () => {
    const sel = rootEl.querySelector<HTMLSelectElement>("#welcome-channel-select");
    const wsId = state.selectedWorkspaceId;
    if (!sel || !wsId) return;
    void saveWelcomeChannel(wsId, sel.value || null);
  });

  rootEl.querySelector<HTMLButtonElement>("#toggle-member-sidebar")?.addEventListener("click", () => {
    state.memberSidebarOpen = !state.memberSidebarOpen;
    render();
  });

  rootEl.querySelector<HTMLElement>("[data-voice-volume-close]")?.addEventListener("click", () => {
    state.voiceVolumeMenu = null;
    render();
  });

  // Слайдер обновляет state и громкость <video> напрямую — без render(),
  // иначе сам слайдер пересоздался бы на каждом движении и терял
  // captured pointer (drag прервался бы).
  const volSlider = rootEl.querySelector<HTMLInputElement>("#voice-volume-slider");
  if (volSlider && state.voiceVolumeMenu) {
    const key = state.voiceVolumeMenu.key;
    const applyVolume = (raw: number) => {
      const v = Math.max(0, Math.min(2, raw / 100));
      state.voiceVolumes[key] = v;
      const selector = key === "call-remote"
        ? `video[data-call-remote]`
        : `video[data-voice-peer="${CSS.escape(key)}"]`;
      for (const el of rootEl.querySelectorAll<HTMLVideoElement>(selector)) {
        el.volume = Math.min(1, v); // HTMLMediaElement.volume cap = 1.0
      }
      const valueEl = rootEl.querySelector<HTMLElement>(".voice-volume-value");
      if (valueEl) valueEl.textContent = `${Math.round(v * 100)}%`;
    };
    volSlider.addEventListener("input", () => applyVolume(Number(volSlider.value)));
  }
  rootEl.querySelector<HTMLElement>("[data-voice-volume-reset]")?.addEventListener("click", () => {
    if (!state.voiceVolumeMenu) return;
    const key = state.voiceVolumeMenu.key;
    delete state.voiceVolumes[key];
    state.voiceVolumeMenu = null;
    render();
  });

  rootEl.querySelectorAll<HTMLButtonElement>("[data-channel-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.channelAction;
      const id = btn.dataset.id;
      if (!id || !action) return;
      state.channelMenu = null;
      const ch = state.channels.find((c) => c.id === id);
      if (!ch) {
        render();
        return;
      }
      if (action === "copy-id") {
        try {
          await navigator.clipboard.writeText(id);
          state.status = `ID канала #${ch.name} скопирован`;
        } catch {
          state.status = "Не удалось скопировать";
        }
        render();
        return;
      }
      if (action === "mark-read") {
        // Берём последнее сообщение канала, если оно загружено — иначе
        // просто шлём read без курсора (бэк интерпретирует как «текущий момент»
        // — см. message-module/handleRead). Безопасно: повторный POST идемпотентен.
        const last = state.selectedChannelId === id && state.messages.length > 0
          ? state.messages[state.messages.length - 1].id
          : "";
        try {
          await httpClient.post(`/api/v1/channels/${id}/read`, last ? { messageId: last } : {});
          state.unread[id] = 0;
        } catch (err) {
          state.status = describeError(err);
        }
        render();
        return;
      }
      if (action === "invite") {
        // Существующая модалка инвайтов завязана на workspace. Открываем её
        // и подсказываем юзеру выбрать конкретный канал внутри.
        state.invitesOpen = true;
        state.status = `Создай инвайт в воркспейс — он привяжет нового участника, а доступ к #${ch.name} даст admin'у через настройки канала.`;
        render();
        return;
      }
      if (action === "mute") {
        if (state.mutedChannels.has(id)) {
          state.mutedChannels.delete(id);
        } else {
          state.mutedChannels.add(id);
        }
        render();
        return;
      }
      if (action === "clone") {
        // Backend ещё не имеет /clone — постим обычный create с такими же
        // полями. kind клонируется, имя — "<имя>-копия" (если уже есть, бэк
        // вернёт 409 — мы покажем ошибку, юзер переименует).
        const baseName = ch.name.length > 56 ? ch.name.slice(0, 56) : ch.name;
        try {
          const created = await httpClient.post<Channel>(
            `/api/v1/workspaces/${ch.workspaceId}/channels`,
            {
              kind: ch.kind,
              name: `${baseName}-копия`,
              topic: ch.topic ?? "",
              isPrivate: ch.isPrivate
            }
          );
          if (created && !state.channels.some((c) => c.id === created.id)) {
            state.channels = [...state.channels, created];
          }
        } catch (err) {
          state.status = describeError(err);
        }
        render();
        return;
      }
      if (action === "rename") {
        const next = window.prompt("Новое имя канала:", ch.name)?.trim();
        if (!next || next === ch.name) {
          render();
          return;
        }
        try {
          await httpClient.patch<Channel>(`/api/v1/channels/${id}`, { name: next });
          // realtime channel.updated догонит локальный state, но если
          // публикация не сработает (нет realtimebus в этой инстанции) —
          // апдейтим оптимистично.
          state.channels = state.channels.map((c) => (c.id === id ? { ...c, name: next } : c));
        } catch (err) {
          state.status = describeError(err);
        }
        render();
        return;
      }
      if (action === "delete") {
        if (!window.confirm(`Удалить канал #${ch.name}? История сообщений и вложения удалятся безвозвратно.`)) {
          render();
          return;
        }
        try {
          await httpClient.del(`/api/v1/channels/${id}`);
          state.channels = state.channels.filter((c) => c.id !== id);
          if (state.selectedChannelId === id) {
            state.selectedChannelId = null;
            state.messages = [];
          }
        } catch (err) {
          state.status = describeError(err);
        }
        render();
        return;
      }
    });
  });

  rootEl.querySelector<HTMLButtonElement>("#ws-rail-create")?.addEventListener("click", async () => {
    const name = window.prompt("Имя нового воркспейса:")?.trim();
    if (!name) return;
    const slug = slugify(name);
    if (slug.length < 3) {
      state.status = "Имя должно содержать минимум 3 буквы/цифры для генерации адреса.";
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

  rootEl.querySelector<HTMLButtonElement>("#ws-rail-invite")?.addEventListener("click", async () => {
    const code = window.prompt("Введите код инвайта:")?.trim();
    if (!code) return;
    try {
      const res = await httpClient.post<{ workspaceId: string; role: string }>(
        `/api/v1/invites/${encodeURIComponent(code)}/accept`
      );
      await loadWorkspaces();
      realtimeClient.reconnect();
      await selectWorkspace(res.workspaceId);
      setTransientStatus("Вы вступили в воркспейс");
    } catch (err) {
      state.status = describeError(err);
      render();
    }
  });

  // H.6: открыть модалку создания канала (заменила window.prompt). data-create-kind
  // приходит с кнопки «+» рядом с заголовком категории (text/voice). Только
  // ch-category-add в channels-block, не #dm-find-btn (тот тоже .ch-category-add
  // — нужно явно фильтровать по data-create-kind).
  rootEl.querySelectorAll<HTMLButtonElement>(".ch-category-add[data-create-kind]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      if (!state.selectedWorkspaceId) return;
      const kind = (btn.dataset.createKind as "text" | "voice" | undefined) ?? "text";
      openCreateChannelModal(state.selectedWorkspaceId, kind);
    });
  });
  attachCreateChannelHandlers();
  attachWorkspaceSettingsHandlers();

  rootEl.querySelector<HTMLButtonElement>("#open-ws-settings")?.addEventListener("click", () => {
    if (state.selectedWorkspaceId) openWorkspaceSettings(state.selectedWorkspaceId);
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
        setTransientStatus("Код скопирован");
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

  // H.1: lazy-load аватары. Тот же mediaBlobCache что и для attachments,
  // ключ — `/api/v1/media/<id>`. Слот с .avatar-pic.has-media рендерит
  // letter-placeholder под <img> — placeholder остаётся видим, пока blob
  // не приехал; при успешной загрузке мы добавляем <img> сверху (placeholder
  // буква скрыта CSS'ом когда есть .avatar-pic img).
  rootEl.querySelectorAll<HTMLSpanElement>(".avatar-pic.has-media").forEach((slot) => {
    const mediaId = slot.dataset.avatarMedia;
    if (!mediaId) return;
    if (slot.querySelector("img")) return;
    const url = `/api/v1/media/${mediaId}`;
    const cached = mediaBlobCache.get(url);
    if (cached) {
      slot.insertAdjacentHTML("afterbegin", `<img class="avatar-img" src="${cached}" alt="" />`);
      return;
    }
    void (async () => {
      try {
        const blob = await httpClient.getBlob(url);
        const blobUrl = URL.createObjectURL(blob);
        mediaBlobCache.set(url, blobUrl);
        const fresh = rootEl.querySelector<HTMLSpanElement>(
          `.avatar-pic.has-media[data-avatar-media="${CSS.escape(mediaId)}"]`
        );
        // Может быть несколько слотов с тем же media-id (мой аватар в
        // user-strip и в моих сообщениях). Заполним все.
        rootEl.querySelectorAll<HTMLSpanElement>(
          `.avatar-pic.has-media[data-avatar-media="${CSS.escape(mediaId)}"]`
        ).forEach((s) => {
          if (s.querySelector("img")) return;
          s.insertAdjacentHTML("afterbegin", `<img class="avatar-img" src="${blobUrl}" alt="" />`);
        });
        void fresh;
      } catch {
        // оставляем letter-placeholder
      }
    })();
  });

  // H.2: иконки воркспейсов в ws-rail. Reuse того же mediaBlobCache.
  // ws-rail-icon — это button, не .avatar-pic, поэтому отдельный селектор;
  // <img class="ws-rail-img"> вставляется внутрь, letter-placeholder скрывается
  // CSS-правилом `.ws-rail-icon:has(.ws-rail-img) .ws-rail-letter`.
  rootEl.querySelectorAll<HTMLButtonElement>(".ws-rail-icon[data-avatar-media]").forEach((slot) => {
    const mediaId = slot.dataset.avatarMedia;
    if (!mediaId) return;
    // GIF hover-swap: один обработчик на slot, переключает src между static и
    // animated. Срабатывает только если у img есть data-anim-src ≠ data-static-src
    // (для не-gif этот атрибут будет одинаковым → swap no-op).
    if (!slot.dataset.hoverBound) {
      slot.dataset.hoverBound = "1";
      slot.addEventListener("mouseenter", () => {
        const img = slot.querySelector<HTMLImageElement>(".ws-rail-img");
        if (img && img.dataset.animSrc) img.src = img.dataset.animSrc;
      });
      slot.addEventListener("mouseleave", () => {
        const img = slot.querySelector<HTMLImageElement>(".ws-rail-img");
        if (img && img.dataset.staticSrc) img.src = img.dataset.staticSrc;
      });
    }
    if (slot.querySelector("img")) return;
    const url = `/api/v1/media/${mediaId}`;
    const cached = mediaBlobCache.get(url);
    if (cached) {
      const staticFrame = gifStaticCache.get(url);
      insertWsRailImg(slot, cached, staticFrame);
      return;
    }
    void (async () => {
      try {
        const blob = await httpClient.getBlob(url);
        const blobUrl = URL.createObjectURL(blob);
        mediaBlobCache.set(url, blobUrl);
        const staticFrame = await extractFirstFrame(blob, blobUrl);
        if (staticFrame) gifStaticCache.set(url, staticFrame);
        rootEl.querySelectorAll<HTMLButtonElement>(
          `.ws-rail-icon[data-avatar-media="${CSS.escape(mediaId)}"]`
        ).forEach((s) => {
          if (s.querySelector("img")) return;
          insertWsRailImg(s, blobUrl, staticFrame ?? undefined);
        });
      } catch {
        // letter остаётся видимой
      }
    })();
  });

  // mention-автокомплит: ловим `@<prefix>` перед каретой и показываем
  // popup. Все обновления — direct DOM, чтобы не дёргать render() и не
  // терять фокус/курсор в input'е (см. техдолг про инкрементальный апдейт).
  const composerInput = rootEl.querySelector<HTMLInputElement>('#send-form input[name="body"]');
  const mentionPopup = rootEl.querySelector<HTMLDivElement>("#mention-popup");
  if (composerInput && mentionPopup) {
    composerInput.addEventListener("input", () => {
      saveDraft(state.selectedChannelId, composerInput.value);
      updateMentionPopup(composerInput, mentionPopup);
    });
    composerInput.addEventListener("click", () => updateMentionPopup(composerInput, mentionPopup));
    composerInput.addEventListener("keyup", (ev) => {
      // ArrowLeft/Right двигают каретку — пересчитаем токен. Стрелки
      // вверх/вниз и Enter обрабатываются на keydown ниже.
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight" || ev.key === "Home" || ev.key === "End") {
        updateMentionPopup(composerInput, mentionPopup);
      }
    });
    composerInput.addEventListener("keydown", (ev) => {
      // Edit прошлого своего сообщения по стрелке вверх (Discord/Slack):
      // пустой композер + ArrowUp + не активен mention-popup и не идёт edit.
      if (
        ev.key === "ArrowUp" &&
        composerInput.value === "" &&
        !state.editingMessageId &&
        (!state.mentionAutocomplete || mentionPopup.hidden)
      ) {
        const myId = state.me?.id;
        if (myId) {
          for (let i = state.messages.length - 1; i >= 0; i--) {
            const m = state.messages[i];
            if (m.authorId !== myId) continue;
            if (m.kind && m.kind !== "user") continue;
            if (m.deletedAt) continue;
            ev.preventDefault();
            state.editingMessageId = m.id;
            state.pickerForMessageId = null;
            render();
            return;
          }
        }
      }
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
    const channelIdSnapshot = state.selectedChannelId;
    input.value = "";
    saveDraft(channelIdSnapshot, "");
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
      saveDraft(channelIdSnapshot, body);
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
    list.addEventListener("click", (ev) => {
      const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-spoiler]");
      if (target && !target.classList.contains("revealed")) {
        target.classList.add("revealed");
        ev.stopPropagation();
      }
    });
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

// formatTimeSmartShort — «14:32». Используется как hover-метка в группе
// сообщений одного автора (Discord-pattern: первое сообщение группы
// показывает полную дату, последующие — только HH:MM при hover'е).
function formatTimeSmartShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// formatTimeSmart — «Сегодня в 14:32» / «Вчера в 23:01» / «18.05.2026 в 14:32».
// Discord-pattern: timestamps в потоке сообщений и в notifications читаются
// глазом мгновенно, без перевода даты в голове.
function formatTimeSmart(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfMsgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfDay - startOfMsgDay) / 86400000);
  const hm = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (dayDiff === 0) return `Сегодня в ${hm}`;
  if (dayDiff === 1) return `Вчера в ${hm}`;
  if (dayDiff > 1 && dayDiff < 7) {
    const weekday = date.toLocaleDateString("ru-RU", { weekday: "long" });
    return `${weekday} в ${hm}`;
  }
  const dmy = date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${dmy} в ${hm}`;
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
    setTransientStatus("Права канала сохранены");
  } catch (err) {
    state.channelSettings.error = describeError(err);
  } finally {
    state.channelSettings.saving = false;
    render();
  }
}
