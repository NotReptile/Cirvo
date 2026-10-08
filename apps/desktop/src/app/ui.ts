import type { CallManager, CallSnapshot } from "../call/callManager";
import type { VoiceChannelManager, VoiceSnapshot } from "../call/voiceChannelManager";
import type { ApiError, HttpClient } from "../network/httpClient";
import { isSessionRejected } from "../network/httpClient";
import type { RealtimeClient, RealtimeEvent, ConnectionState } from "../realtime/realtimeClient";
import { icon } from "./icons";
import type { ScreenShareQuality } from "../call/voiceChannelManager";
import { runIceCheck, type IceCheckResult } from "../call/iceCheck";
import { checkForUpdate, relaunchApp, type UpdateHandle } from "./tauriUpdater";
import { openLightbox } from "./lightbox";
import { openEmojiPicker } from "./emojiPicker";
import { highlightCode } from "./codeHighlight";
import {
  INSECURE_SERVER_WARNING,
  ServerCheckError,
  checkServerReachable,
  clearStoredServerUrl,
  getStoredServerUrl,
  isInsecureServerUrl,
  isProductionShell
} from "./serverConfig";
import {
  applyAppearance,
  getAppearance,
  updateAppearance,
  watchSystemTheme,
  type Density,
  type GifAvatarsMode,
  type ThemeMode
} from "./appearance";
import {
  chordFromEvent,
  dispatchKeyDown as dispatchHotkeyDown,
  dispatchKeyUp as dispatchHotkeyUp,
  formatChord,
  getActions as getHotkeyActions,
  getBinding as getHotkeyBinding,
  onBindingChange,
  registerHotkey,
  releaseAllHold,
  resetBinding as resetHotkeyBinding,
  setBindingChord as setHotkeyChord,
  setBindingEnabled as setHotkeyEnabled,
  type ActionDef,
  type ActionId
} from "./hotkeys";
import {
  setHandlers as setGlobalHandlers,
  syncGlobalShortcuts,
  getGlobalStatus,
  isGlobalSupported,
  setStatusChangeListener,
  type GlobalStatus
} from "./tauriHotkeys";
import { installTooltips, hideTooltip } from "./tooltips";
import { polishListboxes } from "./listbox";
import {
  type Locale,
  type TimeFormat,
  getLocale,
  setLocale,
  getTimeFormat,
  setTimeFormat,
  hour12Setting,
  intlLocale,
  t
} from "./i18n";
import {
  applyOutputDevice,
  buildAudioConstraints,
  buildVideoConstraints,
  enumerateVoiceDevices,
  getOutputVolume,
  getVoiceSettings,
  subscribeVoiceSettings,
  updateVoiceSettings,
  type CameraEffect,
  type CameraResolution,
  type DenoiserMode,
  type EnumeratedDevices,
  type VoiceSettings
} from "../call/voiceSettings";
import {
  getNotificationSettings,
  updateNotificationSettings,
  playNotificationSound,
  SOUND_LABELS,
  type NotificationSoundKind
} from "./notificationSettings";
import { confirmDialog, promptDialog } from "./dialogs";

// Backend параллельно принимает до 10 (см. parseAttachmentIDs в message/module.go).
const MAX_ATTACHMENTS = 10;

// Статус-бар внизу UI: любое непустое значение state.status
// автоматически тает через STATUS_AUTO_CLEAR_MS. armStatusAutoClear
// вызывается в начале render() — это покрывает и прямые присваивания
// (`state.status = describeError(err)`), а не только setTransientStatus.
// Перевзвод происходит только при смене текста — иначе таймер бы
// перезапускался на каждый перерендер и сообщения никогда бы не тухли.
const STATUS_AUTO_CLEAR_MS = 4000;
let _statusTimer: ReturnType<typeof setTimeout> | null = null;
let _lastTimedStatus = "";
function armStatusAutoClear(): void {
  if (state.status === _lastTimedStatus) return;
  _lastTimedStatus = state.status;
  if (_statusTimer) {
    clearTimeout(_statusTimer);
    _statusTimer = null;
  }
  if (!state.status) return;
  const msg = state.status;
  _statusTimer = setTimeout(() => {
    _statusTimer = null;
    if (state.status === msg) {
      state.status = "";
      _lastTimedStatus = "";
      render();
    }
  }, STATUS_AUTO_CLEAR_MS);
}

function setTransientStatus(msg: string): void {
  state.status = msg;
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
  // I.6: расширенный профиль
  bio?: string;
  bannerColor?: string;
  bannerMediaId?: string;
  // Wave 7 (I.17–I.19): стиль профиля. theme/gradient — "#hex,#hex".
  profileTheme?: string;
  nameGradient?: string;
  badgeEmoji?: string;
  badgeLabel?: string;
  // Wave 7 (I.15–I.16): id CSS-пресетов рамки аватара и эффекта баннера.
  avatarDecoration?: string;
  profileEffect?: string;
}

// I.6: ответ GET /users/{id} (profile.handleGetUser). Лениво подтягивается
// в user-profile-popup для не-self юзеров — member-листы расширенные
// поля не отдают (экономим bandwidth).
interface UserProfileData {
  id: string;
  username: string;
  displayName?: string;
  avatarMediaId?: string;
  presenceMode?: PresenceMode;
  customStatus?: string;
  bio?: string;
  bannerColor?: string;
  bannerMediaId?: string;
  profileTheme?: string;
  nameGradient?: string;
  badgeEmoji?: string;
  badgeLabel?: string;
  avatarDecoration?: string;
  profileEffect?: string;
}

// Wave 7 (I.13): виджет профиля — пока только ссылки. id присваивает бэк,
// при сохранении (полная замена) не отправляется.
interface ProfileWidget {
  id?: string;
  kind: "link";
  label: string;
  url: string;
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
  slowModeSeconds?: number;
  isNsfw?: boolean;
  // J.5: null/undefined = «Без категории» (Discord-pattern, отдельный блок).
  categoryId?: string | null;
  // Wave 8: ISO-дата = канал в архиве (read-only, в sidebar — блок «Архив»).
  archivedAt?: string | null;
  // Wave 8: '#rrggbb' — цвет имени канала в sidebar; пусто = цвет темы.
  nameColor?: string | null;
  // Wave 9 (форум): kind='thread' — пост форума, поле указывает на
  // родительский kind='forum' канал. Треды скрыты из sidebar.
  parentChannelId?: string | null;
  // Wave 10 (треды): kind='thread' с якорем на сообщение text-канала —
  // id корневого сообщения (чип «N ответов» вешается на него).
  rootMessageId?: string | null;
}

// Wave 9: карточка поста в форум-вью (GET /channels/{id}/forum/posts).
// id — это id тред-канала, открывается обычным selectChannel().
interface ForumPost {
  id: string;
  title: string;
  createdAt: string;
  authorId?: string;
  authorUsername?: string;
  authorDisplayName?: string;
  authorAvatarId?: string;
  preview?: string;
  messageCount: number;
  lastActivityAt: string;
}

// J.5: пользовательская категория каналов. CRUD через `/api/v1/workspaces/{ws}/categories`
// и `/api/v1/categories/{id}`. Backfill миграции 26 заводит «Текстовые» / «Голосовые»
// для каждого существующего ws'а.
interface ChannelCategory {
  id: string;
  workspaceId: string;
  name: string;
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

// Wave 10: тред, растущий из сообщения (jsonb-агрегат с бэка в message
// list). threadId — id kind='thread' канала, открывается selectChannel().
interface MessageThreadInfo {
  threadId: string;
  title: string;
  messageCount: number;
  lastActivityAt?: string;
}

// H.9: kind — 'user' (дефолт; обычное сообщение) или 'system_*' (плашки).
// Старые сервера до миграции 22 поле не возвращают; считаем тогда 'user'.
type MessageKind = "user" | "system_join" | "system_call" | "system_channel_event";

// Wave 2: OG-превью ссылки (см. worker linkpreview.go).
interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  siteName?: string;
}

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
  // Wave 4: 'everyone' | 'here' — массовый пинг сработал (у автора было
  // право message.mention_everyone). Без флага токен — обычный текст.
  mentionEveryone?: "everyone" | "here";
  // Wave 2: OG-карточки, worker заполняет асинхронно (message.previews.updated).
  linkPreviews?: LinkPreview[];
  isPinned?: boolean;
  pinnedAt?: string;
  // Wave 10: тред из этого сообщения; undefined/null = треда нет.
  thread?: MessageThreadInfo | null;
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
  // J.3(a): channel-scoped инвайт. Если задан и канал приватный,
  // accept добавит юзера в channel_members.
  channelId?: string;
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
  // I.6(c): extended-поля для user-profile-popup. Возвращаются в /members
  // чтобы popup открывался мгновенно без отдельного GET /users/{id}.
  bio?: string;
  bannerColor?: string;
  bannerMediaId?: string;
  // Wave 7: стиль профиля — градиент имени и бейдж рендерятся прямо в
  // чате/сайдбаре, тема — в popup'е.
  profileTheme?: string;
  nameGradient?: string;
  badgeEmoji?: string;
  badgeLabel?: string;
  avatarDecoration?: string;
  profileEffect?: string;
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

// Wave 3: друзья. status относительный к текущему юзеру:
// pending_in — ждёт моего ответа, pending_out — я отправил,
// blocked — я заблокировал (чужой блок против меня сервер не отдаёт).
type FriendStatus = "accepted" | "pending_in" | "pending_out" | "blocked";

interface FriendItem {
  userId: string;
  username: string;
  displayName?: string;
  avatarMediaId?: string;
  presenceMode?: PresenceMode;
  customStatus?: string;
  online: boolean;
  status: FriendStatus;
  since: string;
}

type FriendsTab = "all" | "online" | "pending" | "blocked";

type ModalKind = "settings" | "members" | "audit" | "search" | "notifications" | "admin" | "channelSettings" | "workspaceRoles" | "welcomeChannel" | "createChannel" | "workspaceSettings" | "userProfile" | "invites" | "categoryPermissions" | "createForumPost" | null;

// I.1: полноэкранная settings-модалка по Discord-pattern. Левый sidebar
// с табами + контент справа. Tab «profile» = тело старой profile-card
// (G.10). Остальные табы — placeholder'ы под I.2-I.8/I.11.
type SettingsTab =
  | "profile"
  | "privacy"
  | "voice"
  | "notifications"
  | "hotkeys"
  | "language"
  | "appearance"
  | "server";

interface SettingsState {
  tab: SettingsTab;
  // Hook под I.11 (поиск настроек) — пока non-functional.
  search: string;
}

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
  kind: "text" | "voice" | "forum";
  name: string;
  isPrivate: boolean;
  selectedRoles: Set<string>;
  roles: WorkspaceRole[];
  rolesLoading: boolean;
  saving: boolean;
  error: string | null;
  // J.5: куда сразу положить новый канал. null = «Без категории».
  categoryId: string | null;
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

// Wave 5: точечные override'ы конкретных участников канала.
interface UserOverride {
  userId: string;
  granted: string[];
  denied: string[];
}

interface ChannelUserPermissionsView {
  channelId: string;
  actions: string[];
  overrides: UserOverride[];
}

type PermDraft = Record<string, Record<string, "inherit" | "grant" | "deny">>;

type ChannelSettingsTab = "overview" | "permissions" | "invites" | "delete";

interface ChannelSettingsState {
  channelId: string | null;
  // J.3: текущий таб в модалке.
  tab: ChannelSettingsTab;
  loading: boolean;
  saving: boolean;
  error: string | null;
  data: ChannelPermissionsView | null;
  // Локальная карта (roleCode → action → "inherit" | "grant" | "deny").
  // Меняем её, при сохранении сворачиваем в overrides[].
  draft: PermDraft;
  // Wave 5: то же для участников (userId → action → mode).
  userData: ChannelUserPermissionsView | null;
  userDraft: PermDraft;
  // J.3: draft для таба «Обзор» — отдельный от permission'ов draft.
  // J.5: categoryId draft — пустая строка "" = «Без категории» (NULL).
  // Wave 8: nameColor — '#rrggbb' либо "" = цвет темы.
  overviewDraft: { name: string; topic: string; slowMode: number; isNsfw: boolean; categoryId: string; nameColor: string };
}

// Wave 5 (J.5b): права категории — отдельная модалка (ПКМ по заголовку
// категории → «Права категории…»). Зеркалит permissions-таб канала.
interface CategoryPermsState {
  categoryId: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  data: { categoryId: string; actions: string[]; roles: string[]; overrides: RoleOverride[] } | null;
  draft: PermDraft;
}

const ACTION_LABELS_RU: Record<string, string> = {
  "message.write": "Писать сообщения",
  "message.react": "Ставить реакции",
  "message.attach": "Прикреплять файлы",
  "message.mention": "Упоминать @username",
  "message.mention_everyone": "Упоминать @everyone и @here",
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
  iceCheckRunning: boolean;
  iceCheckResult: IceCheckResult | null;
}

// C.8: in-app уведомления.
interface NotificationPayload {
  actorId?: string;
  workspaceId?: string;
  channelId?: string;
  messageId?: string;
  callId?: string;
  snippet?: string;
  // mention_everyone: 'everyone' | 'here'.
  mentionKind?: string;
}

interface NotificationItem {
  id: string;
  kind: "mention" | "mention_everyone" | "reply" | "call_incoming" | "friend_request" | "friend_accept";
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
  // J.5: пользовательские категории текущего ws'а. Загружаются параллельно
  // с channels при `selectWorkspace`. Свёрнутость per-категории — в
  // collapsedCategories (J.6).
  categories: ChannelCategory[];
  collapsedCategories: Set<string>;
  selectedChannelId: string | null;
  messages: Message[];
  authError: string | null;
  // Ошибка старта сессии без отказа сервера (нет связи, таймаут, 5xx): сессию
  // не сбрасываем, показываем экран «Сервер недоступен» с кнопкой «Повторить».
  bootError: string | null;
  status: string;
  editingMessageId: string | null;
  invitesOpen: boolean;
  invites: Invite[];
  invitesLoading: boolean;
  modal: ModalKind;
  members: Member[];
  membersLoading: boolean;
  pickerForMessageId: string | null;
  // Pinned-messages popup в channel-header. channelPins ленится — грузится
  // при первом открытии и при events `message.pinned`/`unpinned`. open=true
  // показывает popup поверх message-list.
  pinsPopupOpen: boolean;
  channelPins: Message[];
  channelPinsLoading: boolean;
  channelPinsChannelId: string | null;
  auditEntries: AuditEntry[];
  auditLoading: boolean;
  pendingUploads: PendingUpload[];
  uploadInFlight: boolean;
  callSnapshot: CallSnapshot | null;
  voiceSnapshot: VoiceSnapshot | null;
  voicePeek: VoicePeek | null;
  voicePeekAll: Record<string, VoicePeekParticipant[]>;
  replyingTo: ReplySnippet | null;
  mentionAutocomplete: MentionAutocomplete | null;
  // Wave 8: автокомплит `#канал` в композере — зеркалит mentionAutocomplete.
  channelAutocomplete: MentionAutocomplete | null;
  // C.4: smart scroll + lazy pagination
  messagesCursor: string | null;       // следующий before= для подгрузки старых
  messagesHasMore: boolean;
  messagesLoadingOlder: boolean;
  stickToBottom: boolean;              // юзер у нижней границы → autoscroll на новые
  restoreScrollBottom: number | null;  // one-shot: после render() восстановить «расстояние до низа»
  // C.5: unread indicators
  unread: Record<string, number>;                 // channelId → count
  selectedChannelLastReadAt: string | null;       // фриз lastReadAt на момент входа — для divider'а
  // Wave 9: форум. Посты выбранного форум-канала (грузятся в selectChannel)
  // + state модалки «Новый пост» (title/body/saving/error).
  forumPosts: ForumPost[];
  forumPostsLoading: boolean;
  createForumPost: { channelId: string | null; title: string; body: string; saving: boolean; error: string | null };
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
  // H.7 → Wave 5: полный список ролей текущего воркспейса (позиции,
  // цвета, hoisted, составы). Загружается параллельно с members при
  // selectWorkspace и после save в roles-модалке. Источник для
  // union-резолвера цвета (getUserColor) и hoisted-секций member-sidebar.
  // Пустой массив = не загружено → fallback к хардкод-палитре.
  wsRoles: WorkspaceRole[];
  // Контекстное меню канала: ПКМ на элементе списка → плавающее меню
  // (Переименовать / Удалить / Скопировать ID). null = меню закрыто.
  channelMenu: { channelId: string; x: number; y: number } | null;
  workspaceMenu: { workspaceId: string; x: number; y: number } | null;
  // Wave 5: ПКМ по участнику в member-sidebar — профиль + назначение ролей.
  memberMenu: { userId: string; x: number; y: number } | null;
  // Wave 5 (J.5b): ПКМ по заголовку категории + модалка её прав.
  categoryMenu: { categoryId: string; x: number; y: number } | null;
  categoryPerms: CategoryPermsState;
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
  // J.5: dropdown под заголовком воркспейса (Discord-pattern) — содержит
  // Пригласить / Настройки сервера / Создать канал / Создать категорию.
  workspaceMenuOpen: boolean;
  // I.12: from/to — ISO даты YYYY-MM-DD; пустые = без ограничения.
  auditFilter: { action: string; actor: string; from: string; to: string; targetType: string };
  // Правая панель участников (Discord-style). На широких экранах открыта
  // по умолчанию, кнопка в channel-header сворачивает.
  memberSidebarOpen: boolean;
  userProfileTarget: string | null;
  // I.6: лениво загруженные расширенные поля профиля для user-profile-popup.
  userProfileData: UserProfileData | null;
  // Wave 7 (I.13): виджеты открытого в попапе профиля (лениво, GET /widgets).
  userProfileWidgets: ProfileWidget[] | null;
  // Wave 4: персистентные уровни уведомлений (G.9.e). Явные значения с
  // бэка; эффективный уровень канала = канал ← воркспейс ← 'all'.
  // 'none' = бывший клиентский mute, теперь переживает refresh и девайсы.
  notifPrefs: { channels: Record<string, string>; workspaces: Record<string, string> };
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
  // Wave 3: друзья + блокировки.
  friends: FriendItem[];
  friendsLoading: boolean;
  friendsTab: FriendsTab;
  friendAddError: string | null;
  friendAddOk: string | null;
  blockedIds: Set<string>;
  // Раскрытые «Сообщение заблокированного пользователя» (per-message, transient).
  revealedBlocked: Set<string>;
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
  // I.1: settings-shell (полноэкранная модалка с табами). Содержимое
  // таба «profile» = бывший G.10 (использует profileEdit).
  settings: SettingsState;
}

interface ProfileEditState {
  field: "displayName" | "password" | "bio" | "bannerColor" | null;
  draftDisplayName: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  // I.6: drafts расширенных полей профиля
  draftBio: string;
  draftBannerColor: string;
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

// J.6: persisting collapsed-categories state в localStorage. Per-категории
// идентификатор — workspace-scoped UUID; кросс-workspace утечки не страшны.
const COLLAPSED_CATEGORIES_KEY = "rucord:collapsed-categories";
function loadCollapsedCategories(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_CATEGORIES_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
function saveCollapsedCategories(): void {
  try {
    localStorage.setItem(COLLAPSED_CATEGORIES_KEY, JSON.stringify(Array.from(state.collapsedCategories)));
  } catch {
    /* quota / disabled */
  }
}

const state: AppState = {
  me: null,
  workspaces: [],
  selectedWorkspaceId: null,
  channels: [],
  categories: [],
  collapsedCategories: loadCollapsedCategories(),
  selectedChannelId: null,
  messages: [],
  authError: null,
  bootError: null,
  status: "",
  editingMessageId: null,
  invitesOpen: false,
  invites: [],
  invitesLoading: false,
  modal: null,
  members: [],
  membersLoading: false,
  pickerForMessageId: null,
  pinsPopupOpen: false,
  channelPins: [],
  channelPinsLoading: false,
  channelPinsChannelId: null,
  auditEntries: [],
  auditLoading: false,
  pendingUploads: [],
  uploadInFlight: false,
  callSnapshot: null,
  voiceSnapshot: null,
  voicePeek: null,
  voicePeekAll: {},
  replyingTo: null,
  mentionAutocomplete: null,
  channelAutocomplete: null,
  messagesCursor: null,
  messagesHasMore: false,
  messagesLoadingOlder: false,
  stickToBottom: true,
  restoreScrollBottom: null,
  unread: {},
  selectedChannelLastReadAt: null,
  forumPosts: [],
  forumPostsLoading: false,
  createForumPost: { channelId: null, title: "", body: "", saving: false, error: null },
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
    retentionLast: null,
    iceCheckRunning: false,
    iceCheckResult: null
  },
  channelSettings: {
    channelId: null,
    tab: "overview",
    loading: false,
    saving: false,
    error: null,
    data: null,
    draft: {},
    userData: null,
    userDraft: {},
    overviewDraft: { name: "", topic: "", slowMode: 0, isNsfw: false, categoryId: "", nameColor: "" }
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
  wsRoles: [],
  channelMenu: null,
  workspaceMenu: null,
  memberMenu: null,
  categoryMenu: null,
  categoryPerms: { categoryId: null, loading: false, saving: false, error: null, data: null, draft: {} },
  voiceVolumes: {},
  voiceVolumeMenu: null,
  statusMenu: null,
  workspaceMenuOpen: false,
  auditFilter: { action: "", actor: "", from: "", to: "", targetType: "" },
  memberSidebarOpen: true,
  userProfileTarget: null,
  userProfileData: null,
  userProfileWidgets: null,
  notifPrefs: { channels: {}, workspaces: {} },
  screenShareQuality: loadScreenShareQuality(),
  dmMode: false,
  dms: [],
  dmsLoading: false,
  dmFindQuery: "",
  dmFindError: null,
  dmOpening: false,
  dmUnreadTotal: 0,
  friends: [],
  friendsLoading: false,
  friendsTab: "all",
  friendAddError: null,
  friendAddOk: null,
  blockedIds: new Set<string>(),
  revealedBlocked: new Set<string>(),
  createChannel: {
    workspaceId: null,
    kind: "text",
    name: "",
    isPrivate: false,
    selectedRoles: new Set(),
    roles: [],
    rolesLoading: false,
    saving: false,
    error: null,
    categoryId: null
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
    draftBio: "",
    draftBannerColor: "",
    saving: false,
    error: null,
    okMessage: null
  },
  settings: {
    tab: "profile",
    search: ""
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
  // I.14: APNG тоже анимированный — first frame снимается тем же canvas'ом
  // (drawImage на onload рисует первый кадр).
  if (blob.type !== "image/gif" && blob.type !== "image/apng") return Promise.resolve(null);
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
// Wave 0: текущее состояние WS-соединения (для баннера «Переподключение…»).
let connState: ConnectionState = "offline";
let syncGeneration = 0;
// F.8: auto-update. handle живёт вне state — это не сессионные данные.
let updateHandle: UpdateHandle | null = null;
let updatePhase: "idle" | "available" | "downloading" | "ready" = "idle";
let updatePct: number | null = null;
let updateCheckStarted = false;

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

  // I.5: применяем тему/density/accent ДО первого рендера, иначе мерцает
  // дефолтная dark-тема пока юзер настроил light. watchSystemTheme нужен
  // для режима "auto" — переключаться при смене OS-темы.
  applyAppearance();
  watchSystemTheme();

  installGlobalKeyboardShortcuts();
  installTooltips();
  installNativeGuards();
  realtime.subscribe(handleRealtimeEvent);
  // Индикатор соединения. Realtime v2 сам присылает replay либо
  // sync.required; полный REST-resync запускается только во втором случае.
  realtime.onConnectionStateChange((s) => {
    connState = s;
    render();
  });
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
        bootError: null,
        workspaces: [],
        selectedWorkspaceId: null,
        channels: [],
        categories: [],
        selectedChannelId: null,
        messages: [],
        editingMessageId: null,
        invitesOpen: false,
        invites: [],
        modal: null,
        members: [],
        pickerForMessageId: null,
        pinsPopupOpen: false,
        channelPins: [],
        channelPinsLoading: false,
        channelPinsChannelId: null,
        notifications: [],
        notificationsUnread: 0,
        dmMode: false,
        dms: [],
        dmUnreadTotal: 0,
        dmFindQuery: "",
        dmFindError: null,
        friends: [],
        blockedIds: new Set<string>(),
        revealedBlocked: new Set<string>()
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
    void loadFriends();
    void loadNotifPrefs();
    if (getNotificationSettings().desktopEnabled) void requestBrowserNotificationPermission();
    startIdleAutoDetect();
    void initUpdateCheck();
    state.status = "";
    state.bootError = null;
    render();
  } catch (err) {
    state.status = "";
    if (isSessionRejected(err)) {
      // Сервер отклонил сессию (401/403): токены просрочены, отозваны или аккаунт заблокирован.
      await httpClient.logout();
      state.authError = describeError(err);
    } else {
      // Нет связи, таймаут или сбой сервера: сессия жива, выходить нельзя.
      const status = (err as ApiError | null)?.status ?? 0;
      state.bootError = status >= 500 ? `Сервер вернул ошибку ${status}. Возможно, он перезапускается.` : describeError(err);
    }
    render();
  }
}

async function loadWorkspaces(generation?: number): Promise<void> {
  const data = await httpClient.get<{ items: Workspace[] }>("/api/v1/workspaces");
  if (generation !== undefined && generation !== syncGeneration) return;
  state.workspaces = data.items ?? [];
  if (state.selectedWorkspaceId && !state.workspaces.some((w) => w.id === state.selectedWorkspaceId)) {
    state.selectedWorkspaceId = null;
  }
  if (!state.selectedWorkspaceId && state.workspaces.length > 0) {
    await selectWorkspace(state.workspaces[0].id, generation !== undefined);
  }
}

async function selectWorkspace(id: string, preserveSyncGeneration = false): Promise<void> {
  if (!preserveSyncGeneration) syncGeneration += 1;
  state.selectedWorkspaceId = id;
  state.selectedChannelId = null;
  state.channels = [];
  state.categories = [];
  state.messages = [];
  state.invitesOpen = false;
  state.invites = [];
  state.members = [];
  state.unread = {};
  state.wsRoles = [];
  userColorCache = null;
  state.voicePeekAll = {};
  render();
  // J.5: каналы и категории тянем параллельно — оба нужны для рендера sidebar.
  const [channelsResp, categoriesResp] = await Promise.all([
    httpClient.get<{ items: Channel[] }>(`/api/v1/workspaces/${id}/channels`),
    httpClient.get<{ items: ChannelCategory[] }>(`/api/v1/workspaces/${id}/categories`).catch(() => ({ items: [] }))
  ]);
  state.channels = channelsResp.items ?? [];
  state.categories = categoriesResp.items ?? [];
  // Резолвинг authorId → имя в сообщениях. Не блокируем загрузку каналов.
  void loadMembers();
  void loadUnread(id);
  void loadWsRoles(id);
  void loadAllVoicePeeks(id);
  if (state.channels.length > 0) {
    await selectChannel(state.channels[0].id);
  } else {
    render();
  }
}

// Прелоад участников всех voice-каналов воркспейса — чтобы под voice-каналом
// в sidebar сразу был виден список «кто в канале», без необходимости туда
// заходить. Дальше поддерживается realtime'ом через voice.joined/voice.left.
async function loadAllVoicePeeks(workspaceId: string, generation?: number): Promise<void> {
  const voiceChannels = state.channels.filter((c) => c.kind === "voice" && c.workspaceId === workspaceId);
  if (voiceChannels.length === 0) return;
  const results = await Promise.allSettled(
    voiceChannels.map((c) =>
      httpClient
        .get<{ items: VoicePeekParticipant[] }>(`/api/v1/channels/${c.id}/voice/participants`)
        .then((d) => ({ channelId: c.id, items: d.items ?? [] }))
    )
  );
  if (state.selectedWorkspaceId !== workspaceId || (generation !== undefined && generation !== syncGeneration)) return;
  const next: Record<string, VoicePeekParticipant[]> = {};
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.items.length > 0) {
      next[r.value.channelId] = r.value.items;
    }
  }
  state.voicePeekAll = next;
  render();
}

async function selectChannel(id: string): Promise<void> {
  state.selectedChannelId = id;
  state.messages = [];
  state.editingMessageId = null;
  state.pickerForMessageId = null;
  state.pinsPopupOpen = false;
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
  // Wave 9: форум — вместо сообщений грузим список постов.
  if (ch?.kind === "forum") {
    await loadForumPosts(id);
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

// Wave 9: загрузка постов форума. Вызывается из selectChannel и из
// realtime-обработчиков (новый тред / новое сообщение в треде), когда
// открыт родительский форум.
// keepCurrent=true — refresh по realtime-событию: старые карточки остаются
// видимыми, пока грузится свежий список (без мигания). false (вход в
// канал) — чистим, чтобы не мелькали посты предыдущего форума.
async function loadForumPosts(channelId: string, keepCurrent = false): Promise<void> {
  state.forumPostsLoading = true;
  if (!keepCurrent) {
    state.forumPosts = [];
  }
  render();
  try {
    const data = await httpClient.get<{ items: ForumPost[] }>(`/api/v1/channels/${channelId}/forum/posts`);
    if (state.selectedChannelId !== channelId) return;
    state.forumPosts = data.items ?? [];
  } catch (err) {
    if (state.selectedChannelId !== channelId) return;
    state.forumPosts = [];
    state.status = describeError(err);
  } finally {
    if (state.selectedChannelId === channelId) {
      state.forumPostsLoading = false;
      render();
    }
  }
}

async function loadUnread(workspaceId: string, generation?: number): Promise<void> {
  try {
    const data = await httpClient.get<{ items: { channelId: string; unreadCount: number }[] }>(
      `/api/v1/workspaces/${workspaceId}/unread`
    );
    if (state.selectedWorkspaceId !== workspaceId || (generation !== undefined && generation !== syncGeneration)) return;
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

// F.8: проверка обновлений на старте сессии + раз в 6 часов. На web/mobile
// checkForUpdate() отдаёт null — баннер не появляется. Сначала показываем
// «Что нового», если прошлый запуск завершился установкой обновления.
async function initUpdateCheck(): Promise<void> {
  if (updateCheckStarted) return; // re-login не должен плодить интервалы
  updateCheckStarted = true;
  try {
    const raw = localStorage.getItem("rucord:pending-changelog");
    if (raw) {
      localStorage.removeItem("rucord:pending-changelog");
      const data = JSON.parse(raw) as { version: string; notes?: string };
      void confirmDialog({
        title: `RuCord обновлён до v${data.version}`,
        body: data.notes?.trim() || "Обновление установлено.",
        confirmLabel: "Ок"
      });
    }
  } catch {
    /* битый JSON в localStorage — просто пропускаем */
  }
  const recheck = async () => {
    if (updatePhase !== "idle") return; // уже нашли/качаем
    const upd = await checkForUpdate();
    if (!upd || updatePhase !== "idle") return;
    updateHandle = upd;
    updatePhase = "available";
    render();
  };
  void recheck();
  window.setInterval(() => void recheck(), 6 * 3600 * 1000);
}

async function startUpdateInstall(): Promise<void> {
  if (!updateHandle || updatePhase === "downloading" || updatePhase === "ready") return;
  updatePhase = "downloading";
  updatePct = null;
  render();
  try {
    await updateHandle.install((pct) => {
      // Прогресс — прямой DOM-mutate: render() на каждый chunk дёргал бы
      // фокус и пересоздавал message-list.
      updatePct = pct;
      const el = rootEl.querySelector<HTMLElement>("#update-banner-text");
      if (el) el.textContent = pct === null ? "Скачиваю обновление…" : `Скачиваю обновление… ${pct}%`;
    });
    // «Что нового» покажем после перезапуска уже новой версией.
    localStorage.setItem(
      "rucord:pending-changelog",
      JSON.stringify({ version: updateHandle.version, notes: updateHandle.notes ?? "" })
    );
    updatePhase = "ready";
    render();
    await relaunchApp();
  } catch (err) {
    updatePhase = "available";
    state.status = describeError(err);
    render();
  }
}

function renderUpdateBanner(): string {
  if (updatePhase === "available" && updateHandle) {
    return `
      <div class="update-banner" role="status">
        <span id="update-banner-text">Доступно обновление v${escapeHtml(updateHandle.version)}</span>
        <button id="update-install">Установить</button>
      </div>
    `;
  }
  if (updatePhase === "downloading") {
    return `
      <div class="update-banner" role="status">
        <span class="conn-banner-spinner update-banner-spinner"></span>
        <span id="update-banner-text">Скачиваю обновление…${updatePct !== null ? ` ${updatePct}%` : ""}</span>
      </div>
    `;
  }
  if (updatePhase === "ready") {
    return `<div class="update-banner" role="status"><span>Обновление установлено — перезапуск…</span></div>`;
  }
  return "";
}

// Авторитетный resync. Generation token не даёт медленному ответу от старого
// reconnect перезаписать состояние, уже полученное более новым циклом.
async function resyncAfterReconnect(cursorToAcknowledge?: number): Promise<void> {
  const generation = ++syncGeneration;
  const previousWorkspace = state.selectedWorkspaceId;
  try {
    await loadWorkspaces(generation);
    if (generation !== syncGeneration) return;

    const workspaceId = state.selectedWorkspaceId ?? previousWorkspace;
    if (workspaceId && state.workspaces.some((w) => w.id === workspaceId)) {
      const [channelsResp, categoriesResp] = await Promise.all([
        httpClient.get<{ items: Channel[] }>(`/api/v1/workspaces/${workspaceId}/channels`),
        httpClient.get<{ items: ChannelCategory[] }>(`/api/v1/workspaces/${workspaceId}/categories`).catch(() => ({ items: [] }))
      ]);
      if (generation !== syncGeneration || state.selectedWorkspaceId !== workspaceId) return;
      state.channels = channelsResp.items ?? [];
      state.categories = categoriesResp.items ?? [];
      if (state.selectedChannelId && !state.channels.some((c) => c.id === state.selectedChannelId) &&
          !state.dms.some((d) => d.channelId === state.selectedChannelId)) {
        state.selectedChannelId = null;
        state.messages = [];
      }
      await Promise.all([
        loadMembers(generation),
        loadUnread(workspaceId, generation),
        loadWsRoles(workspaceId, generation),
        loadAllVoicePeeks(workspaceId, generation)
      ]);
    }
    await Promise.all([
      loadNotifications(generation),
      loadDMs(generation),
      loadFriends(generation),
      backfillSelectedChannel(generation)
    ]);
    if (generation !== syncGeneration) return;
    if (cursorToAcknowledge !== undefined) realtimeClient.completeSnapshot(cursorToAcknowledge);
    render();
  } catch (err) {
    if (generation === syncGeneration) state.status = describeError(err);
  }
}

// Догружает сообщения активного канала, пришедшие пока сокет лежал.
// Если разрыв был коротким — дописываем хвост (по id-дедупу), скролл не
// дёргается. Если за время разрыва пришло >50 сообщений (нет пересечения
// с локальным списком) — заменяем окно целиком, как при входе в канал.
async function backfillSelectedChannel(generation?: number): Promise<void> {
  const id = state.selectedChannelId;
  if (!id) return;
  const ch = state.channels.find((c) => c.id === id);
  if (ch?.kind === "voice") return;
  try {
    const data = await httpClient.get<{ items: Message[]; nextCursor?: string }>(
      `/api/v1/channels/${id}/messages?limit=50`
    );
    if (state.selectedChannelId !== id || (generation !== undefined && generation !== syncGeneration)) return;
    const fresh = (data.items ?? []).slice().reverse();
    if (fresh.length === 0) return;
    const known = new Set(state.messages.map((m) => m.id));
    const overlap = fresh.some((m) => known.has(m.id));
    if (!overlap && state.messages.length > 0) {
      state.messages = fresh;
      state.messagesCursor = data.nextCursor || null;
      state.messagesHasMore = !!data.nextCursor;
      state.stickToBottom = true;
    } else {
      const lastTs = state.messages.length > 0 ? state.messages[state.messages.length - 1].createdAt : "";
      const appended = fresh.filter((m) => !known.has(m.id) && m.createdAt > lastTs);
      if (appended.length === 0) return;
      state.messages = [...state.messages, ...appended];
    }
    render();
  } catch {
    /* тихо — следующий reconnect повторит */
  }
}

// G.8: загрузка DM-листа. Зовётся на bootstrap и при входе в DM-режим
// (чтобы освежить lastMessageAt/unread, если что-то пришло пока юзер был в ws).
async function loadDMs(generation?: number): Promise<void> {
  state.dmsLoading = true;
  try {
    const data = await httpClient.get<{ items: DMItem[] }>("/api/v1/dm");
    if (generation !== undefined && generation !== syncGeneration) return;
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
  void loadFriends();
}

function exitDMMode(workspaceId: string): void {
  state.dmMode = false;
  state.dmFindError = null;
  void selectWorkspace(workspaceId);
}

// ---- Wave 4: уровни уведомлений ---------------------------------------------

type NotifLevel = "all" | "mentions" | "none";

function isNotifLevel(v: string | undefined): v is NotifLevel {
  return v === "all" || v === "mentions" || v === "none";
}

// Эффективный уровень: явный канальный ← workspace ← 'all'. DM-каналы
// workspace'а не имеют — для них работает только канальный уровень.
function channelNotifLevel(channelId: string): NotifLevel {
  const explicit = state.notifPrefs.channels[channelId];
  if (isNotifLevel(explicit)) return explicit;
  const ch = state.channels.find((c) => c.id === channelId);
  const wsLevel = ch ? state.notifPrefs.workspaces[ch.workspaceId] : undefined;
  if (isNotifLevel(wsLevel)) return wsLevel;
  return "all";
}

function isChannelMuted(channelId: string): boolean {
  return channelNotifLevel(channelId) === "none";
}

async function loadNotifPrefs(): Promise<void> {
  try {
    const data = await httpClient.get<{ channels: Record<string, string>; workspaces: Record<string, string> }>(
      "/api/v1/users/me/notification-prefs"
    );
    state.notifPrefs = { channels: data.channels ?? {}, workspaces: data.workspaces ?? {} };
    render();
  } catch {
    /* prefs не критичны — остаёмся на 'all' */
  }
}

async function setChannelNotifLevel(channelId: string, level: NotifLevel | ""): Promise<void> {
  try {
    await httpClient.put(`/api/v1/channels/${channelId}/notification-pref`, { level });
    if (level === "") delete state.notifPrefs.channels[channelId];
    else state.notifPrefs.channels[channelId] = level;
    render();
  } catch (err) {
    state.status = describeError(err);
    render();
  }
}

async function setWorkspaceNotifLevel(workspaceId: string, level: NotifLevel | ""): Promise<void> {
  try {
    await httpClient.put(`/api/v1/workspaces/${workspaceId}/notification-pref`, { level });
    if (level === "") delete state.notifPrefs.workspaces[workspaceId];
    else state.notifPrefs.workspaces[workspaceId] = level;
    render();
  } catch (err) {
    state.status = describeError(err);
    render();
  }
}

// ---- Wave 3: друзья ---------------------------------------------------------

async function loadFriends(generation?: number): Promise<void> {
  state.friendsLoading = true;
  try {
    const data = await httpClient.get<{ items: FriendItem[] }>("/api/v1/friends");
    if (generation !== undefined && generation !== syncGeneration) return;
    state.friends = data.items ?? [];
    state.blockedIds = new Set(state.friends.filter((f) => f.status === "blocked").map((f) => f.userId));
  } catch (err) {
    state.status = describeError(err);
  } finally {
    state.friendsLoading = false;
    render();
  }
}

async function sendFriendRequest(username: string): Promise<void> {
  state.friendAddError = null;
  state.friendAddOk = null;
  try {
    const res = await httpClient.post<{ status: string }>("/api/v1/friends/requests", { username });
    state.friendAddOk = res.status === "accepted"
      ? `Вы теперь друзья с @${username}`
      : `Заявка отправлена @${username}`;
    await loadFriends();
  } catch (err) {
    state.friendAddError = describeError(err);
    render();
  }
}

async function friendAction(userId: string, action: "accept" | "remove" | "block" | "unblock"): Promise<void> {
  try {
    if (action === "accept") {
      await httpClient.post(`/api/v1/friends/${userId}/accept`, {});
    } else if (action === "remove") {
      await httpClient.del(`/api/v1/friends/${userId}`);
    } else if (action === "block") {
      await httpClient.put(`/api/v1/friends/${userId}/block`, {});
    } else {
      await httpClient.del(`/api/v1/friends/${userId}/block`);
    }
    await loadFriends();
  } catch (err) {
    state.status = describeError(err);
    render();
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

async function loadNotifications(generation?: number): Promise<void> {
  state.notificationsLoading = true;
  try {
    const [list, count] = await Promise.all([
      httpClient.get<{ items: NotificationItem[] }>("/api/v1/notifications?limit=30"),
      httpClient.get<{ unread: number }>("/api/v1/notifications/count")
    ]);
    if (generation !== undefined && generation !== syncGeneration) return;
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
  // Если сообщение пришло в активный канал — юзер уже его видит,
  // не надо вешать badge и держать notification «unread». Звонкам
  // (call_incoming) приходит без channelId — их не глушим.
  const inActiveChannel =
    !!item.payload.channelId &&
    item.payload.channelId === state.selectedChannelId &&
    item.kind !== "call_incoming";
  if (inActiveChannel) {
    item.readAt = new Date().toISOString();
    void httpClient.post(`/api/v1/notifications/${item.id}/read`).catch(() => {
      /* idempotent */
    });
  }
  state.notifications = [item, ...state.notifications].slice(0, 50);
  if (!item.readAt) {
    state.notificationsUnread += 1;
  }
  render();
  if (!inActiveChannel) {
    maybeShowBrowserNotification(item);
  }
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
  if (chId && isChannelMuted(chId)) return;
  // I.8: глобальные настройки. desktopEnabled = false — не дёргаем popup,
  // но звук всё равно проигрываем (если включён). muteEveryone — глушим
  // и popup и звук для массовых пингов.
  const settings = getNotificationSettings();
  // Wave 4: серверный kind вместо эвристики по snippet'у.
  if (settings.muteEveryone && item.kind === "mention_everyone") return;
  playNotificationSound();
  if (!settings.desktopEnabled) return;
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
    case "mention_everyone":
      return `${actor} упомянул @${item.payload.mentionKind === "here" ? "here" : "everyone"}`;
    case "reply":
      return `${actor} ответил на ваше сообщение`;
    case "call_incoming":
      return `Входящий звонок от ${actor}`;
    case "friend_request":
      return `${actor} хочет добавить вас в друзья`;
    case "friend_accept":
      return `${actor} принял вашу заявку в друзья`;
  }
}

function notificationBody(item: NotificationItem): string {
  if (item.kind === "call_incoming") return "Нажмите, чтобы открыть RuCord";
  if (item.kind === "friend_request") return "Откройте вкладку «Друзья», чтобы ответить";
  if (item.kind === "friend_accept") return "";
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

// I.4: глобальные хоткеи теперь идут через единый dispatcher из
// `hotkeys.ts`. Регистрируем все action-handler'ы один раз на bootstrap.
// Esc обрабатывается отдельно — это не настраиваемая комбинация.
let globalShortcutsInstalled = false;
let _deafened = false;
// I.9: PTT-режим — true пока пользователь зажимает биндинг. Используется
// для visual indicator в voice-strip. Release-delay реализован через
// _pttReleaseTimer: при keyup взводим setTimeout(mute), который чистится
// если PTT нажали повторно до истечения delay'а.
let _pttHeld = false;
let _pttReleaseTimer: ReturnType<typeof setTimeout> | null = null;

// I.9(b): ручной toggleMute должен отменить отложенный PTT-mute. Иначе
// сценарий «отпустил клавишу → manual unmute → через N мс PTT delay
// сработает и снова замьютит» оставляет UI и реальное состояние
// рассинхронизированными. Вызывается из всех точек toggleMute (hotkey,
// strip-кнопка, call-bar-кнопка, Tauri-global).
function manualToggleMute(): void {
  if (_pttReleaseTimer) {
    clearTimeout(_pttReleaseTimer);
    _pttReleaseTimer = null;
    _pttHeld = false;
    updatePttIndicator();
  }
  if (voiceMgr.isActive()) voiceMgr.toggleMute();
  if (callMgr.isActive()) callMgr.toggleMute();
}

// K.4: deafen-toggle вынесен из hotkeys-handler в named-функцию,
// чтобы тот же handler можно было дёрнуть из кнопки в voice-strip /
// call-bar. Глушит все remote-стримы (`<video>` с поток-attribute'ами)
// и сам микрофон, чтобы «глухой» юзер физически не говорил.
function toggleDeafen(): void {
  _deafened = !_deafened;
  for (const el of rootEl.querySelectorAll<HTMLVideoElement>(
    "video[data-voice-peer], video[data-call-remote]"
  )) {
    el.muted = _deafened;
  }
  if (_deafened) {
    if (voiceMgr.isActive()) voiceMgr.setMute(true);
    if (callMgr.isActive()) callMgr.setMute(true);
  }
  setTransientStatus(_deafened ? "Заглушено" : "Звук включён");
  render();
}

function isDeafened(): boolean {
  return _deafened;
}

function updatePttIndicator(): void {
  // Прямой DOM-mutate, без render() — иначе сорвался бы фокус композера
  // при каждом keydown PTT. CSS-класс на strip управляет цветом mic-иконки.
  const isPtt = getVoiceSettings().pushToTalk;
  for (const el of rootEl.querySelectorAll<HTMLElement>(".voice-strip, .call-bar")) {
    el.classList.toggle("ptt-mode", isPtt);
    el.classList.toggle("ptt-active", isPtt && _pttHeld);
  }
}

// I.9: применить PTT-mode к активным сессиям. Вызывается из join/leave-flow'ов
// (selectChannel для voice, placeCall, acceptCall) и из voice-settings, когда
// юзер переключил флаг. PTT гейтит передачу звука через setPttGate, НЕ трогая
// видимый mute — микрофон в PTT-режиме остаётся «включённым» (Discord-стиль).
function applyPttModeToActiveSessions(): void {
  const pt = getVoiceSettings().pushToTalk;
  if (!pt) {
    // PTT выключили — гейт открываем (звук течёт по обычному mute-флагу).
    if (voiceMgr.isActive()) voiceMgr.setPttGate(true);
    if (callMgr.isActive()) callMgr.setPttGate(true);
    updatePttIndicator();
    return;
  }
  // PTT включён: пока клавиша не зажата — гейт закрыт.
  const open = _pttHeld;
  if (voiceMgr.isActive()) voiceMgr.setPttGate(open);
  if (callMgr.isActive()) callMgr.setPttGate(open);
  updatePttIndicator();
}

// PTT keydown: открываем гейт (звук пошёл). Общая функция для window- и
// global-хендлеров — раньше код дублировался дважды.
function pttDown(): void {
  if (_pttReleaseTimer) {
    clearTimeout(_pttReleaseTimer);
    _pttReleaseTimer = null;
  }
  _pttHeld = true;
  if (_deafened) return; // deafen перебивает PTT — глухой не говорит
  if (voiceMgr.isActive()) voiceMgr.setPttGate(true);
  if (callMgr.isActive()) callMgr.setPttGate(true);
  updatePttIndicator();
}

// PTT keyup: закрываем гейт (с опциональным release-delay, чтобы хвост фразы
// не обрезался). Видимый mute не трогаем.
function pttUp(): void {
  const delay = Math.max(0, getVoiceSettings().pttReleaseDelay | 0);
  const finish = (): void => {
    _pttHeld = false;
    _pttReleaseTimer = null;
    if (voiceMgr.isActive()) voiceMgr.setPttGate(false);
    if (callMgr.isActive()) callMgr.setPttGate(false);
    updatePttIndicator();
  };
  if (delay > 0) {
    _pttReleaseTimer = setTimeout(finish, delay);
  } else {
    finish();
  }
}

function installGlobalKeyboardShortcuts(): void {
  if (globalShortcutsInstalled) return;
  globalShortcutsInstalled = true;
  registerHotkeyActions();
  window.addEventListener("keydown", (ev) => {
    // I.4: capture-режим в hotkeys-табе перехватывает всё первым,
    // иначе нажатие Ctrl+K сразу бы открыло Quick Switcher.
    if (maybeCaptureKey(ev)) return;
    if (ev.key === "Escape") {
      if (state.statusMenu) {
        state.statusMenu = null;
        render();
        return;
      }
      if (state.workspaceMenuOpen) {
        state.workspaceMenuOpen = false;
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
        state.userProfileData = null;
        render();
        return;
      }
    }
    if (!state.me) return;
    dispatchHotkeyDown(ev);
  });
  window.addEventListener("keyup", (ev) => {
    dispatchHotkeyUp(ev);
  });
  // Alt+Tab / window blur — отпускаем все hold'ы (PTT), иначе микрофон
  // мог бы залипнуть «включённым» когда юзер ушёл в другое окно.
  window.addEventListener("blur", () => {
    releaseAllHold();
  });
}

function registerHotkeyActions(): void {
  registerHotkey("toggle-mute", () => manualToggleMute());
  registerHotkey("toggle-deafen", () => toggleDeafen());
  registerHotkey("toggle-camera", async () => {
    if (voiceMgr.isActive()) await voiceMgr.toggleCamera();
    else if (callMgr.isActive()) await callMgr.toggleCamera();
  });
  registerHotkey("toggle-screen-share", async () => {
    if (voiceMgr.isActive()) await voiceMgr.toggleScreenShare();
    else if (callMgr.isActive()) await callMgr.toggleScreenShare();
  });
  registerHotkey("voice-disconnect", async () => {
    if (voiceMgr.isActive()) await voiceMgr.leave();
  });
  registerHotkey("push-to-talk", {
    down: () => pttDown(),
    up: () => pttUp()
  });
  registerHotkey("quick-switcher", () => {
    if (!state.selectedWorkspaceId) return;
    state.modal = "search";
    render();
    setTimeout(() => {
      rootEl.querySelector<HTMLInputElement>("#search-input")?.focus();
    }, 0);
  });
  registerHotkey("search", () => {
    if (!state.selectedWorkspaceId) return;
    state.modal = "search";
    render();
    setTimeout(() => {
      rootEl.querySelector<HTMLInputElement>("#search-input")?.focus();
    }, 0);
  });
  registerHotkey("next-channel-unread", () => navigateUnreadChannel(1));
  registerHotkey("prev-channel-unread", () => navigateUnreadChannel(-1));
  registerHotkey("mark-server-read", () => markServerRead());
  // edit-last-message: дёргает ту же логику, что и ArrowUp в композере.
  // Если кастомный chord с модификаторами — global-dispatcher сработает
  // даже из инпута (shouldIgnore разрешает Ctrl-/Meta-/Alt-комбо).
  registerHotkey("edit-last-message", () => {
    if (tryEditLastOwnMessage()) focusComposer();
  });

  // K.2: те же handler'ы пробрасываем в `tauriHotkeys`-канал, чтобы
  // глобальный shortcut дёргал ровно ту же логику. Window-listener тоже
  // остаётся активен — это покрывает web-сборку и аварийный fallback
  // если global-shortcut не дал accelerator (например, занят другой
  // программой). isGlobalEligible(...) фильтрует — нет смысла дублировать
  // search/switcher в глобал.
  setGlobalHandlers("toggle-mute", { tap: () => manualToggleMute() });
  setGlobalHandlers("toggle-deafen", { tap: () => toggleDeafen() });
  setGlobalHandlers("toggle-camera", { tap: async () => {
    if (voiceMgr.isActive()) await voiceMgr.toggleCamera();
    else if (callMgr.isActive()) await callMgr.toggleCamera();
  }});
  setGlobalHandlers("toggle-screen-share", { tap: async () => {
    if (voiceMgr.isActive()) await voiceMgr.toggleScreenShare();
    else if (callMgr.isActive()) await callMgr.toggleScreenShare();
  }});
  setGlobalHandlers("voice-disconnect", { tap: async () => {
    if (voiceMgr.isActive()) await voiceMgr.leave();
  }});
  setGlobalHandlers("push-to-talk", {
    down: () => pttDown(),
    up: () => pttUp()
  });

  // Первичная синхронизация + подписка на rebind-события.
  void syncGlobalShortcuts(getHotkeyBinding);
  onBindingChange(() => {
    void syncGlobalShortcuts(getHotkeyBinding);
  });
  // #5c: после async-регистрации перерисовываем hotkeys-таб, чтобы индикатор
  // «глобально» показал актуальный статус (registered/failed/unsupported).
  setStatusChangeListener(() => {
    if (state.modal === "settings" && state.settings.tab === "hotkeys") render();
  });
}

// I.4(3): edit-last-message helper. Возвращает true если нашли своё последнее
// сообщение и переключили в edit-mode. Не зовёт ev.preventDefault — это
// делает caller (в композере / global-dispatcher).
function tryEditLastOwnMessage(): boolean {
  const myId = state.me?.id;
  if (!myId) return false;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.authorId !== myId) continue;
    if (m.kind && m.kind !== "user") continue;
    if (m.deletedAt) continue;
    state.editingMessageId = m.id;
    state.pickerForMessageId = null;
    render();
    return true;
  }
  return false;
}

function focusComposer(): void {
  setTimeout(() => {
    rootEl.querySelector<HTMLInputElement>(".send-form input[name=body]")?.focus();
  }, 0);
}

function navigateUnreadChannel(direction: 1 | -1): void {
  const channels = state.channels.filter((c) => c.kind === "text");
  if (channels.length === 0) return;
  const unread = channels.filter((c) => (state.unread[c.id] ?? 0) > 0);
  if (unread.length === 0) {
    setTransientStatus("Нет непрочитанных каналов");
    return;
  }
  const curIdx = state.selectedChannelId
    ? unread.findIndex((c) => c.id === state.selectedChannelId)
    : -1;
  const next = unread[(curIdx + direction + unread.length) % unread.length] ?? unread[0];
  void selectChannel(next.id);
}

function markServerRead(): void {
  const channels = state.channels.filter((c) => (state.unread[c.id] ?? 0) > 0);
  if (channels.length === 0) {
    setTransientStatus("Нет непрочитанных");
    return;
  }
  for (const c of channels) {
    const last = state.messages.filter((m) => m.channelId === c.id).slice(-1)[0];
    void httpClient.post(`/api/v1/channels/${c.id}/read`, last ? { lastMessageId: last.id } : {}).catch(() => {
      /* idempotent */
    });
    state.unread[c.id] = 0;
  }
  render();
  setTransientStatus(`Отмечено прочитанным: ${channels.length}`);
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
  // Wave 3: заявки в друзья ведут на экран «Друзья» (DM-home, таб pending).
  if (item.kind === "friend_request" || item.kind === "friend_accept") {
    state.friendsTab = item.kind === "friend_request" ? "pending" : "all";
    state.dmMode = true;
    state.selectedChannelId = null;
    state.messages = [];
    render();
    void loadFriends();
    return;
  }
  const targetChannel = item.payload.channelId;
  const targetWorkspace = item.payload.workspaceId;
  // DM-канал — workspaceId payload пустой, channelId есть. Выходим из
  // ws-режима в DM-режим и убеждаемся что state.dms загружен (иначе
  // selectChannel сработает, но имена peer'ов покажутся как uuid и
  // renderDMChannelView не найдёт peer-инфо).
  const isDM = !targetWorkspace && !!targetChannel;
  if (isDM) {
    state.dmMode = true;
    if (state.dms.length === 0) await loadDMs();
  } else if (targetWorkspace && targetWorkspace !== state.selectedWorkspaceId) {
    state.dmMode = false;
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

// Pinned messages: лениво грузим список при открытии popup'а. Realtime
// `message.pinned`/`unpinned` обновляет state.channelPins на месте,
// перезагружать не нужно.
async function loadChannelPins(channelId: string): Promise<void> {
  state.channelPinsLoading = true;
  state.channelPinsChannelId = channelId;
  state.channelPins = [];
  render();
  try {
    const data = await httpClient.get<{ items: Message[] }>(`/api/v1/channels/${channelId}/pins`);
    if (state.channelPinsChannelId !== channelId) return; // race-guard
    state.channelPins = data.items ?? [];
  } catch (err) {
    state.status = describeError(err);
  } finally {
    state.channelPinsLoading = false;
    render();
  }
}

function togglePinsPopup(channelId: string): void {
  if (state.pinsPopupOpen) {
    state.pinsPopupOpen = false;
    render();
    return;
  }
  state.pinsPopupOpen = true;
  if (state.channelPinsChannelId !== channelId) {
    void loadChannelPins(channelId);
  } else {
    render();
  }
}

function renderPinsPopup(): string {
  if (state.channelPinsLoading) {
    return `<div class="pins-popup"><div class="pins-empty">Загрузка…</div></div>`;
  }
  if (state.channelPins.length === 0) {
    return `<div class="pins-popup">
      <div class="pins-popup-header">${t("header.pins")}</div>
      <div class="pins-empty">${t("pins.empty")}</div>
    </div>`;
  }
  const items = state.channelPins.map((m) => {
    const author = describePeer(m.authorId);
    const when = formatTimeSmart(m.pinnedAt ?? m.createdAt);
    const preview = m.body
      ? renderBody(m.body.length > 180 ? m.body.slice(0, 180) + "…" : m.body, m.mentionEveryone)
      : (m.attachments && m.attachments.length > 0 ? `<em>Файл (${m.attachments.length})</em>` : "<em>пусто</em>");
    return `
      <div class="pin-row" data-pin-jump="${m.id}">
        <div class="pin-row-head">
          <span class="pin-row-author"${authorColorStyle(m.authorId)}>${escapeHtml(author)}</span>
          <span class="pin-row-time">${when}</span>
        </div>
        <div class="pin-row-body">${preview}</div>
      </div>
    `;
  }).join("");
  return `
    <div class="pins-popup">
      <div class="pins-popup-header">${t("header.pins")} · ${state.channelPins.length}</div>
      <div class="pins-popup-list">${items}</div>
    </div>
  `;
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

async function loadMembers(generation?: number): Promise<void> {
  if (!state.selectedWorkspaceId) return;
  state.membersLoading = true;
  state.members = [];
  render();
  try {
    const data = await httpClient.get<{ items: Member[] }>(`/api/v1/workspaces/${state.selectedWorkspaceId}/members`);
    if (generation !== undefined && generation !== syncGeneration) return;
    state.members = data.items ?? [];
  } catch (err) {
    state.status = describeError(err);
  } finally {
    state.membersLoading = false;
    render();
  }
}

// Wave 2: клиентские slash-команды (Discord-набор). Неизвестная /команда
// уходит обычным текстом — как в Discord. /nick — действие без отправки.
const SLASH_COMMANDS: { name: string; args: string; desc: string }[] = [
  { name: "shrug", args: "[текст]", desc: "¯\\_(ツ)_/¯ в конец сообщения" },
  { name: "tableflip", args: "[текст]", desc: "(╯°□°)╯︵ ┻━┻" },
  { name: "unflip", args: "[текст]", desc: "┬─┬ ノ( ゜-゜ノ)" },
  { name: "me", args: "текст", desc: "Курсивное сообщение-действие" },
  { name: "spoiler", args: "текст", desc: "Спрятать текст под спойлер" },
  { name: "nick", args: "имя", desc: "Сменить отображаемое имя" }
];

type SlashAction = { kind: "send"; body: string } | { kind: "nick"; name: string };

function transformSlashCommand(body: string): SlashAction {
  if (!body.startsWith("/")) return { kind: "send", body };
  const sp = body.indexOf(" ");
  const cmd = (sp === -1 ? body.slice(1) : body.slice(1, sp)).toLowerCase();
  const arg = sp === -1 ? "" : body.slice(sp + 1).trim();
  switch (cmd) {
    case "shrug":
      // Backslash перед `_` — чтобы renderBody не превратил (ツ) в курсив
      // (MD_ESCAPE_RE стэшит литеральный символ).
      return { kind: "send", body: `${arg ? arg + " " : ""}¯\\_(ツ)\\_/¯` };
    case "tableflip":
      return { kind: "send", body: `${arg ? arg + " " : ""}(╯°□°)╯︵ ┻━┻` };
    case "unflip":
      return { kind: "send", body: `${arg ? arg + " " : ""}┬─┬ ノ( ゜-゜ノ)` };
    case "me":
      return { kind: "send", body: arg ? `*${arg}*` : body };
    case "spoiler":
      return { kind: "send", body: arg ? `||${arg}||` : body };
    case "nick":
      return { kind: "nick", name: arg };
    default:
      return { kind: "send", body };
  }
}

// Popup-подсказка по «/» в начале композера. Переиспользует CSS mention-popup.
function updateSlashPopup(input: HTMLInputElement): void {
  const popup = rootEl.querySelector<HTMLDivElement>("#slash-popup");
  if (!popup) return;
  const m = /^\/([a-z]*)$/i.exec(input.value);
  if (!m) {
    popup.hidden = true;
    return;
  }
  const q = m[1].toLowerCase();
  const hits = SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
  if (hits.length === 0) {
    popup.hidden = true;
    return;
  }
  popup.innerHTML = hits
    .map(
      (c) => `
    <button type="button" class="mention-item slash-item" data-slash="${c.name}">
      <span class="slash-name">/${c.name}${c.args ? ` <span class="slash-args">${escapeHtml(c.args)}</span>` : ""}</span>
      <span class="slash-desc">${escapeHtml(c.desc)}</span>
    </button>`
    )
    .join("");
  popup.hidden = false;
  popup.querySelectorAll<HTMLButtonElement>("[data-slash]").forEach((b) => {
    b.addEventListener("click", () => {
      input.value = `/${b.dataset.slash} `;
      popup.hidden = true;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
}

// Wave 2: typing-индикатор «X печатает…». Полностью transient: отправка с
// клиентским throttle 3с (сервер дополнительно троттлит 2с), приём — TTL 8с
// в module-map. Строка под композером обновляется прямым DOM-mutate, без
// render() — иначе каждое чужое нажатие дёргало бы фокус и message-list.
const TYPING_SEND_INTERVAL_MS = 3000;
const TYPING_TTL_MS = 8000;
let typingLastSentAt = 0;
const typingByChannel = new Map<string, Map<string, number>>(); // channelId → userId → expiresAt
let typingPruneTimer: ReturnType<typeof setInterval> | null = null;

function maybeSendTyping(): void {
  const chId = state.selectedChannelId;
  if (!chId) return;
  const ch = state.channels.find((c) => c.id === chId);
  // Wave 9: в тредах typing работает как в тексте. DM-каналов нет в
  // state.channels — для них ch=undefined, шлём.
  if (ch && ch.kind !== "text" && ch.kind !== "thread") return;
  const now = Date.now();
  if (now - typingLastSentAt < TYPING_SEND_INTERVAL_MS) return;
  typingLastSentAt = now;
  realtimeClient.send("typing.start", { channel_id: chId });
}

function noteTyping(channelId: string, userId: string): void {
  if (state.me && userId === state.me.id) return;
  let perUser = typingByChannel.get(channelId);
  if (!perUser) {
    perUser = new Map();
    typingByChannel.set(channelId, perUser);
  }
  perUser.set(userId, Date.now() + TYPING_TTL_MS);
  ensureTypingPrune();
  if (channelId === state.selectedChannelId) updateTypingLine();
}

function clearTyping(channelId: string | undefined, userId: string): void {
  if (!channelId) return;
  const perUser = typingByChannel.get(channelId);
  if (!perUser) return;
  perUser.delete(userId);
  if (perUser.size === 0) typingByChannel.delete(channelId);
  if (channelId === state.selectedChannelId) updateTypingLine();
}

function ensureTypingPrune(): void {
  if (typingPruneTimer) return;
  typingPruneTimer = setInterval(() => {
    const now = Date.now();
    let activeDirty = false;
    for (const [chId, perUser] of typingByChannel) {
      for (const [uid, exp] of perUser) {
        if (exp <= now) {
          perUser.delete(uid);
          if (chId === state.selectedChannelId) activeDirty = true;
        }
      }
      if (perUser.size === 0) typingByChannel.delete(chId);
    }
    if (typingByChannel.size === 0 && typingPruneTimer) {
      clearInterval(typingPruneTimer);
      typingPruneTimer = null;
    }
    if (activeDirty) updateTypingLine();
  }, 2000);
}

function updateTypingLine(): void {
  const el = rootEl.querySelector<HTMLElement>("#typing-line");
  if (!el) return;
  const perUser = state.selectedChannelId ? typingByChannel.get(state.selectedChannelId) : undefined;
  const now = Date.now();
  const names: string[] = [];
  if (perUser) {
    for (const [uid, exp] of perUser) {
      if (exp > now) names.push(describePeer(uid));
    }
  }
  if (names.length === 0) {
    el.textContent = "";
    el.classList.remove("active");
    return;
  }
  el.classList.add("active");
  el.textContent =
    names.length === 1
      ? t("chat.typing.one", { a: names[0] })
      : names.length === 2
        ? t("chat.typing.two", { a: names[0], b: names[1] })
        : t("chat.typing.many");
}

function handleRealtimeEvent(event: RealtimeEvent): void {
  if (event.event === "sync.required") {
    const cursor = Number((event.payload as { cursor?: unknown } | null)?.cursor);
    void resyncAfterReconnect(Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined);
    return;
  }
  if (event.event === "sync.ready") {
    const payload = event.payload as { cursor?: unknown; workspaces?: unknown } | null;
    const remote = Array.isArray(payload?.workspaces)
      ? payload.workspaces.filter((id): id is string => typeof id === "string").sort()
      : [];
    const local = state.workspaces.map((workspace) => workspace.id).sort();
    if (state.me && (remote.length !== local.length || remote.some((id, index) => id !== local[index]))) {
      const cursor = Number(payload?.cursor);
      realtimeClient.beginSnapshot();
      void resyncAfterReconnect(Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined);
    }
    return;
  }
  // Wave 2: typing-индикатор. Transient, не зависит от селекции — копим
  // в module-map с TTL, строка обновляется прямым DOM-mutate.
  if (event.event === "typing.start") {
    const p = event.payload as { channelId: string; userId: string };
    if (p?.channelId && p?.userId) noteTyping(p.channelId, p.userId);
    return;
  }
  // Wave 3: изменения дружбы — перетягиваем список (события редкие,
  // полный reload дешевле инкрементального state-менеджмента).
  if (event.event === "friend.request" || event.event === "friend.accepted" || event.event === "friend.removed") {
    void loadFriends();
    return;
  }
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
  // Workspace meta updated (name/avatar/welcome). Сохраняем locally
  // role/welcomeChannelId если payload их не содержит — бэк может
  // зачистить role в публикации (она per-user).
  if (event.event === "workspace.updated") {
    const p = event.payload as Partial<Workspace> & { id: string };
    state.workspaces = state.workspaces.map((w) => {
      if (w.id !== p.id) return w;
      return {
        ...w,
        name: p.name ?? w.name,
        avatarMediaId: p.avatarMediaId !== undefined ? p.avatarMediaId : w.avatarMediaId,
        welcomeChannelId: p.welcomeChannelId !== undefined ? p.welcomeChannelId : w.welcomeChannelId
      };
    });
    render();
    return;
  }
  // User avatar / displayName changed. Обновляем state.members[*] и
  // state.dms[*].peer + state.me если это мы.
  if (event.event === "user.updated") {
    const p = event.payload as { userId: string; avatarMediaId?: string; displayName?: string };
    if (state.me && state.me.id === p.userId) {
      state.me = {
        ...state.me,
        avatarMediaId: p.avatarMediaId || undefined,
        displayName: p.displayName || state.me.displayName
      };
    }
    state.members = state.members.map((m) =>
      m.userId === p.userId
        ? { ...m, avatarMediaId: p.avatarMediaId || undefined, displayName: p.displayName || m.displayName }
        : m
    );
    state.dms = state.dms.map((d) =>
      d.peer.userId === p.userId
        ? { ...d, peer: { ...d.peer, avatarMediaId: p.avatarMediaId || undefined, displayName: p.displayName || d.peer.displayName } }
        : d
    );
    render();
    return;
  }
  // voice.joined/voice.left — обновляем глобальный voicePeekAll для
  // ВСЕХ voice-каналов воркспейса, не только выбранного. Это и есть
  // данные для inline-списка участников под voice-каналом в sidebar.
  if (event.event === "voice.joined") {
    const p = event.payload as VoicePeekParticipant & { channelId: string };
    const list = state.voicePeekAll[p.channelId] ?? [];
    if (!list.some((x) => x.sessionId === p.sessionId)) {
      state.voicePeekAll = { ...state.voicePeekAll, [p.channelId]: [...list, p] };
    }
    if (state.voicePeek?.channelId === p.channelId &&
        !state.voicePeek.participants.some((x) => x.sessionId === p.sessionId)) {
      state.voicePeek = { ...state.voicePeek, participants: [...state.voicePeek.participants, p] };
    }
    render();
    return;
  }
  if (event.event === "voice.left") {
    const p = event.payload as { channelId: string; sessionId: string };
    const list = state.voicePeekAll[p.channelId] ?? [];
    const next = list.filter((x) => x.sessionId !== p.sessionId);
    const allCopy = { ...state.voicePeekAll };
    if (next.length === 0) delete allCopy[p.channelId];
    else allCopy[p.channelId] = next;
    state.voicePeekAll = allCopy;
    if (state.voicePeek?.channelId === p.channelId) {
      state.voicePeek = {
        ...state.voicePeek,
        participants: state.voicePeek.participants.filter((x) => x.sessionId !== p.sessionId)
      };
    }
    render();
    return;
  }
  if (event.event === "channel.created") {
    const ch = event.payload as Channel;
    if (ch.workspaceId !== state.selectedWorkspaceId) return;
    if (state.channels.some((c) => c.id === ch.id)) return;
    state.channels = [...state.channels, ch];
    if (ch.kind === "thread" && ch.parentChannelId && ch.parentChannelId === state.selectedChannelId) {
      // Wave 10: тред на сообщении открытого text-канала — вешаем чип на
      // корневое сообщение сразу (агрегаты придут при следующем refetch'е).
      if (ch.rootMessageId) {
        const idx = state.messages.findIndex((m) => m.id === ch.rootMessageId);
        if (idx >= 0 && !state.messages[idx].thread) {
          const next = state.messages.slice();
          next[idx] = {
            ...next[idx],
            thread: { threadId: ch.id, title: ch.name, messageCount: 0, lastActivityAt: ch.createdAt }
          };
          state.messages = next;
        }
      } else {
        // Wave 9: новый пост в открытом форуме — перечитываем карточки.
        void loadForumPosts(ch.parentChannelId, /*keepCurrent*/ true);
        return;
      }
    }
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
  // J.5: realtime category events.
  if (event.event === "category.created" || event.event === "category.updated") {
    const cat = event.payload as ChannelCategory;
    if (cat.workspaceId !== state.selectedWorkspaceId) return;
    if (event.event === "category.created" && !state.categories.some((c) => c.id === cat.id)) {
      state.categories = [...state.categories, cat];
    } else {
      state.categories = state.categories.map((c) => (c.id === cat.id ? cat : c));
    }
    render();
    return;
  }
  if (event.event === "category.deleted") {
    const p = event.payload as { categoryId: string; workspaceId: string };
    if (p.workspaceId !== state.selectedWorkspaceId) return;
    state.categories = state.categories.filter((c) => c.id !== p.categoryId);
    state.channels = state.channels.map((ch) =>
      ch.categoryId === p.categoryId ? { ...ch, categoryId: null } : ch
    );
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
      // Wave 9/10: сообщение в треде, чей родитель сейчас открыт. Для
      // форума перечитываем карточки, для text-канала — двигаем чип
      // «N ответов» на корневом сообщении (только user-сообщения, чтобы
      // system-плашка контекста не считалась ответом).
      const threadCh = state.channels.find((c) => c.id === event.channelId);
      if (threadCh?.kind === "thread" && threadCh.parentChannelId === state.selectedChannelId) {
        if (threadCh.rootMessageId) {
          if (!msg.kind || msg.kind === "user") {
            const idx = state.messages.findIndex((m) => m.id === threadCh.rootMessageId);
            if (idx >= 0) {
              const next = state.messages.slice();
              const prev = next[idx].thread;
              next[idx] = {
                ...next[idx],
                thread: {
                  threadId: threadCh.id,
                  title: prev?.title ?? threadCh.name,
                  messageCount: (prev?.messageCount ?? 0) + 1,
                  lastActivityAt: msg.createdAt
                }
              };
              state.messages = next;
              render();
            }
          }
        } else {
          void loadForumPosts(threadCh.parentChannelId!, /*keepCurrent*/ true);
        }
      }
      // Замьюченный канал — не инкрементим unread (Discord-like: канал
      // в списке остаётся серым, без badge'а). Mentions всё равно приходят
      // через notification.created, обрабатываются выше.
      if (msg.authorId !== state.me?.id && !isChannelMuted(event.channelId)) {
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
      // Сообщение пришло — его автор очевидно допечатал.
      clearTyping(event.channelId!, msg.authorId);
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
    // Wave 2: worker допилил OG-карточки — дописываем в сообщение.
    case "message.previews.updated": {
      const p = event.payload as { messageId: string; linkPreviews?: LinkPreview[] };
      state.messages = state.messages.map((m) =>
        m.id === p.messageId ? { ...m, linkPreviews: p.linkPreviews ?? [] } : m
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
    case "message.pinned": {
      const msg = event.payload as Message;
      state.messages = state.messages.map((m) =>
        m.id === msg.id ? { ...m, isPinned: true, pinnedAt: msg.pinnedAt } : m
      );
      if (state.channelPinsChannelId === msg.channelId) {
        // Кладём в начало (свежеприкреплённое выше). Если уже есть — replace.
        const without = state.channelPins.filter((p) => p.id !== msg.id);
        state.channelPins = [msg, ...without];
      }
      render();
      break;
    }
    case "message.unpinned": {
      const p = event.payload as { id: string; channelId: string };
      state.messages = state.messages.map((m) =>
        m.id === p.id ? { ...m, isPinned: false, pinnedAt: undefined } : m
      );
      if (state.channelPinsChannelId === p.channelId) {
        state.channelPins = state.channelPins.filter((x) => x.id !== p.id);
      }
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
  "#audit-filter-actor",
  "#friend-add-input",
  "#user-note-input"
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
  armStatusAutoClear();
  // Пере-рендер уносит hover-элемент из DOM — открытый тултип залипал бы.
  hideTooltip();
  if (!httpClient.getTokens()) {
    renderAuth();
    return;
  }
  if (state.bootError && !state.me) {
    renderConnectionLost();
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
  // Wave 2: #typing-line пересоздан пустым — восстанавливаем из map.
  updateTypingLine();
}

// Смена сервера: стираем токены и сохранённый адрес, после перезагрузки
// показывается экран «Подключение к серверу». Вызывается с экрана входа,
// экрана «Сервер недоступен» и вкладки настроек «Сервер».
async function switchServer(): Promise<void> {
  const ok = await confirmDialog({
    title: "Сменить сервер",
    body: "Отключиться от текущего сервера и ввести новый адрес? Локальные токены будут удалены.",
    confirmLabel: "Сменить",
    danger: true
  });
  if (!ok) return;
  try { localStorage.removeItem("rucord:tokens"); } catch {}
  clearStoredServerUrl();
  window.location.reload();
}

// Экран «Сервер недоступен»: токены целы, пользователь не разлогинен.
function renderConnectionLost(): void {
  const serverUrl = getStoredServerUrl() ?? httpClient.baseUrl;
  rootEl.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <h1>Сервер недоступен</h1>
        <p class="onboarding-hint">
          Не удалось связаться с сервером${serverUrl ? ` <code>${escapeHtml(serverUrl)}</code>` : ""}.
          Ты не вышел из аккаунта: как только связь вернётся, нажми «Повторить».
        </p>
        <div class="auth-error" role="alert">${escapeHtml(state.bootError ?? "")}</div>
        <div class="connection-lost-actions">
          <button type="button" class="primary" id="connection-retry">Повторить</button>
          ${isProductionShell() ? `<button type="button" class="ghost" id="connection-switch">Сменить сервер</button>` : ""}
        </div>
      </div>
    </div>
  `;
  rootEl.querySelector<HTMLButtonElement>("#connection-retry")?.addEventListener("click", () => {
    state.bootError = null;
    void bootstrapSession();
  });
  rootEl.querySelector<HTMLButtonElement>("#connection-switch")?.addEventListener("click", () => {
    void switchServer();
  });
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
            <input name="username" minlength="3" maxlength="32" data-tooltip="строчные a-z, 0-9, нижнее подчёркивание; 3-32 символа" placeholder="username" />
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
  polishNativeControls(rootEl);
  rootEl.querySelector<HTMLButtonElement>(".auth-switch-server")?.addEventListener("click", () => {
    void switchServer();
  });
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
    ${connState === "reconnecting" && me ? `
      <div class="conn-banner" role="status">
        <span class="conn-banner-spinner"></span>
        ${t("conn.reconnecting")}
      </div>
    ` : ""}
    ${me ? renderUpdateBanner() : ""}
    <div class="shell${showMembers ? " with-members" : ""}">
      <aside class="ws-rail">
        <button id="ws-rail-dm" class="ws-rail-icon ws-rail-home${dmMode ? " active" : ""}" data-tooltip="Личные сообщения" aria-label="Личные сообщения">
          ${icon("users")}
          ${dmBadge}
        </button>
        <div class="ws-rail-divider"></div>
        ${state.workspaces
          .map((ws) => {
            const active = !dmMode && ws.id === state.selectedWorkspaceId ? " active" : "";
            const mediaAttr = ws.avatarMediaId ? ` data-avatar-media="${escapeHtml(ws.avatarMediaId)}"` : "";
            return `
          <button class="ws-rail-icon${active}" data-ws="${ws.id}"${mediaAttr} data-tooltip="${escapeHtml(ws.name)}" aria-label="${escapeHtml(ws.name)}">
            <span class="ws-rail-letter">${escapeHtml(ws.name.charAt(0).toUpperCase())}</span>
          </button>
        `;
          })
          .join("")}
        <div class="ws-rail-spacer"></div>
        <button id="ws-rail-create" class="ws-rail-icon ws-rail-add" data-tooltip="Создать воркспейс" aria-label="Создать воркспейс">+</button>
        <button id="ws-rail-invite" class="ws-rail-icon ws-rail-add" data-tooltip="Принять инвайт" aria-label="Принять инвайт">↵</button>
      </aside>
      <aside class="ch-panel">
        <header class="ch-panel-header">
          ${dmMode || !selectedWorkspace
            ? `<span class="ch-panel-title">${dmMode ? "Личные сообщения" : "Нет воркспейса"}</span>`
            : `<button id="open-ws-menu" class="ch-panel-title ch-panel-menu-btn" aria-haspopup="menu" aria-expanded="${state.workspaceMenuOpen ? "true" : "false"}">
                 <span>${escapeHtml(selectedWorkspace.name)}</span>
                 <span class="ch-panel-menu-glyph">${state.workspaceMenuOpen ? "▴" : "▾"}</span>
               </button>`}
          ${state.workspaceMenuOpen && !dmMode && selectedWorkspace ? renderWorkspaceHeaderMenu(selectedWorkspace, canModerate) : ""}
        </header>
        <div class="ch-panel-body">
          ${
            dmMode
              ? renderDMSidebarList()
              : (state.selectedWorkspaceId ? renderChannelsBlock() : `<div class="ch-panel-empty">Выбери воркспейс слева или создай новый кнопкой +.</div>`)
          }
          ${renderVoiceStrip()}
        </div>
        <footer class="user-strip">
          <button id="open-status" class="user user-btn" data-tooltip="Изменить статус">
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
            ${me?.isRoot ? `<button id="open-admin" class="ghost" data-tooltip="Админ-панель" aria-label="Админ-панель">${icon("shield")}</button>` : ""}
            <button id="open-profile" class="ghost" data-tooltip="Настройки" aria-label="Настройки">${icon("settings")}</button>
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
      ${renderMemberMenu()}
      ${renderCategoryMenu()}
      ${renderVoiceVolumeMenu()}
      ${renderStatusMenu()}
    </div>
  `;
  attachShellHandlers();
  attachVoiceVideoStreams();
  updatePttIndicator();
  polishListboxes(rootEl);
  polishNativeControls(rootEl);
}

// Полиш-проход по свежему innerHTML: гасим браузерные артефакты нативных
// элементов, которые размечать в каждом шаблоне вручную слишком шумно.
function polishNativeControls(root: ParentNode): void {
  // Спеллчек-подчёркивание уместно только там, где пишут прозу: композер
  // (input name="body") и textarea (bio, посты). Логины, поиск, url, emoji
  // подчёркиваются красным без смысла.
  for (const el of root.querySelectorAll<HTMLInputElement>("input")) {
    if (el.name === "body") continue;
    el.spellcheck = false;
  }
  // a11y: тултипы переехали из title в data-tooltip — иконочным кнопкам без
  // текста возвращаем accessible name.
  for (const el of root.querySelectorAll<HTMLElement>("[data-tooltip]:not([aria-label])")) {
    if (!el.textContent?.trim()) {
      el.setAttribute("aria-label", el.getAttribute("data-tooltip") ?? "");
    }
  }
  // Кастомному треку слайдера нужна стартовая позиция заливки.
  for (const el of root.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
    setSliderFill(el);
  }
}

// Заливка прогресса слайдера: CSS-градиент трека читает --val в процентах.
function setSliderFill(el: HTMLInputElement): void {
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const value = Number(el.value);
  const pct = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
  el.style.setProperty("--val", `${pct}%`);
}

// Артефакты WebView, живущие на window: нативное контекстное меню вне полей
// ввода и drag&drop-навигация (файл, брошенный мимо дроп-зоны чата,
// открывался самим WebView2 поверх приложения).
let nativeGuardsInstalled = false;
function installNativeGuards(): void {
  if (nativeGuardsInstalled) return;
  nativeGuardsInstalled = true;
  window.addEventListener("contextmenu", (e) => {
    const target = e.target instanceof HTMLElement ? e.target : null;
    // В полях ввода нативное меню полезно: вставка, спеллчек-замены.
    if (target?.closest('input, textarea, [contenteditable="true"]')) return;
    // Выделенный текст: оставляем нативное «Копировать».
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    e.preventDefault();
  });
  window.addEventListener("dragover", (e) => {
    if (e.target instanceof HTMLElement && e.target.closest("main.content")) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  });
  window.addEventListener("drop", (e) => {
    if (e.target instanceof HTMLElement && e.target.closest("main.content")) return;
    e.preventDefault();
  });
  // Живое обновление заливки слайдеров: войс-настройки меняют value без
  // render(), полиш-проход это не догоняет. document — чтобы достать и
  // слайдеры в диалогах вне rootEl.
  document.addEventListener("input", (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === "range") setSliderFill(e.target);
  });
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

// H.7: цвета ролей. По умолчанию подтягиваем из workspace_roles
// (loadWsRoles при выборе ws); хардкод-палитра ниже — fallback пока
// данные не загружены либо для роли не задан color в БД (member-роль
// в seed'е — null). member-роль без цвета остаётся дефолтным --text.
const ROLE_COLORS_FALLBACK: Record<string, string> = {
  owner: "#ed4245",
  admin: "#5865f2",
  moderator: "#3ba55c"
};

function getRoleColor(roleCode: string | undefined | null): string | undefined {
  if (!roleCode) return undefined;
  if (state.wsRoles.length > 0) {
    const role = state.wsRoles.find((r) => r.code === roleCode);
    if (role) return role.color ?? undefined;
  }
  return ROLE_COLORS_FALLBACK[roleCode];
}

// Wave 5: union-резолвер «высшей роли» (H.7 ограничение снято). Цвет юзера =
// цвет самой высокой (по position) роли с цветом среди ВСЕХ его ролей
// (workspace_role_members через wsRoles[].memberUserIds + primary role_code).
// Кеш сбрасывается при смене wsRoles/воркспейса (userColorCache = null).
let userColorCache: Map<string, string | undefined> | null = null;

function getUserColor(userId: string, primaryRole: string | undefined | null): string | undefined {
  if (state.wsRoles.length === 0) {
    return getRoleColor(primaryRole); // данные не загружены — fallback
  }
  if (!userColorCache) userColorCache = new Map();
  if (userColorCache.has(userId)) return userColorCache.get(userId);
  let color: string | undefined;
  // wsRoles приходит с бэка отсортированным по position desc.
  for (const r of state.wsRoles) {
    if (!r.color) continue;
    if (r.memberUserIds.includes(userId) || (primaryRole && r.code === primaryRole)) {
      color = r.color;
      break;
    }
  }
  userColorCache.set(userId, color);
  return color;
}

async function loadWsRoles(workspaceId: string, generation?: number): Promise<void> {
  try {
    const data = await httpClient.get<{ items: WorkspaceRole[] }>(`/api/v1/workspaces/${workspaceId}/roles`);
    // Race-guard: ответ устарел если юзер успел переключить воркспейс.
    if (state.selectedWorkspaceId !== workspaceId || (generation !== undefined && generation !== syncGeneration)) return;
    state.wsRoles = data.items ?? [];
    userColorCache = null;
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
  // Wave 7 (I.15): id пресета рамки (AVATAR_DECORATIONS).
  decoration?: string;
}

// Wave 7 (I.15–I.16): CSS-пресеты рамок аватара и эффектов баннера.
// Без файлов-ассетов — всё рисуют keyframes в styles.css. Неизвестный id
// (например, из будущей версии) молча игнорируется.
const AVATAR_DECORATIONS: Array<{ id: string; label: string }> = [
  { id: "gold", label: "Золотое кольцо" },
  { id: "neon", label: "Неоновое свечение" },
  { id: "rainbow", label: "Радуга" },
  { id: "frost", label: "Иней" },
  { id: "ember", label: "Уголёк" }
];

const PROFILE_EFFECTS: Array<{ id: string; label: string }> = [
  { id: "sparkles", label: "Искры" },
  { id: "pulse", label: "Пульс" },
  { id: "rain", label: "Дождь" },
  { id: "aurora", label: "Северное сияние" }
];

function decorationClass(id: string | undefined | null): string {
  if (!id) return "";
  return AVATAR_DECORATIONS.some((d) => d.id === id) ? ` avatar-deco-${id}` : "";
}

function renderAvatar(opts: AvatarOpts): string {
  const letter = (opts.fallbackText || "?").charAt(0).toUpperCase();
  const dot = opts.online === undefined || opts.online === null
    ? ""
    : `<span class="avatar-dot${opts.online ? " on" : " off"}"></span>`;
  const cls = `avatar-pic ${opts.className ?? ""}`.trim() + decorationClass(opts.decoration);
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
    // Wave 7: градиент имени (личная кастомизация) приоритетнее role-цвета.
    const grad = nameGradientStyle(m.nameGradient);
    const color = getUserColor(m.userId, m.role);
    const style = grad || (color ? ` style="color:${color};"` : "");
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
            sizePx: 28,
            decoration: m.avatarDecoration
          })}
          <span class="presence-dot ${presenceDotClass(effMode)}"></span>
        </span>
        <span class="member-sidebar-body">
          <span class="member-sidebar-name"${style}>${escapeHtml(name)}</span>${badgeHtml(m.badgeEmoji, m.badgeLabel)}
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
  // H.3 → Wave 5: секции строятся из hoisted-ролей воркспейса (включая
  // кастомные) по position desc. Онлайн-юзер попадает в секцию своей
  // высшей hoisted-роли (union: workspace_role_members + primary role);
  // остальные онлайн — «В сети», все офлайн — «Не в сети». Пока wsRoles
  // не загружен — fallback к жёсткой схеме owner/admin/moderator.
  const online = sorted.filter((m) => m.online);
  const offline = sorted.filter((m) => !m.online);
  let groupsHtml: string;
  if (state.wsRoles.length > 0) {
    const hoisted = state.wsRoles.filter((r) => r.hoisted); // уже position desc
    const used = new Set<string>();
    const sections: string[] = [];
    for (const role of hoisted) {
      const members = online.filter(
        (m) => !used.has(m.userId) && (role.memberUserIds.includes(m.userId) || m.role === role.code)
      );
      members.forEach((m) => used.add(m.userId));
      sections.push(renderGroup(role.name, members));
    }
    const rest = online.filter((m) => !used.has(m.userId));
    sections.push(renderGroup(t("members.online"), rest));
    groupsHtml = sections.join("");
  } else {
    const owners = online.filter((m) => m.role === "owner");
    const admins = online.filter((m) => m.role === "admin");
    const moderators = online.filter((m) => m.role === "moderator");
    const onlineMembers = online.filter(
      (m) => m.role !== "owner" && m.role !== "admin" && m.role !== "moderator"
    );
    groupsHtml =
      renderGroup(t("members.owner"), owners) +
      renderGroup(t("members.admins"), admins) +
      renderGroup(t("members.mods"), moderators) +
      renderGroup(t("members.online"), onlineMembers);
  }
  return `
    <aside class="member-sidebar">
      ${groupsHtml}
      ${renderGroup(t("members.offline"), offline)}
      ${state.members.length === 0 ? `<div class="member-sidebar-empty">${t("members.none")}</div>` : ""}
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
  const hasUnread = (state.unread[ch.id] ?? 0) > 0;
  // Wave 4: уровень уведомлений. Явный канальный выбор; пусто = наследовать
  // от воркспейса (показываем что унаследуется).
  const explicitLevel = state.notifPrefs.channels[ch.id] ?? "";
  const inheritedLevel = isNotifLevel(state.notifPrefs.workspaces[ch.workspaceId])
    ? state.notifPrefs.workspaces[ch.workspaceId]
    : "all";
  const notifItem = (lvl: string, label: string) =>
    `<button class="channel-menu-item notif-level${explicitLevel === lvl ? " checked" : ""}" data-channel-action="notif" data-id="${ch.id}" data-level="${lvl}">${explicitLevel === lvl ? "✓" : "·"} ${label}</button>`;
  return `
    <div class="channel-menu-backdrop" data-channel-menu-close></div>
    <div class="channel-menu" style="left:${menu.x}px;top:${menu.y}px;" role="menu">
      <div class="channel-menu-header">${channelPrefix(ch)} ${escapeHtml(ch.name)}</div>
      ${hasUnread ? `<button class="channel-menu-item" data-channel-action="mark-read" data-id="${ch.id}">${t("menu.markread")}</button>` : ""}
      ${canModerate ? `<button class="channel-menu-item" data-channel-action="invite" data-id="${ch.id}">${t("menu.invite")}</button>` : ""}
      <div class="channel-menu-separator"></div>
      <div class="channel-menu-subheader">${t("modal.notifications")}</div>
      ${notifItem("", t("menu.notif_inherit", { lvl: t(`notif.short.${inheritedLevel}`) }))}
      ${notifItem("all", t("notif.all"))}
      ${notifItem("mentions", t("notif.mentions"))}
      ${notifItem("none", t("notif.none"))}
      <div class="channel-menu-separator"></div>
      ${canManage ? `<button class="channel-menu-item" data-channel-action="rename" data-id="${ch.id}">${t("menu.rename")}</button>` : ""}
      ${canManage ? `<button class="channel-menu-item" data-channel-action="clone" data-id="${ch.id}">${t("menu.clone")}</button>` : ""}
      ${canManage ? `<button class="channel-menu-item" data-channel-action="${ch.archivedAt ? "unarchive" : "archive"}" data-id="${ch.id}">${ch.archivedAt ? t("menu.unarchive") : t("menu.archive")}</button>` : ""}
      <button class="channel-menu-item" data-channel-action="copy-id" data-id="${ch.id}">${t("menu.copyid")}</button>
      ${canManage ? `<div class="channel-menu-separator"></div><button class="channel-menu-item danger" data-channel-action="delete" data-id="${ch.id}">${t("menu.delete_channel")}</button>` : ""}
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
      ${canManage ? `<button class="channel-menu-item" data-workspace-action="upload-icon" data-id="${ws.id}">${ws.avatarMediaId ? t("menu.icon.change") : t("menu.icon.upload")}</button>` : ""}
      ${canManage && ws.avatarMediaId ? `<button class="channel-menu-item" data-workspace-action="remove-icon" data-id="${ws.id}">${t("menu.icon.remove")}</button>` : ""}
      ${canManage ? `<button class="channel-menu-item" data-workspace-action="manage-roles" data-id="${ws.id}">${t("menu.manage_roles")}</button>` : ""}
      ${canManage ? `<button class="channel-menu-item" data-workspace-action="welcome-channel" data-id="${ws.id}">${t("menu.welcome_channel")}</button>` : ""}
      <div class="channel-menu-separator"></div>
      <div class="channel-menu-subheader">${t("menu.ws_notifications")}</div>
      ${(() => {
        const cur = state.notifPrefs.workspaces[ws.id] ?? "";
        const item = (lvl: string, label: string) =>
          `<button class="channel-menu-item notif-level${cur === lvl ? " checked" : ""}" data-workspace-action="notif" data-id="${ws.id}" data-level="${lvl}">${cur === lvl ? "✓" : "·"} ${label}</button>`;
        return item("", t("notif.all")) + item("mentions", t("notif.mentions")) + item("none", t("notif.none"));
      })()}
      <div class="channel-menu-separator"></div>
      <button class="channel-menu-item" data-workspace-action="copy-id" data-id="${ws.id}">${t("menu.copyid")}</button>
    </div>
  `;
}

// Wave 5 (J.5b): ПКМ-меню категории — права + копирование ID.
function renderCategoryMenu(): string {
  const menu = state.categoryMenu;
  if (!menu) return "";
  const cat = state.categories.find((c) => c.id === menu.categoryId);
  if (!cat) return "";
  const ws = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  const canManage = !!ws && ["owner", "admin"].includes(ws.role ?? "");
  return `
    <div class="channel-menu-backdrop" data-category-menu-close></div>
    <div class="channel-menu" style="left:${menu.x}px;top:${menu.y}px;" role="menu">
      <div class="channel-menu-header">${escapeHtml(cat.name)}</div>
      ${canManage ? `<button class="channel-menu-item" data-category-action="permissions" data-id="${cat.id}">${t("menu.cat_perms")}</button>` : ""}
      <button class="channel-menu-item" data-category-action="copy-id" data-id="${cat.id}">${t("menu.copyid")}</button>
    </div>
  `;
}

// Wave 5: ПКМ-меню участника (member-sidebar). Быстрые действия + чек-лист
// ролей (POST/DELETE /roles/{id}/members/{userId}) без захода в roles-модалку.
// Меню остаётся открытым после toggle'а роли — удобно навешивать несколько.
function renderMemberMenu(): string {
  const menu = state.memberMenu;
  if (!menu) return "";
  const m = state.members.find((x) => x.userId === menu.userId);
  if (!m) return "";
  const ws = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  const canManage = !!ws && ["owner", "admin"].includes(ws.role ?? "");
  const isSelf = m.userId === state.me?.id;
  const name = m.displayName || m.username;
  const rolesSection = (() => {
    if (!canManage || state.wsRoles.length === 0) return "";
    const items = state.wsRoles
      .filter((r) => r.code !== "owner") // owner не назначается (бэк вернёт 403)
      .map((r) => {
        const has = r.memberUserIds.includes(m.userId) || m.role === r.code;
        const isPrimary = m.role === r.code; // primary снимается только сменой роли
        const dot = r.color ? `<span class="role-color-dot" style="background:${r.color};"></span>` : "";
        return `<button class="channel-menu-item notif-level${has ? " checked" : ""}" data-member-action="toggle-role" data-id="${m.userId}" data-role-id="${r.id}" ${isPrimary && has ? `disabled data-tooltip="${t("menu.primary_role_hint")}"` : ""}>${has ? "✓" : "·"} ${dot}${escapeHtml(r.name)}</button>`;
      })
      .join("");
    return `<div class="channel-menu-separator"></div>
      <div class="channel-menu-subheader">${t("modal.roles")}</div>
      ${items}`;
  })();
  return `
    <div class="channel-menu-backdrop" data-member-menu-close></div>
    <div class="channel-menu" style="left:${menu.x}px;top:${menu.y}px;" role="menu">
      <div class="channel-menu-header">${escapeHtml(name)}</div>
      <button class="channel-menu-item" data-member-action="profile" data-id="${m.userId}">${t("menu.profile")}</button>
      ${isSelf ? "" : `<button class="channel-menu-item" data-member-action="dm" data-id="${m.userId}">${t("menu.dm")}</button>`}
      ${isSelf ? "" : `<button class="channel-menu-item" data-member-action="call" data-id="${m.userId}">${t("menu.call")}</button>`}
      <button class="channel-menu-item" data-member-action="copy-id" data-id="${m.userId}">${t("menu.copyid")}</button>
      ${rolesSection}
    </div>
  `;
}

// Wave 0: avatarMediaId собеседника для call-bar/call-card. members и dms —
// синхронные источники; если юзера нет ни там, ни там (например, звонок
// пришёл, пока state.members ещё не загружен) — лениво тянем /users/{id},
// кешируем и перерисовываемся по приезду. null в кеше = «fetch уже в полёте
// или упал» (защита от повторных запросов на каждый render).
const peerProfileCache = new Map<string, UserProfileData | null>();
// Wave 3: кеш приватных заметок (userId → note) — анти-рефетч при re-render'ах попапа.
const userNoteCache = new Map<string, string>();

function resolvePeerAvatarMediaId(userId: string | null): string | undefined {
  if (!userId) return undefined;
  if (state.me && userId === state.me.id) return state.me.avatarMediaId;
  const member = state.members.find((m) => m.userId === userId);
  if (member) return member.avatarMediaId;
  const dm = state.dms.find((d) => d.peer.userId === userId);
  if (dm) return dm.peer.avatarMediaId;
  if (!peerProfileCache.has(userId)) {
    peerProfileCache.set(userId, null);
    void httpClient
      .get<UserProfileData>(`/api/v1/users/${userId}`)
      .then((p) => {
        peerProfileCache.set(userId, p);
        render();
      })
      .catch(() => {
        /* останется letter-placeholder */
      });
  }
  return peerProfileCache.get(userId)?.avatarMediaId;
}

function renderCallOverlay(): string {
  const snap = state.callSnapshot;
  if (!snap) return "";
  const peerName = describePeer(snap.peerUserId);
  const avatarHtml = renderAvatar({
    avatarMediaId: resolvePeerAvatarMediaId(snap.peerUserId),
    fallbackText: peerName,
    sizePx: 36,
    className: "call-bar-avatar-pic"
  });
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
          ${avatarHtml}
          <div class="call-bar-name">
            <div class="call-bar-title">${escapeHtml(peerName)}</div>
            <div class="call-bar-meta">
              <span class="call-bar-timer" id="call-timer">${escapeHtml(duration)}</span>
              ${snap.via ? `<span class="call-via ${snap.via}" data-tooltip="${snap.via === "relay" ? "Медиа идёт через TURN-релей (оба участника за NAT) — возможна чуть большая задержка" : "Прямое p2p-соединение"}">${snap.via === "relay" ? "через релей" : "напрямую"}</span>` : ""}
            </div>
          </div>
        </div>
        <div class="call-bar-actions">
          ${callIconButton("call-mute", snap.muted ? "mic-off" : "mic", snap.muted ? "Включить микрофон" : "Заглушить", snap.muted ? "danger" : "")}
          ${callIconButton("call-deafen", isDeafened() ? "headphones-off" : "headphones", isDeafened() ? "Включить звук" : "Заглушить всё", isDeafened() ? "danger" : "")}
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
          ${avatarHtml}
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
  return `<button id="${id}" class="call-icon-btn ${mod}" data-tooltip="${escapeHtml(title)}" aria-label="${escapeHtml(title)}" ${disabled ? "disabled" : ""}>${icon(iconName, { size: 20 })}</button>`;
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

// Wave 7: "#rrggbb,#rrggbb" → пара цветов либо null (битый/пустой формат).
function parseGradient(raw: string | undefined | null): [string, string] | null {
  if (!raw) return null;
  const m = /^(#[0-9a-fA-F]{6}),(#[0-9a-fA-F]{6})$/.exec(raw.trim());
  return m ? [m[1], m[2]] : null;
}

// Wave 7 (I.18): inline-style градиентного текста для имени. Пусто если
// градиент не задан.
function nameGradientStyle(raw: string | undefined | null): string {
  const g = parseGradient(raw);
  if (!g) return "";
  return ` style="background:linear-gradient(90deg,${g[0]},${g[1]});-webkit-background-clip:text;background-clip:text;color:transparent;"`;
}

// Wave 7 (I.19): эмодзи-бейдж после имени, label — в tooltip.
function badgeHtml(emoji?: string, label?: string): string {
  if (!emoji) return "";
  return `<span class="profile-badge"${label ? ` data-tooltip="${escapeHtml(label)}"` : ""}>${escapeHtml(emoji)}</span>`;
}

// Возвращает inline-style для имени участника: градиент профиля (I.18,
// высший приоритет — это личная кастомизация), иначе role-цвет
// (union-резолвер по всем ролям юзера, см. getUserColor / Wave 5).
// Иначе пустая строка — наследует дефолтный --text.
function authorColorStyle(userId: string): string {
  const m = state.members.find((x) => x.userId === userId);
  if (!m) return "";
  const grad = nameGradientStyle(m.nameGradient);
  if (grad) return grad;
  // I.5: цвета ролей можно выключить в Settings → Внешний вид.
  if (!getAppearance().roleColors) return "";
  const color = getUserColor(userId, m.role);
  return color ? ` style="color:${color};"` : "";
}

// Бейдж участника по userId (для чата/сайдбара).
function authorBadge(userId: string): string {
  const m = state.members.find((x) => x.userId === userId);
  return m ? badgeHtml(m.badgeEmoji, m.badgeLabel) : "";
}

function describePeer(userId: string | null): string {
  if (!userId) return "—";
  // Сам пользователь — в DM author всегда либо я, либо peer; без
  // этой ветки своё имя в DM показывалось бы как uuid (state.members
  // workspace-scoped и в DM-режиме может быть пустым).
  if (state.me && userId === state.me.id) {
    return state.me.displayName || state.me.username || userId.slice(0, 8);
  }
  const member = state.members.find((m) => m.userId === userId);
  if (member) return member.displayName || member.username;
  // DM-peer'ы лежат в state.dms — отдельный источник от workspace-членов.
  const dm = state.dms.find((d) => d.peer.userId === userId);
  if (dm) return dm.peer.displayName || dm.peer.username;
  // Wave 3: друзья — третий источник (friend-экран вне workspace-контекста).
  const fr = state.friends.find((f) => f.userId === userId);
  if (fr) return fr.displayName || fr.username;
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

// J.5: рендер sidebar'а каналов. Каналы группируются по `categoryId`;
// orphans (NULL category_id) идут в специальном блоке «Без категории» сверху,
// если они есть. Заголовок ws-уровневой «+» создаёт новую категорию.
function renderChannelsBlock(): string {
  const ws = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  const canManage = !!ws && ["owner", "admin"].includes(ws.role ?? "");
  const categories = [...state.categories].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  const channelsByCat = new Map<string | null, Channel[]>();
  // Wave 8: архивные каналы не участвуют в категориях — копятся в отдельный
  // сворачиваемый блок внизу sidebar'а.
  const archived: Channel[] = [];
  for (const ch of state.channels) {
    // Wave 9: треды (посты форума) в sidebar не показываются — до них
    // добираются через форум-вью родительского канала.
    if (ch.kind === "thread") continue;
    if (ch.archivedAt) {
      archived.push(ch);
      continue;
    }
    const key = ch.categoryId ?? null;
    const list = channelsByCat.get(key) ?? [];
    list.push(ch);
    channelsByCat.set(key, list);
  }
  for (const list of channelsByCat.values()) {
    list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }
  const orphanChannels = channelsByCat.get(null) ?? [];
  const orphanBlock = orphanChannels.length > 0
    ? renderChannelCategory(null, "Без категории", orphanChannels, canManage)
    : "";
  const catBlocks = categories
    .map((cat) => renderChannelCategory(cat, cat.name, channelsByCat.get(cat.id) ?? [], canManage))
    .join("");
  // J.5: «+ Категория» и «+ Канал»-orphan переехали в workspace-dropdown
  // под заголовком ch-panel — sidebar остаётся чистым.
  return `
    ${orphanBlock}
    ${catBlocks}
    ${renderArchivedBlock(archived, canManage)}
  `;
}

// Wave 8: блок «Архив» — отдельная секция в самом низу. По умолчанию
// свёрнута (persist в localStorage); свёрнутая показывает только активный
// канал, как и обычные категории (J.6).
const ARCHIVE_COLLAPSED_KEY = "rucord:archive-collapsed";

function isArchiveCollapsed(): boolean {
  try {
    return localStorage.getItem(ARCHIVE_COLLAPSED_KEY) !== "0";
  } catch {
    return true;
  }
}

function renderArchivedBlock(archived: Channel[], canManage: boolean): string {
  if (archived.length === 0) return "";
  archived.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const collapsed = isArchiveCollapsed();
  const visible = collapsed ? archived.filter((c) => c.id === state.selectedChannelId) : archived;
  const items = visible
    .map((ch) => {
      const cls = ch.id === state.selectedChannelId ? "active" : "";
      const actions = canManage
        ? `<span class="channel-item-actions">
             <button class="ghost channel-item-settings" data-ch-settings="${ch.id}" data-tooltip="Настройки канала" aria-label="Настройки канала">${icon("settings")}</button>
           </span>`
        : "";
      return `
        <li class="${cls} archived" data-ch="${ch.id}">
          <span class="channel-prefix">${channelPrefix(ch)}</span>
          <span class="channel-name"${ch.nameColor ? ` style="color:${escapeHtml(ch.nameColor)}"` : ""}>${escapeHtml(ch.name)}</span>
          ${actions}
        </li>
      `;
    })
    .join("");
  return `
    <div class="section-title ch-category-title ${collapsed ? "collapsed" : ""}">
      <button class="ch-category-toggle" data-archive-collapse>
        <span class="ch-category-label">${t("sidebar.archive")} · ${archived.length}</span>
        <span class="ch-category-glyph">${collapsed ? "▸" : "▾"}</span>
      </button>
    </div>
    <ul class="channel-list channel-list-archived">${items}</ul>
  `;
}

function renderChannelCategory(
  category: ChannelCategory | null,
  title: string,
  channels: Channel[],
  canManage: boolean
): string {
  // J.6: свёрнутая категория показывает только заголовок + активный канал
  // (чтобы юзера не выкинуло из контекста).
  const catId = category?.id ?? null;
  const isCollapsed = catId !== null && state.collapsedCategories.has(catId);
  const visibleChannels = isCollapsed
    ? channels.filter((c) => c.id === state.selectedChannelId)
    : channels;
  // Для orphan-блока «+ канал» создаёт без категории; для категории — внутри неё.
  const createDataAttr = category ? `data-create-in-category="${escapeHtml(category.id)}"` : `data-create-orphan="1"`;
  const addBtn = canManage
    ? `<button class="ghost ch-category-add" ${createDataAttr} data-tooltip="Создать канал" aria-label="Создать канал">${icon("plus")}</button>`
    : "";
  // ⚙ для управления самой категорией (rename/delete) — только для реальных
  // (не orphan) категорий и canManage.
  const settingsBtn = canManage && category
    ? `<button class="ghost ch-category-settings" data-category-id="${escapeHtml(category.id)}" data-tooltip="Управление категорией" aria-label="Управление категорией">${icon("settings")}</button>`
    : "";
  const collapseAttr = category ? `data-category-collapse="${escapeHtml(category.id)}"` : "";
  const collapseGlyph = category ? (isCollapsed ? "▸" : "▾") : "";
  const items = visibleChannels
    .map((ch) => {
      const unread = state.unread[ch.id] ?? 0;
      const muted = isChannelMuted(ch.id);
      const cls = [
        ch.id === state.selectedChannelId ? "active" : "",
        unread > 0 ? "has-unread" : "",
        muted ? "muted" : ""
      ]
        .filter(Boolean)
        .join(" ");
      const badge = unread > 0 ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>` : "";
      const inlineList = ch.kind === "voice" ? renderVoiceInlineParticipants(ch.id) : "";
      const actions = canManage
        ? `<span class="channel-item-actions">
             <button class="ghost channel-item-settings" data-ch-settings="${ch.id}" data-tooltip="Настройки канала" aria-label="Настройки канала">${icon("settings")}</button>
           </span>`
        : "";
      return `
        <li class="${cls}" data-ch="${ch.id}" data-cat-id="${escapeHtml(catId ?? "")}"${canManage ? ' draggable="true"' : ""}>
          <span class="channel-prefix">${channelPrefix(ch)}</span>
          <span class="channel-name"${ch.nameColor ? ` style="color:${escapeHtml(ch.nameColor)}"` : ""}>${escapeHtml(ch.name)}</span>
          ${badge}
          ${actions}
        </li>
        ${inlineList}
      `;
    })
    .join("");
  // Заголовок: для категорий — кликабельный (toggle collapse), для orphan — статичный.
  // Glyph справа от названия (Discord-pattern), label прижат к левому краю и
  // обрезается ellipsis'ом если не влезает в одну строку.
  const titleEl = category
    ? `<button class="ch-category-toggle" ${collapseAttr}>
         <span class="ch-category-label">${escapeHtml(title)}</span>
         <span class="ch-category-glyph">${collapseGlyph}</span>
       </button>`
    : `<span class="ch-category-label">${escapeHtml(title)}</span>`;
  // J.5(a): категория drag-reorder. Только реальные категории (не orphan).
  const dragAttrs = category && canManage
    ? ` draggable="true" data-cat-drag="${escapeHtml(category.id)}"`
    : "";
  return `
    <div class="section-title ch-category-title ${isCollapsed ? "collapsed" : ""}"${dragAttrs}>
      ${titleEl}
      <span class="ch-category-actions">
        ${addBtn}
        ${settingsBtn}
      </span>
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
  } else if (state.voicePeekAll[channelId]?.length) {
    participants = state.voicePeekAll[channelId];
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
          ${live ? `<span class="voice-inline-live">${t("voice.live")}</span>` : ""}
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
      const muted = isChannelMuted(d.channelId) ? " muted" : "";
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
          <button class="ghost dm-item-close" data-dm-close="${escapeHtml(d.channelId)}" data-tooltip="Скрыть из списка" aria-label="Скрыть">${icon("x", { size: 14 })}</button>
        </li>
      `;
    })
    .join("");
  return `
    <div class="section-title dm-list-title">
      <span>Прямые сообщения</span>
      <button id="dm-find-btn" class="ghost ch-category-add" data-tooltip="Найти или начать беседу" aria-label="Найти">${icon("plus")}</button>
    </div>
    ${state.dms.length === 0
      ? `<div class="ch-panel-empty">Пока нет личных бесед. Нажми <strong>+</strong> или открой DM из профиля участника.</div>`
      : `<ul class="dm-list">${items}</ul>`}
  `;
}

// G.8: home-экран DM (когда в dm-mode, но никакой DM не выбран).
// Поле поиска по username + список DM в виде крупных карточек.
// Wave 3: секция «Друзья» в DM-home. Табы Все/В сети/Ожидание/Заблокированные,
// форма добавления по username, действия per-row.
function renderFriendsSection(): string {
  const tab = state.friendsTab;
  const accepted = state.friends.filter((f) => f.status === "accepted");
  const pending = state.friends.filter((f) => f.status === "pending_in" || f.status === "pending_out");
  const pendingIn = state.friends.filter((f) => f.status === "pending_in");
  const blocked = state.friends.filter((f) => f.status === "blocked");
  const list =
    tab === "all" ? accepted :
    tab === "online" ? accepted.filter((f) => f.online) :
    tab === "pending" ? pending : blocked;

  const tabBtn = (id: FriendsTab, label: string, count?: number) => `
    <button class="friends-tab${tab === id ? " active" : ""}" data-friends-tab="${id}">
      ${label}${count ? ` <span class="friends-tab-badge">${count}</span>` : ""}
    </button>`;

  const rows = list.length === 0
    ? `<div class="friends-empty">${
        tab === "pending" ? t("friends.empty.pending") :
        tab === "blocked" ? t("friends.empty.blocked") :
        tab === "online" ? t("friends.empty.online") :
        t("friends.empty.all")}</div>`
    : `<ul class="friends-list">${list.map((f) => {
        const name = f.displayName || f.username;
        const effMode = f.presenceMode ?? (f.online ? "online" : "offline");
        const sub =
          f.status === "pending_in" ? t("friends.sub.pending_in") :
          f.status === "pending_out" ? t("friends.sub.pending_out") :
          f.status === "blocked" ? t("friends.sub.blocked") :
          f.customStatus || "@" + f.username;
        const actions =
          f.status === "pending_in"
            ? `<button class="friends-act ok" data-friend-accept="${f.userId}" data-tooltip="${t("friends.accept")}">✓</button>
               <button class="friends-act danger" data-friend-remove="${f.userId}" data-tooltip="${t("friends.decline")}">✕</button>`
            : f.status === "pending_out"
              ? `<button class="friends-act danger" data-friend-remove="${f.userId}" data-tooltip="${t("friends.cancel_request")}">✕</button>`
              : f.status === "blocked"
                ? `<button class="friends-act" data-friend-unblock="${f.userId}">${t("friends.unblock")}</button>`
                : `<button class="friends-act" data-friend-msg="${f.userId}" data-tooltip="${t("friends.message")}">${icon("reply", { size: 16 })}</button>
                   <button class="friends-act danger" data-friend-remove-confirm="${f.userId}" data-tooltip="${t("friends.remove")}">✕</button>`;
        return `
          <li class="friends-row" data-friend-profile="${f.userId}">
            <span class="dm-home-avatar">
              ${renderAvatar({ avatarMediaId: f.avatarMediaId, fallbackText: name, sizePx: 36 })}
              ${f.status === "blocked" ? "" : `<span class="presence-dot ${presenceDotClass(effMode)}"></span>`}
            </span>
            <span class="friends-row-body">
              <span class="friends-row-name">${escapeHtml(name)}</span>
              <span class="friends-row-sub">${escapeHtml(sub)}</span>
            </span>
            <span class="friends-row-actions">${actions}</span>
          </li>`;
      }).join("")}</ul>`;

  return `
    <section class="friends-section">
      <form id="friend-add-form" class="dm-home-find">
        <input id="friend-add-input" name="username" placeholder="${t("friends.add_placeholder")}" autocomplete="off" maxlength="64" />
        <button type="submit">${t("friends.send_request")}</button>
      </form>
      ${state.friendAddError ? `<div class="dm-home-error">${escapeHtml(state.friendAddError)}</div>` : ""}
      ${state.friendAddOk ? `<div class="friends-ok">${escapeHtml(state.friendAddOk)}</div>` : ""}
      <div class="friends-tabs">
        ${tabBtn("all", t("friends.tab.all"))}
        ${tabBtn("online", t("members.online"))}
        ${tabBtn("pending", t("friends.tab.pending"), pendingIn.length)}
        ${tabBtn("blocked", t("friends.tab.blocked"))}
      </div>
      ${state.friendsLoading && state.friends.length === 0 ? `<div class="friends-empty">${t("common.loading")}</div>` : rows}
    </section>
  `;
}

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
    ? `<div class="dm-home-empty">${t("dm.home.empty")}</div>`
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
        <h2>${t("dm.home.title")}</h2>
        <form id="dm-find-form" class="dm-home-find">
          <input id="dm-find-input"
                 name="query"
                 placeholder="${t("dm.home.find_placeholder")}"
                 autocomplete="off"
                 maxlength="64"
                 value="${escapeHtml(state.dmFindQuery)}" />
          <button type="submit" ${state.dmOpening ? "disabled" : ""}>${state.dmOpening ? "…" : t("dm.home.open")}</button>
        </form>
        ${errBlock}
      </header>
      ${renderFriendsSection()}
      <h3 class="dm-home-subtitle">${t("dm.home.conversations")}</h3>
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
      <div class="channel-header-actions">
        <button id="dm-call" class="ghost" data-user-id="${escapeHtml(dm.peer.userId)}" data-tooltip="${t("menu.call")}" aria-label="${t("menu.call")}">${icon("phone")}</button>
        <button id="open-pins" class="ghost${state.pinsPopupOpen ? " active" : ""}" data-tooltip="${t("header.pins")}" aria-label="${t("header.pins")}">${icon("pin")}</button>
      </div>
      ${state.pinsPopupOpen && state.channelPinsChannelId === dm.channelId ? renderPinsPopup() : ""}
    </header>
    <div id="drop-zone" class="drop-zone" hidden>
      <div class="drop-zone-inner">${t("chat.dropzone")}</div>
    </div>
    <div id="sticky-date" class="sticky-date" hidden></div>
    <div id="message-list" class="message-list">
      ${renderMessagesWithDivider()}
    </div>
    ${renderJumpToUnread()}
    ${state.pendingUploads.length > 0 ? renderPendingUploads() : ""}
    ${renderReplyBar()}
    <div id="mention-popup" class="mention-popup" hidden></div>
    <div id="slash-popup" class="mention-popup" hidden></div>
    <div id="typing-line" class="typing-line"></div>
    <form id="send-form" class="send-form">
      <label class="attach-btn" data-tooltip="${t("chat.composer.attach", { max: MAX_ATTACHMENTS })}">
        ${icon("paperclip")}
        <input type="file" id="attach-input" multiple hidden />
      </label>
      <input
        name="body"
        autocomplete="off"
        placeholder="${t("dm.composer.message_for", { name: escapeHtml(name) })}"
        value="${escapeHtml(loadDraft(dm.channelId))}"
      />
      <button type="button" id="composer-emoji" class="composer-emoji-btn" data-tooltip="${t("chat.composer.emoji")}">${icon("smile")}</button>
      <button type="submit">${state.uploadInFlight ? "…" : "↑"}</button>
    </form>
  `;
}

// K.7: единый стиль иконок каналов. Возвращает безопасный HTML с SVG —
// `currentColor`, контролируется через `.channel-prefix` в CSS. Приватный
// канал перебивает kind — поверх base-иконки (text/voice) накладываем
// маленький lock-overlay, чтобы юзер видел и тип канала, и его приватность
// (раньше lock полностью замещал kind — путало). DM-каналы рендерятся
// отдельным компонентом, channelPrefix к ним не применяется.
function channelPrefix(ch: Channel): string {
  const base = ch.kind === "voice"
    ? icon("channel-voice", { size: 16, className: "channel-icon" })
    : ch.kind === "forum"
      ? icon("channel-forum", { size: 16, className: "channel-icon" })
      : icon("channel-text", { size: 16, className: "channel-icon" });
  if (!ch.isPrivate) return base;
  // Lock-overlay 10x10 поверх правого нижнего угла base-иконки.
  return `<span class="channel-icon-stack">${base}<span class="channel-icon-lock">${icon("lock", { size: 10 })}</span></span>`;
}

function renderBellButton(): string {
  const count = state.notificationsUnread;
  const badge = count > 0
    ? `<span class="bell-badge">${count > 99 ? "99+" : count}</span>`
    : "";
  return `<button id="open-notifications" class="ghost bell-btn" data-tooltip="${t("modal.notifications")}" aria-label="${t("modal.notifications")}">${icon("bell")}${badge}</button>`;
}

// J.5: dropdown под ch-panel-header'ом. Discord-style меню для управления
// воркспейсом — Пригласить (открывает invites-модалку), Настройки сервера,
// Создать канал, Создать категорию. Все эти действия раньше лежали
// раздельно в sidebar; теперь сгруппированы по верхнему правому глифу.
async function createCategoryFlow(wsId: string): Promise<void> {
  const raw = await promptDialog({
    title: "Новая категория",
    label: "Название",
    placeholder: "Игры, Музыка, ..."
  });
  const name = raw?.trim();
  if (!name) return;
  try {
    const cat = await httpClient.post<ChannelCategory>(`/api/v1/workspaces/${wsId}/categories`, { name });
    state.categories = [...state.categories, cat];
    render();
  } catch (err) {
    state.status = describeError(err);
    render();
  }
}

function renderWorkspaceHeaderMenu(ws: Workspace, canManage: boolean): string {
  const isOwnerOrAdmin = ["owner", "admin"].includes(ws.role ?? "");
  return `
    <div class="ws-menu" role="menu">
      ${canManage ? `<button class="ws-menu-item" data-ws-menu="invite">${icon("plus", { size: 14 })}<span>Пригласить</span></button>` : ""}
      ${isOwnerOrAdmin ? `<button class="ws-menu-item" data-ws-menu="settings">${icon("settings", { size: 14 })}<span>Настройки сервера</span></button>` : ""}
      ${canManage ? `<button class="ws-menu-item" data-ws-menu="create-channel">${icon("channel-text", { size: 14 })}<span>Создать канал</span></button>` : ""}
      ${canManage ? `<button class="ws-menu-item" data-ws-menu="create-category">${icon("plus", { size: 14 })}<span>Создать категорию</span></button>` : ""}
    </div>
  `;
}

function renderInvitesModal(): string {
  const ws = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  const list = state.invitesLoading
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
              <button class="ghost invite-copy" data-code="${escapeHtml(i.code)}" data-tooltip="Копировать код">⧉</button>
              <button class="ghost invite-revoke" data-invite="${i.id}" data-tooltip="Отозвать">✕</button>
            </li>
          `
            )
            .join("")}
        </ul>`;
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal" role="dialog">
        <div class="modal-header">
          <h3>${t("modal.invites")} · ${escapeHtml(ws?.name ?? "")}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="modal-body">
          <form id="create-invite" class="inline-form">
            <input name="maxUses" type="number" min="0" max="10000" placeholder="макс. использований (0 = ∞)" />
            <button type="submit" class="primary">Создать инвайт</button>
          </form>
          ${list}
        </div>
      </div>
    </div>
  `;
}

// J.3: per-channel NSFW-ack. Ключ хранится только локально — на новом
// клиенте/девайсе юзер увидит overlay снова, это «фичерное» поведение
// (Discord так же). Не реализуем server-side ack — он бы только нагружал API.
function nsfwAckKey(channelId: string): string {
  return `rucord:nsfw-ack:${channelId}`;
}
function hasNsfwAck(channelId: string): boolean {
  try {
    return localStorage.getItem(nsfwAckKey(channelId)) === "1";
  } catch {
    return false;
  }
}
function setNsfwAck(channelId: string): void {
  try {
    localStorage.setItem(nsfwAckKey(channelId), "1");
  } catch {
    /* quota / disabled */
  }
}

// Wave 9: форум-вью — карточки постов (title, автор, превью, счётчик,
// последняя активность), сортировка по активности приходит с сервера.
// Клик по карточке открывает тред обычным selectChannel().
function renderForumView(channel: Channel): string {
  const isArchived = !!channel.archivedAt;
  const cards = state.forumPosts
    .map((p) => {
      const authorName = p.authorDisplayName || p.authorUsername || "";
      const avatar = renderAvatar({
        avatarMediaId: p.authorAvatarId || undefined,
        fallbackText: authorName || p.title,
        sizePx: 28
      });
      const count = p.messageCount > 99 ? "99+" : String(p.messageCount);
      return `
        <div class="forum-post-card" data-ch-open="${p.id}">
          <div class="forum-post-title">${escapeHtml(p.title)}</div>
          ${p.preview ? `<div class="forum-post-preview">${escapeHtml(p.preview)}</div>` : ""}
          <div class="forum-post-meta">
            ${avatar}
            ${authorName ? `<span class="forum-post-author">${escapeHtml(authorName)}</span>` : ""}
            <span class="forum-post-count">${icon("reply", { size: 13 })} ${count}</span>
            <span class="forum-post-activity">${escapeHtml(formatTimeSmart(p.lastActivityAt))}</span>
          </div>
        </div>
      `;
    })
    .join("");
  // Плейсхолдер только когда карточек нет: refresh с keepCurrent оставляет
  // старые карточки на месте до прихода свежего списка.
  const emptyBlock = state.forumPosts.length > 0
    ? ""
    : state.forumPostsLoading
      ? `<div class="forum-empty">${t("forum.loading")}</div>`
      : `<div class="forum-empty">
           <div class="forum-empty-title">${t("forum.empty.title")}</div>
           <div class="forum-empty-sub">${t("forum.empty.sub")}</div>
         </div>`;
  return `
    <header class="channel-header">
      <div class="channel-header-title">
        <h2>${channelPrefix(channel)}<span class="channel-header-name">${escapeHtml(channel.name)}</span></h2>
        ${isArchived ? `<span class="channel-archived-badge">${t("chat.header.archived")}</span>` : ""}
        ${channel.topic ? `<span class="channel-header-sep">·</span><span class="channel-header-topic">${escapeHtml(channel.topic)}</span>` : ""}
      </div>
      <div class="channel-header-actions">
        ${isArchived ? "" : `<button id="forum-new-post" class="primary forum-new-post-btn">${icon("plus", { size: 14 })} ${t("forum.newPost")}</button>`}
      </div>
    </header>
    <div class="forum-post-list">
      ${cards}
      ${emptyBlock}
    </div>
  `;
}

function renderChannelView(channel: Channel): string {
  if (channel.kind === "voice") {
    return renderVoiceChannelView(channel);
  }
  // Wave 9: форум — список постов вместо message-стрима.
  if (channel.kind === "forum") {
    return renderForumView(channel);
  }
  // J.3: NSFW gate — показываем overlay до явного подтверждения.
  // DM-каналы исключаем (там нет per-channel настройки).
  if (channel.kind === "text" && channel.isNsfw && !hasNsfwAck(channel.id)) {
    return `
      <div class="nsfw-gate">
        <div class="nsfw-gate-card">
          <h2>Канал помечен 18+</h2>
          <p>
            Канал <strong>#${escapeHtml(channel.name)}</strong> может содержать материалы,
            подходящие только для взрослых. Если тебе ещё нет 18 или ты не хочешь видеть
            такой контент — закрой канал.
          </p>
          <div class="nsfw-gate-actions">
            <button id="nsfw-decline" class="ghost">Назад</button>
            <button id="nsfw-accept" class="primary" data-channel-id="${channel.id}">Мне исполнилось 18, продолжить</button>
          </div>
        </div>
      </div>
    `;
  }
  // Wave 8: архивный канал — read-only (бэк отдаст 403 на POST в любом случае).
  const isArchived = !!channel.archivedAt;
  // Wave 9: в тредах (постах форума) композер работает как в тексте.
  const canSend = (channel.kind === "text" || channel.kind === "thread") && !isArchived;
  const ws = state.workspaces.find((w) => w.id === channel.workspaceId);
  const canModerate = !!ws && ["owner", "admin", "moderator"].includes(ws.role ?? "");
  // Wave 9/10: breadcrumb для треда — стрелка назад к родителю (форум или
  // text-канал для тредов на сообщениях).
  const parentForum = channel.kind === "thread" && channel.parentChannelId
    ? state.channels.find((c) => c.id === channel.parentChannelId)
    : undefined;
  const backLabel = parentForum?.kind === "forum" ? t("forum.back") : t("thread.back");
  const breadcrumb = parentForum
    ? `<button class="ghost thread-back" data-ch-open="${parentForum.id}" data-tooltip="${backLabel}" aria-label="${backLabel}">${icon("reply", { size: 16 })}</button>
       <span class="thread-parent" data-ch-open="${parentForum.id}">${channelPrefix(parentForum)} ${escapeHtml(parentForum.name)}</span>
       <span class="channel-header-sep">›</span>`
    : "";
  // J.1 + J.4: тема канала переехала на ту же строку, что и имя
  // (`# название · тема` с разделителем-точкой); ⚙ настроек канала
  // из header удалён — теперь на самом канале в sidebar при hover (J.2).
  // Порядок action-кнопок: 🔍 поиск → 📜 журнал → 👥 участники (rightmost).
  return `
    <header class="channel-header">
      <div class="channel-header-title">
        ${breadcrumb}
        <h2>${channelPrefix(channel)}<span class="channel-header-name">${escapeHtml(channel.name)}</span></h2>
        ${isArchived ? `<span class="channel-archived-badge">${t("chat.header.archived")}</span>` : ""}
        ${channel.topic ? `<span class="channel-header-sep">·</span><span class="channel-header-topic">${escapeHtml(channel.topic)}</span>` : ""}
      </div>
      <div class="channel-header-actions">
        <button id="open-pins" class="ghost${state.pinsPopupOpen ? " active" : ""}" data-tooltip="${t("header.pins")}" aria-label="${t("header.pins")}">${icon("pin")}</button>
        <button id="open-search" class="ghost" data-tooltip="${t("header.search")}" aria-label="${t("modal.search")}">${icon("search")}</button>
        ${canModerate ? `<button id="open-audit" class="ghost" data-tooltip="${t("header.audit")}" aria-label="${t("header.audit")}">${icon("scroll")}</button>` : ""}
        <button id="toggle-member-sidebar" class="ghost" data-tooltip="${state.memberSidebarOpen ? t("header.members.hide") : t("header.members.show")}" aria-label="${t("modal.members")}">${icon("users")}</button>
      </div>
      ${state.pinsPopupOpen && state.channelPinsChannelId === channel.id ? renderPinsPopup() : ""}
    </header>
    ${canSend ? `<div id="drop-zone" class="drop-zone" hidden>
      <div class="drop-zone-inner">${t("chat.dropzone")}</div>
    </div>` : ""}
    <div id="sticky-date" class="sticky-date" hidden></div>
    <div id="message-list" class="message-list">
      ${renderMessagesWithDivider()}
    </div>
    ${renderJumpToUnread()}
    ${state.pendingUploads.length > 0 ? renderPendingUploads() : ""}
    ${renderReplyBar()}
    <div id="mention-popup" class="mention-popup" hidden></div>
    <div id="channel-popup" class="mention-popup" hidden></div>
    <div id="slash-popup" class="mention-popup" hidden></div>
    <div id="typing-line" class="typing-line"></div>
    <form id="send-form" class="send-form">
      <label class="attach-btn ${canSend ? "" : "disabled"}" data-tooltip="${t("chat.composer.attach", { max: MAX_ATTACHMENTS })}">
        ${icon("paperclip")}
        <input type="file" id="attach-input" multiple hidden ${canSend ? "" : "disabled"} />
      </label>
      <input
        name="body"
        autocomplete="off"
        placeholder="${canSend
          ? (slowModeRemainingSec(channel.id) > 0
              ? t("chat.composer.slowmode", { sec: slowModeRemainingSec(channel.id) })
              : t("chat.composer.message_in", { name: channel.name }))
          : (isArchived ? t("chat.composer.archived") : t("chat.composer.readonly"))}"
        ${canSend ? "" : "disabled"}
        value="${escapeHtml(canSend ? loadDraft(channel.id) : "")}"
      />
      <button type="button" id="composer-emoji" class="composer-emoji-btn" data-tooltip="${t("chat.composer.emoji")}" ${canSend ? "" : "disabled"}>${icon("smile")}</button>
      <button type="submit" ${canSend && slowModeRemainingSec(channel.id) === 0 ? "" : "disabled"}>${state.uploadInFlight ? "…" : "↑"}</button>
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
  return `<select class="screen-quality-select ghost" aria-label="${t("voice.quality")}">${opts}</select>`;
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
    // Без видео <video> — чёрный прямоугольник; рисуем Discord-like заглушку
    // с аватаром. Speaking-кольцо вешает CSS по .voice-tile.speaking
    // (speakingLoop). Аватар берём из members: VoiceParticipant несёт только
    // имя, avatarMediaId у него нет.
    const hasVideo = isSelf ? cameraOn || screenOn : !!p.cameraOn || !!p.screenSharing;
    const member = state.members.find((m) => m.userId === p.userId);
    const avatarMediaId = p.userId === state.me?.id ? state.me?.avatarMediaId : member?.avatarMediaId;
    const cls = `voice-tile${isSelf ? " self" : ""}${sharing ? " sharing" : ""}${hasVideo ? " has-video" : ""}${extraClass ? " " + extraClass : ""}`;
    return `<div class="${cls}">
      <video class="voice-tile-video" ${tag} autoplay playsinline ${isSelf ? "muted" : ""}></video>
      <div class="voice-tile-placeholder">
        ${renderAvatar({
          avatarMediaId,
          fallbackText: name,
          sizePx: 72,
          decoration: member?.avatarDecoration
        })}
      </div>
      <div class="voice-tile-overlay">
        <span class="voice-dot"></span>
        <span class="voice-name">${escapeHtml(name)}${isSelf ? ` ${t("voice.you")}` : ""}</span>
        ${sharing ? `<span class="voice-tile-live">${t("voice.live")}</span>` : ""}
      </div>
    </div>`;
  };

  const sharer = participants.find((p) => {
    const isSelf = selfSessionId !== null && p.sessionId === selfSessionId;
    return isSelf ? screenOn : !!p.screenSharing;
  });

  // K.4: пустой voice-канал — Discord-style hero-view с большим именем
  // канала, подзаголовком и primary-кнопкой по центру. Когда есть
  // участники (joined или просто peek с активными) — обычный voice-tiles
  // layout.
  // Wave 8: архивный voice — join спрятан (бэк в любом случае вернёт 403).
  const isArchived = !!channel.archivedAt;
  const header = `
    <header class="channel-header">
      <div class="channel-header-title">
        <h2>${channelPrefix(channel)}<span class="channel-header-name">${escapeHtml(channel.name)}</span></h2>
        ${isArchived ? `<span class="channel-archived-badge">${t("chat.header.archived")}</span>` : ""}
        ${channel.topic ? `<span class="channel-header-sep">·</span><span class="channel-header-topic">${escapeHtml(channel.topic)}</span>` : ""}
      </div>
    </header>
  `;

  if (participants.length === 0 && !joined) {
    const subtitle = isArchived
      ? t("chat.composer.archived")
      : busyOther
        ? t("voice.busy")
        : t("voice.hero.none");
    return `
      ${header}
      <div class="voice-hero">
        <div class="voice-hero-card">
          <h1 class="voice-hero-title">${escapeHtml(channel.name)}</h1>
          <div class="voice-hero-subtitle">${escapeHtml(subtitle)}</div>
          ${isArchived ? "" : `<button id="voice-join" class="voice-hero-cta primary" data-channel-id="${channel.id}" ${joining || busyOther ? "disabled" : ""}>
            ${icon("phone-outgoing", { size: 16 })}
            <span>${joining ? t("voice.joining") : t("voice.hero.join")}</span>
          </button>`}
          ${error ? `<div class="voice-hero-error">${escapeHtml(error)}</div>` : ""}
        </div>
      </div>
    `;
  }

  const tiles = sharer
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
      ${callIconButton("voice-mute", muted ? "mic-off" : "mic", muted ? t("voice.unmute") : t("voice.mute"), muted ? "danger" : "")}
      ${callIconButton("voice-deafen", isDeafened() ? "headphones-off" : "headphones", isDeafened() ? t("voice.undeafen") : t("voice.deafen"), isDeafened() ? "danger" : "")}
      ${callIconButton("voice-camera", cameraOn ? "camera-off" : "camera", cameraOn ? t("voice.cam.off") : t("voice.cam.on"), "", screenOn)}
      ${callIconButton("voice-screen", screenOn ? "screen-off" : "screen", screenOn ? t("voice.screen.stop") : t("voice.screen.start"), screenOn ? "active" : "")}
      ${renderScreenQualitySelect()}
      <span class="voice-actions-sep"></span>
      ${callIconButton("voice-leave", "log-out", leaving ? t("voice.leaving") : t("voice.leave"), "hangup", leaving)}
    `
    : `
      <button id="voice-join" class="primary" data-channel-id="${channel.id}" ${joining || busyOther ? "disabled" : ""}>
        ${icon("phone-outgoing", { size: 16 })} ${joining ? t("voice.joining") : t("voice.join")}
      </button>
      ${busyOther ? `<div class="muted">${t("voice.busy")}</div>` : ""}
    `;

  return `
    ${header}
    <div class="voice-room">
      <div class="voice-room-body">
        <h3>${t("voice.now")}</h3>
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
        <span>${escapeHtml(name)}${isSelf ? ` ${t("voice.you")}` : ""}</span>
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
        ${callIconButton("voice-mute", muted ? "mic-off" : "mic", muted ? t("voice.unmute") : t("voice.mute"), muted ? "danger" : "")}
        ${callIconButton("voice-deafen", isDeafened() ? "headphones-off" : "headphones", isDeafened() ? t("voice.undeafen") : t("voice.deafen"), isDeafened() ? "danger" : "")}
        ${callIconButton("voice-camera", cameraOn ? "camera-off" : "camera", cameraOn ? t("voice.cam.off") : t("voice.cam.on"), "", screenOn)}
        ${callIconButton("voice-screen", screenOn ? "screen-off" : "screen", screenOn ? t("voice.screen.stop") : t("voice.screen.start"), screenOn ? "active" : "")}
        ${callIconButton("voice-leave", "log-out", leaving ? t("voice.leaving") : t("voice.leave"), "hangup", leaving)}
      </div>
    </div>
  `;
}

// После render() цепляем MediaStream'ы в <video data-voice-*> /
// <video data-call-*> элементы. Через innerHTML srcObject не
// сериализуется — нужно ставить программно.
function attachVoiceVideoStreams(): void {
  const voiceLocal = voiceMgr.getLocalStream();
  // I.2: global output-volume и output-device применяются к каждому
  // <video> с remote-стримом. Per-peer volume (state.voiceVolumes)
  // умножается сверху — позволяет точечно приглушить шумного соседа.
  const globalOut = getOutputVolume();
  for (const el of rootEl.querySelectorAll<HTMLVideoElement>("video[data-voice-self]")) {
    if (el.srcObject !== voiceLocal) el.srcObject = voiceLocal;
  }
  for (const el of rootEl.querySelectorAll<HTMLVideoElement>("video[data-voice-peer]")) {
    const sid = el.dataset.voicePeer;
    if (!sid) continue;
    const stream = voiceMgr.getRemoteStream(sid);
    if (el.srcObject !== stream) el.srcObject = stream;
    el.volume = Math.min(1, (state.voiceVolumes[sid] ?? 1) * globalOut);
    void applyOutputDevice(el);
    // Подстраховка аватар-заглушки: сигналинг cameraOn (voice.state) может
    // отстать от реального видеотрека — верим живому стриму.
    if (stream?.getVideoTracks().some((t) => t.readyState === "live")) {
      el.closest(".voice-tile")?.classList.add("has-video");
    }
  }
  const callLocal = callMgr.getLocalStream();
  const callRemote = callMgr.getRemoteStream();
  for (const el of rootEl.querySelectorAll<HTMLVideoElement>("video[data-call-self]")) {
    if (el.srcObject !== callLocal) el.srcObject = callLocal;
  }
  for (const el of rootEl.querySelectorAll<HTMLVideoElement>("video[data-call-remote]")) {
    if (el.srcObject !== callRemote) el.srcObject = callRemote;
    el.volume = Math.min(1, (state.voiceVolumes["call-remote"] ?? 1) * globalOut);
    void applyOutputDevice(el);
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

  // AudioContext без user-gesture блокируется браузером ("autoplay
  // policy"). Создаём только когда реально есть стрим для анализа —
  // в этот момент юзер уже точно в звонке/voice-канале, т.е. был клик.
  if (targets.size === 0 && speakingNodes.size === 0) return;
  const ctx = ensureSpeakingContext();
  if (!ctx) return;
  // Если контекст в suspended — пробуем разбудить (после user-gesture
  // это разрешено, иначе тихо упадём в catch и попробуем позже).
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }

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
          <button class="ghost pending-remove" data-id="${a.id}" data-tooltip="Убрать">✕</button>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

// Wave 2: лайтбокс по клику на превью. Thumb уже в mediaBlobCache (его
// загрузил attach-image loop); оригинал тянем лениво через httpClient
// (media-endpoint требует Authorization) и кешируем в тот же LRU.
function openImageLightbox(slot: HTMLDivElement): void {
  const thumbKey = slot.dataset.mediaUrl;
  const fullUrl = slot.dataset.fullUrl;
  if (!fullUrl) return;
  openLightbox({
    thumbUrl: thumbKey ? mediaBlobCache.get(thumbKey) ?? null : null,
    filename: slot.dataset.filename || "image",
    loadFull: async () => {
      const cached = mediaBlobCache.get(fullUrl);
      if (cached) return cached;
      const blob = await httpClient.getBlob(fullUrl);
      const blobUrl = URL.createObjectURL(blob);
      mediaBlobCache.set(fullUrl, blobUrl);
      return blobUrl;
    }
  });
}

// Wave 2: OG-карточки под сообщением (Discord-style: accent-полоса слева,
// siteName/title/description + thumb справа). imageUrl хотлинкается с
// внешнего сайта (CSP null) — заголовок и так весь escape'ится.
function renderLinkPreviews(previews: LinkPreview[] | undefined): string {
  if (!previews || previews.length === 0) return "";
  const cards = previews
    .filter((p) => p.url && /^https?:\/\//i.test(p.url))
    .map((p) => {
      const img = p.imageUrl && /^https?:\/\//i.test(p.imageUrl)
        ? `<img class="link-preview-img" src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy" />`
        : "";
      return `
        <div class="link-preview">
          <div class="link-preview-text">
            ${p.siteName ? `<div class="link-preview-site">${escapeHtml(p.siteName)}</div>` : ""}
            ${p.title ? `<a class="link-preview-title" href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(p.title)}</a>` : ""}
            ${p.description ? `<div class="link-preview-desc">${escapeHtml(p.description)}</div>` : ""}
          </div>
          ${img}
        </div>
      `;
    })
    .join("");
  return cards ? `<div class="link-previews">${cards}</div>` : "";
}

function renderAttachment(a: Attachment): string {
  if (isImage(a.contentType)) {
    return `<div class="attach-image" data-media-url="${escapeHtml(a.url + "/thumb")}" data-full-url="${escapeHtml(a.url)}" data-filename="${escapeHtml(a.filename || "image")}">
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
  const color = member ? getUserColor(member.userId, member.role) : undefined;
  const authorStyle = color ? ` style="color:${color};"` : "";
  return `<div class="reply-snippet" data-jump-id="${escapeHtml(reply.messageId)}" data-tooltip="Перейти к исходному">
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
      <button class="ghost reply-cancel" data-tooltip="Отменить ответ">✕</button>
    </div>`;
  }
  const author = describePeer(r.authorId);
  return `<div class="reply-bar">
    <span class="reply-arrow">↩</span>
    <span>В ответ <b>${escapeHtml(author)}</b>: ${escapeHtml(r.body)}</span>
    <button class="ghost reply-cancel" data-tooltip="Отменить ответ">✕</button>
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
    // I.5: группировка подряд идущих сообщений выключаема в Settings →
    // Внешний вид. Когда выключено — каждое сообщение со своим header'ом.
    const grouped =
      getAppearance().groupMessages &&
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
  if (diff === 0) return t("date.today");
  if (diff === 1) return t("date.yesterday");
  return d.toLocaleDateString(intlLocale(), { day: "numeric", month: "long", year: "numeric" });
}

// MENTION_RE_GLOBAL — синхронен с backend mentionRe: `@<slug>`, slug по
// правилу `[a-z0-9_]{3,32}`. Префикс — начало строки или не-словарный
// символ, чтобы не матчить email'ы (`hi@user`).
const MENTION_RE_GLOBAL = /(^|[^A-Za-z0-9_])@([a-z0-9_]{3,32})/g;
// Wave 4: @everyone/@here — подсвечиваются только если бэк подтвердил
// (message.mentionEveryone), иначе остаются обычным текстом.
const EVERYONE_RE_GLOBAL = /(^|[^A-Za-z0-9_])@(everyone|here)\b/g;
// Wave 8: #channel-ссылки. Токен — непрерывное «слово» (имена с пробелами
// не линкуются — Discord-конвенция); матч против известных имён каналов
// текущего воркспейса, иначе остаётся обычным текстом.
const CHANNEL_RE_GLOBAL = /(^|[^\p{L}\p{N}_#])#([\p{L}\p{N}_-]{1,64})/gu;
// Wave 2: опциональный язык после ``` — только если за ним перевод строки
// (```код``` в одну строку без языка не должен съедать первое слово).
const FENCED_RE = /```(?:([A-Za-z0-9+#-]{1,20})\n)?([\s\S]*?)```/g;
// Backslash-escape markdown-маркеров: `\*`, `\_`, `\~`, `\|`, `\\`, "\`".
// Нужен в т.ч. для /shrug — «¯\_(ツ)_/¯» без escape превращал бы (ツ) в курсив.
const MD_ESCAPE_RE = /\\([\\*_~|`])/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const URL_RE = /\bhttps?:\/\/[^\s<>`]+/g;
const BOLD_RE = /\*\*([^*\n]+?)\*\*/g;
const ITALIC_RE = /(^|[^A-Za-z0-9_])_([^_\n]+?)_(?=[^A-Za-z0-9_]|$)/g;
// Asterisk-italic: одиночные `*` (после того как BOLD_RE уже съел `**…**`).
// Запрещаем пробел сразу после открывающей/перед закрывающей `*`, чтобы
// «2 * 3 = 6» не превращалось в курсив. Discord ведёт себя так же.
const ITALIC_STAR_RE = /\*(?!\s)([^*\n]+?)(?<!\s)\*/g;
// Strikethrough `~~текст~~` (Discord/GitHub-стиль).
const STRIKE_RE = /~~([^~\n]+?)~~/g;
const SPOILER_RE = /\|\|([^|\n]+?)\|\|/g;

// renderBody — C.3 markdown + C.2 mentions + autolinks. Безопасно:
// весь пользовательский текст проходит через escapeHtml, разметка
// добавляется через известный набор тегов; динамический href строится
// только из URL, прошедших URL_RE (http/https) и тоже escape'ится.
function renderBody(body: string, mentionEveryone?: string): string {
  const placeholders: string[] = [];
  const stash = (html: string): string => {
    const token = `${placeholders.length}`;
    placeholders.push(html);
    return token;
  };

  // 1) Fenced code blocks — самый высокий приоритет, чтобы внутри
  //    не интерпретировались **, _, бэктики и т.д. Wave 2: ```lang →
  //    подсветка через highlight.js (highlightCode сам эскейпит).
  let text = body.replace(FENCED_RE, (_, lang: string | undefined, raw: string) => {
    const stripped = raw.replace(/^\n/, "").replace(/\n$/, "");
    const { html, language } = highlightCode(stripped, lang ?? null);
    const langBadge = language ? `<span class="md-code-lang">${escapeHtml(language)}</span>` : "";
    return stash(`<pre class="md-code-block">${langBadge}<code class="hljs">${html}</code></pre>`);
  });

  // 2) Inline code.
  text = text.replace(INLINE_CODE_RE, (_, raw: string) =>
    stash(`<code class="md-code">${escapeHtml(raw)}</code>`)
  );

  // 2.5) Backslash-escape: `\*` и т.п. → литеральный символ, маркером
  //      не считается (стэшится до остальных markdown-проходов).
  text = text.replace(MD_ESCAPE_RE, (_, ch: string) => stash(escapeHtml(ch)));

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

  // 4.5) @everyone/@here — только если сервер подтвердил пинг (право было).
  if (mentionEveryone) {
    text = text.replace(EVERYONE_RE_GLOBAL, (_full: string, prefix: string, token: string) =>
      prefix + stash(`<span class="mention mention-everyone">@${token}</span>`)
    );
  }

  // 4.7) #channel-ссылки (Wave 8). Клик обрабатывается делегатом на
  // message-list (data-channel-link → selectChannel). Архивные каналы
  // линкуются тоже — это и есть «доступен по прямой ссылке».
  const knownChannels = new Map(state.channels.map((c) => [c.name.toLowerCase(), c]));
  text = text.replace(CHANNEL_RE_GLOBAL, (full: string, prefix: string, name: string) => {
    const ch = knownChannels.get(name.toLowerCase());
    if (!ch) return full;
    return prefix + stash(`<span class="channel-link" data-channel-link="${ch.id}">#${escapeHtml(name)}</span>`);
  });

  // 5) Эскейпим всё оставшееся. Плейсхолдеры (N) состоят
  //    только из управляющего символа и цифр — escapeHtml их не трогает.
  text = escapeHtml(text);

  // 6) Bold / italic поверх уже escape'нутого текста. `*` и `_` в
  //    escapeHtml не входят, поэтому регулярки видят их как есть.
  text = text.replace(BOLD_RE, "<strong>$1</strong>");
  text = text.replace(STRIKE_RE, "<del>$1</del>");
  text = text.replace(ITALIC_RE, "$1<em>$2</em>");
  // Asterisk-italic после bold (иначе `**x**` распался бы на `*` + `*x*`).
  text = text.replace(ITALIC_STAR_RE, "<em>$1</em>");
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
  // Wave 3: сообщения заблокированных свёрнуты (Discord-pattern). Клик
  // раскрывает конкретное сообщение до следующего полного relog'а.
  if (state.blockedIds.has(m.authorId) && !state.revealedBlocked.has(m.id)) {
    return `
      <div class="message message-blocked" data-reveal-blocked="${m.id}" data-tooltip="Нажми, чтобы показать">
        <span>Сообщение заблокированного пользователя</span>
        <button class="ghost">Показать</button>
      </div>
    `;
  }
  const isMine = state.me?.id === m.authorId;
  const selectedWorkspace = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  const canModerate = !!selectedWorkspace && ["owner", "admin", "moderator"].includes(selectedWorkspace.role ?? "");
  const canDelete = isMine || canModerate;
  // Pin/unpin: в DM может любой участник, в workspace-канале — только модератор+.
  const canPin = state.dmMode || canModerate;
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
  const authorTitle = authorCustomStatus ? ` data-tooltip="${escapeHtml(authorCustomStatus)}"` : "";
  const avatarHtml = renderAvatar({
    avatarMediaId: authorAvatarId,
    fallbackText: authorName,
    sizePx: 40,
    className: "message-avatar",
    decoration: m.authorId === state.me?.id ? state.me?.avatarDecoration : authorMember?.avatarDecoration
  });

  if (isEditing) {
    return `
      <div class="message" data-id="${m.id}">
        ${avatarHtml}
        <div class="message-content">
          <div class="message-meta">
            <span class="author"${authorColorStyle(m.authorId)}>${escapeHtml(authorName)}</span>${authorBadge(m.authorId)}
            <span class="timestamp" data-tooltip="${escapeHtml(formatTime(m.createdAt))}">${formatTimeSmart(m.createdAt)}</span>
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
    ? `<span class="message-avatar message-avatar-spacer" aria-hidden="true"><span class="grouped-timestamp" data-tooltip="${escapeHtml(formatTime(m.createdAt))}">${escapeHtml(formatTimeSmartShort(m.createdAt))}</span></span>`
    : avatarHtml;
  // Wave 10: тред из сообщения — только в text-каналах воркспейса (не DM,
  // не внутри треда/форума). Если тред уже есть — вход через чип, кнопку
  // не дублируем.
  const msgChannel = state.channels.find((c) => c.id === m.channelId);
  const canThread = !state.dmMode && msgChannel?.kind === "text" && !msgChannel.archivedAt && !m.thread;
  // Wave 6: общий тулбар для обоих вариантов meta — i18n в одном месте.
  const actionsHtml = `<span class="message-actions">
          <button class="ghost action-react" data-id="${m.id}" data-tooltip="${t("msg.react")}">${icon("smile")}</button>
          <button class="ghost action-reply" data-id="${m.id}" data-author="${escapeHtml(m.authorId)}" data-tooltip="${t("msg.reply")}">${icon("reply")}</button>
          ${canThread ? `<button class="ghost action-thread" data-id="${m.id}" data-tooltip="${t("msg.thread")}">${icon("channel-forum")}</button>` : ""}
          ${isMine ? `<button class="ghost action-edit" data-id="${m.id}" data-tooltip="${t("msg.edit")}">${icon("pencil")}</button>` : ""}
          ${canPin
            ? `<button class="ghost action-pin" data-id="${m.id}" data-pinned="${m.isPinned ? "1" : "0"}" data-tooltip="${m.isPinned ? t("msg.unpin") : t("msg.pin")}">${icon(m.isPinned ? "pin-off" : "pin")}</button>`
            : ""}
          ${canDelete ? `<button class="ghost action-delete" data-id="${m.id}" data-tooltip="${t("common.delete")}">${icon("trash")}</button>` : ""}
        </span>`;
  const metaBlock = grouped
    ? `<div class="message-meta message-meta-grouped">
        ${actionsHtml}
      </div>`
    : `<div class="message-meta">
        <span class="author"${authorColorStyle(m.authorId)}${authorTitle}>${escapeHtml(authorName)}</span>${authorBadge(m.authorId)}${isMine ? ` <span class="author-mine">${t("msg.you")}</span>` : ""}
        <span class="timestamp" data-tooltip="${escapeHtml(formatTime(m.createdAt))}">${formatTimeSmart(m.createdAt)}${m.editedAt ? t("msg.edited") : ""}</span>
        ${actionsHtml}
      </div>`;
  const pinnedCls = m.isPinned ? " message-pinned" : "";
  return `
    <div class="message${groupedCls}${pinnedCls}" data-id="${m.id}">
      ${avatarSlot}
      <div class="message-content">
      ${m.isPinned ? `<div class="message-pin-badge" data-tooltip="Закреплённое сообщение">${icon("pin", { size: 12 })}</div>` : ""}
      ${renderReplySnippet(m.replyTo)}
      ${metaBlock}
      ${m.body ? `<div class="message-body">${renderBody(m.body, m.mentionEveryone)}</div>` : ""}
      ${
        m.attachments && m.attachments.length > 0
          ? `<div class="attachments">${m.attachments.map((a) => renderAttachment(a)).join("")}</div>`
          : ""
      }
      ${renderLinkPreviews(m.linkPreviews)}
      ${
        reactions.length > 0
          ? `<div class="reaction-row">
              ${reactions
                .map(
                  ([emoji, agg]) => `
                <button class="reaction-chip${agg.mine ? " mine" : ""}" data-react-toggle="${m.id}" data-emoji="${escapeHtml(emoji)}" data-tooltip="${escapeHtml(reactionTooltip(emoji, agg))}">
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
              <button class="ghost picker-emoji picker-more" data-react-more="${m.id}" data-tooltip="Все эмодзи">➕</button>
            </div>`
          : ""
      }
      ${renderThreadChip(m.thread)}
      </div>
    </div>
  `;
}

// Wave 10: чип «Тред: N ответов» под сообщением. Клик открывает тред как
// обычный канал через generic [data-ch-open] обработчик.
function renderThreadChip(thread: MessageThreadInfo | null | undefined): string {
  if (!thread) return "";
  return `<button class="thread-chip" data-ch-open="${escapeHtml(thread.threadId)}" data-tooltip="${t("thread.open")}">
      ${icon("channel-forum", { size: 14 })}
      <span class="thread-chip-title">${escapeHtml(thread.title)}</span>
      <span class="thread-chip-count">${t("thread.replies", { n: thread.messageCount })}</span>
      ${thread.lastActivityAt ? `<span class="thread-chip-activity">${escapeHtml(formatTimeSmart(thread.lastActivityAt))}</span>` : ""}
    </button>`;
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
      <span class="message-system-time" data-tooltip="${escapeHtml(formatTime(m.createdAt))}">${formatTimeSmart(m.createdAt)}</span>
    </div>
  `;
}

function renderModal(): string {
  if (!state.modal) return "";
  if (state.modal === "settings") return renderSettingsModal();
  if (state.modal === "members") return renderMembersModal();
  if (state.modal === "audit") return renderAuditModal();
  if (state.modal === "search") return renderSearchModal();
  if (state.modal === "notifications") return renderNotificationsModal();
  if (state.modal === "admin") return renderAdminModal();
  if (state.modal === "channelSettings") return renderChannelSettingsModal();
  if (state.modal === "workspaceRoles") return renderWorkspaceRolesModal();
  if (state.modal === "welcomeChannel") return renderWelcomeChannelModal();
  if (state.modal === "createChannel") return renderCreateChannelModal();
  if (state.modal === "createForumPost") return renderCreateForumPostModal();
  if (state.modal === "workspaceSettings") return renderWorkspaceSettingsModal();
  if (state.modal === "userProfile") return renderUserProfilePopup();
  if (state.modal === "invites") return renderInvitesModal();
  if (state.modal === "categoryPermissions") return renderCategoryPermissionsModal();
  return "";
}

// Wave 5 (J.5b): модалка прав категории. Role-overrides, наследуются всеми
// каналами категории; канальные overrides их перекрывают.
function renderCategoryPermissionsModal(): string {
  const cp = state.categoryPerms;
  const cat = state.categories.find((c) => c.id === cp.categoryId);
  if (!cat) return "";
  const body = (() => {
    if (cp.loading) return `<div class="search-empty">Загрузка…</div>`;
    if (!cp.data) return `<div class="search-empty">${escapeHtml(cp.error ?? "Не удалось загрузить")}</div>`;
    return `
      <div class="perm-help">
        Правила применяются ко всем каналам категории. Канальные настройки
        прав имеют приоритет над категорийными. Owner не подчиняется overrides.
      </div>
      ${renderPermGrid(cp.data.actions, cp.data.roles.map((r) => ({ key: r, label: roleLabel(r) })), cp.draft, "cat-perm-select")}
      <div class="admin-actions">
        <button id="cat-perm-save" class="primary" ${cp.saving ? "disabled" : ""}>
          ${cp.saving ? "Сохраняю…" : "Сохранить"}
        </button>
        ${cp.error ? `<span class="roles-error">${escapeHtml(cp.error)}</span>` : ""}
      </div>
    `;
  })();
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide" role="dialog">
        <div class="modal-header">
          <h3>Права категории · ${escapeHtml(cat.name)}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="modal-body">${body}</div>
      </div>
    </div>
  `;
}

async function openCategoryPermissions(categoryId: string): Promise<void> {
  state.modal = "categoryPermissions";
  state.categoryPerms = { categoryId, loading: true, saving: false, error: null, data: null, draft: {} };
  render();
  try {
    const data = await httpClient.get<CategoryPermsState["data"]>(`/api/v1/categories/${categoryId}/permissions`);
    state.categoryPerms.data = data;
    const draft: PermDraft = {};
    if (data) {
      for (const role of data.roles) {
        draft[role] = {};
        for (const a of data.actions) draft[role][a] = "inherit";
      }
      for (const ov of data.overrides) {
        if (!draft[ov.roleCode]) continue;
        for (const a of ov.granted) draft[ov.roleCode][a] = "grant";
        for (const a of ov.denied) draft[ov.roleCode][a] = "deny";
      }
    }
    state.categoryPerms.draft = draft;
  } catch (err) {
    state.categoryPerms.error = describeError(err);
  } finally {
    state.categoryPerms.loading = false;
    render();
  }
}

async function saveCategoryPermissions(): Promise<void> {
  const cp = state.categoryPerms;
  if (!cp.categoryId) return;
  cp.saving = true;
  cp.error = null;
  render();
  try {
    const data = await httpClient.put<CategoryPermsState["data"]>(
      `/api/v1/categories/${cp.categoryId}/permissions`,
      { overrides: permDraftToList(cp.draft).map(({ key, granted, denied }) => ({ roleCode: key, granted, denied })) }
    );
    state.categoryPerms.data = data;
    setTransientStatus("Права категории сохранены");
  } catch (err) {
    cp.error = describeError(err);
  } finally {
    cp.saving = false;
    render();
  }
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
  const isSelf = userId === state.me?.id;
  // I.6: source-of-truth для расширенных полей — state.userProfileData
  // (тянется лениво при openUserProfile) либо state.me для self.
  const extras = isSelf ? state.me : state.userProfileData;
  const name = member?.displayName || member?.username || dm?.peer.displayName || dm?.peer.username || extras?.displayName || extras?.username || "Пользователь";
  const username = member?.username || dm?.peer.username || extras?.username || "";
  const avatarMediaId = member?.avatarMediaId || dm?.peer.avatarMediaId || extras?.avatarMediaId;
  const presenceMode = member?.presenceMode || dm?.peer.presenceMode || extras?.presenceMode;
  const customStatus = member?.customStatus || dm?.peer.customStatus || extras?.customStatus;
  const role = member?.role;
  const bio = extras?.bio;
  const bannerMediaId = extras?.bannerMediaId;
  const bannerColor = extras?.bannerColor;
  const inCall = state.callSnapshot !== null;
  // Wave 7: стиль профиля. member-данные — fallback для self/без-GET кейсов.
  const profileTheme = extras?.profileTheme ?? member?.profileTheme;
  const nameGradient = extras?.nameGradient ?? member?.nameGradient;
  const badgeEmoji = extras?.badgeEmoji ?? member?.badgeEmoji;
  const badgeLabel = extras?.badgeLabel ?? member?.badgeLabel;
  const avatarDecoration = extras?.avatarDecoration ?? member?.avatarDecoration;
  const profileEffect = extras?.profileEffect ?? member?.profileEffect;
  const theme = parseGradient(profileTheme);
  const bannerStyle = bannerMediaId ? "" : bannerColor ? `background: ${escapeHtml(bannerColor)};` : theme ? `background: linear-gradient(135deg, ${theme[0]}, ${theme[1]});` : "";
  const bannerAttrs = bannerMediaId ? ` data-banner-media="${escapeHtml(bannerMediaId)}"` : "";
  const cardStyle = theme ? ` style="background: linear-gradient(180deg, ${theme[0]}22, ${theme[1]}22);"` : "";
  // I.16: анимированный оверлей поверх баннера. Известные id → div с
  // CSS-анимацией, прочее игнорим.
  const effectOverlay = profileEffect && PROFILE_EFFECTS.some((e) => e.id === profileEffect)
    ? `<div class="profile-effect profile-effect-${profileEffect}" aria-hidden="true"></div>`
    : "";
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal user-profile-popup" role="dialog">
        <div class="user-profile-banner" style="${bannerStyle}"${bannerAttrs}>${effectOverlay}</div>
        <button class="user-profile-close" data-modal-close data-tooltip="Закрыть">✕</button>
        <div class="user-profile-avatar-row">
          <div class="user-profile-avatar-wrap">
            ${renderAvatar({ avatarMediaId, fallbackText: name, sizePx: 80, className: "user-profile-avatar", decoration: avatarDecoration })}
            ${presenceMode ? `<span class="user-profile-dot ${presenceDotClass(presenceMode)}"></span>` : ""}
          </div>
        </div>
        <div class="user-profile-card"${cardStyle}>
          <div class="user-profile-name"><span${nameGradientStyle(nameGradient)}>${escapeHtml(name)}</span>${badgeHtml(badgeEmoji, badgeLabel)}</div>
          ${username ? `<div class="user-profile-username">@${escapeHtml(username)}</div>` : ""}
          ${customStatus ? `<div class="user-profile-status">${escapeHtml(customStatus)}</div>` : ""}
          ${role ? `<div class="user-profile-role"><span class="role-badge role-${escapeHtml(role)}">${escapeHtml(role)}</span></div>` : ""}
          ${bio ? `<div class="user-profile-bio">${renderBody(bio)}</div>` : ""}
          ${renderProfileWidgets()}
          ${
            isSelf
              ? ""
              : `<div class="user-profile-actions">
                  <button class="primary user-profile-dm" data-user-id="${escapeHtml(userId)}">${icon("reply")} Сообщение</button>
                  ${!inCall ? `<button class="ghost user-profile-call" data-user-id="${escapeHtml(userId)}">${icon("phone")} Позвонить</button>` : ""}
                </div>
                ${renderProfileFriendActions(userId)}
                <div class="user-profile-note">
                  <label for="user-note-input">Заметка (видна только вам)</label>
                  <textarea id="user-note-input" data-note-user="${escapeHtml(userId)}" maxlength="2000" rows="2" placeholder="Например: познакомились на сервере X"></textarea>
                </div>`
          }
        </div>
      </div>
    </div>
  `;
}

// Wave 7 (I.13): иконка виджета-ссылки по домену. Эмодзи вместо SVG —
// тот же «без ассетов» подход, что у звуков и рамок.
function widgetIcon(rawURL: string): string {
  let host = "";
  try {
    host = new URL(rawURL).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "🔗";
  }
  if (host === "github.com" || host.endsWith(".github.io")) return "🐙";
  if (host === "twitch.tv" || host.endsWith(".twitch.tv")) return "📺";
  if (host.includes("steamcommunity") || host.includes("steampowered")) return "🎮";
  if (host === "youtube.com" || host === "youtu.be") return "▶️";
  if (host === "t.me" || host === "telegram.org") return "✈️";
  if (host === "discord.gg" || host === "discord.com") return "👾";
  return "🔗";
}

// Блок виджетов в profile-popup. null = ещё грузится (не показываем),
// пустой массив = виджетов нет.
function renderProfileWidgets(): string {
  const widgets = state.userProfileWidgets;
  if (!widgets || widgets.length === 0) return "";
  return `
    <div class="user-profile-widgets">
      ${widgets.map((w) => `
        <a class="profile-widget" href="${escapeHtml(w.url)}" target="_blank" rel="noopener noreferrer nofollow" data-tooltip="${escapeHtml(w.url)}">
          <span class="profile-widget-icon">${widgetIcon(w.url)}</span>
          <span class="profile-widget-label">${escapeHtml(w.label)}</span>
        </a>
      `).join("")}
    </div>
  `;
}

// Wave 3: кнопки дружбы/блока в profile-popup, по текущему статусу пары.
function renderProfileFriendActions(userId: string): string {
  const rel = state.friends.find((f) => f.userId === userId);
  const status = rel?.status;
  const friendBtn =
    status === "accepted"
      ? `<button class="ghost" data-friend-remove-confirm="${userId}">✓ В друзьях</button>`
      : status === "pending_out"
        ? `<button class="ghost" data-friend-remove="${userId}">Заявка отправлена ✕</button>`
        : status === "pending_in"
          ? `<button class="primary" data-friend-accept="${userId}">Принять заявку</button>`
          : status === "blocked"
            ? ""
            : `<button class="ghost" data-friend-add="${userId}">Добавить в друзья</button>`;
  const blockBtn =
    status === "blocked"
      ? `<button class="ghost" data-friend-unblock="${userId}">Разблокировать</button>`
      : `<button class="ghost danger" data-friend-block="${userId}">Заблокировать</button>`;
  return `<div class="user-profile-actions user-profile-friend-actions">${friendBtn}${blockBtn}</div>`;
}

function openUserProfile(userId: string): void {
  state.userProfileTarget = userId;
  state.userProfileData = null;
  state.userProfileWidgets = null;
  state.modal = "userProfile";
  // Wave 7 (I.13): виджеты грузим для любого профиля, включая свой.
  void (async () => {
    try {
      const data = await httpClient.get<{ items: ProfileWidget[] }>(`/api/v1/users/${userId}/widgets`);
      if (state.userProfileTarget === userId) {
        state.userProfileWidgets = data.items ?? [];
        render();
      }
    } catch {
      /* нет виджетов / сеть — блок просто не покажется */
    }
  })();
  // I.6(c): если юзер уже в state.members и у нас есть extended-поля
  // (bio/banner) — используем их сразу, popup открывается мгновенно.
  // GET всё равно дёргаем — данные могли устареть; но первичный рендер
  // не пустой.
  const cached = state.members.find((m) => m.userId === userId);
  if (cached && (cached.bio !== undefined || cached.bannerColor !== undefined || cached.bannerMediaId !== undefined)) {
    state.userProfileData = {
      id: cached.userId,
      username: cached.username,
      displayName: cached.displayName,
      avatarMediaId: cached.avatarMediaId,
      bio: cached.bio,
      bannerColor: cached.bannerColor,
      bannerMediaId: cached.bannerMediaId,
      presenceMode: cached.presenceMode,
      customStatus: cached.customStatus,
      profileTheme: cached.profileTheme,
      nameGradient: cached.nameGradient,
      badgeEmoji: cached.badgeEmoji,
      badgeLabel: cached.badgeLabel,
      avatarDecoration: cached.avatarDecoration,
      profileEffect: cached.profileEffect
    } as UserProfileData;
  }
  render();
  if (userId !== state.me?.id) {
    void (async () => {
      try {
        const data = await httpClient.get<UserProfileData>(`/api/v1/users/${userId}`);
        if (state.userProfileTarget === userId) {
          state.userProfileData = data;
          render();
        }
      } catch {
        /* 404/network — оставляем что было из кеша */
      }
    })();
  }
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
          <h3>${t("modal.wssettings")} · ${escapeHtml(ws.name)}</h3>
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
function startProfileEdit(field: "displayName" | "password" | "bio" | "bannerColor"): void {
  state.profileEdit = {
    field,
    draftDisplayName: state.me?.displayName ?? "",
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
    draftBio: state.me?.bio ?? "",
    draftBannerColor: state.me?.bannerColor ?? "",
    saving: false,
    error: null,
    okMessage: null
  };
  render();
  // фокус на первое поле редактора
  requestAnimationFrame(() => {
    const sel =
      field === "displayName" ? "#profile-display-input"
      : field === "password" ? "#profile-pw-current"
      : field === "bio" ? "#profile-bio-input"
      : field === "bannerColor" ? "#profile-banner-color-input"
      : "";
    if (sel) rootEl.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel)?.focus();
  });
}

function cancelProfileEdit(): void {
  state.profileEdit.field = null;
  state.profileEdit.error = null;
  state.profileEdit.okMessage = null;
  render();
}

function attachProfileEditHandlers(): void {
  if (state.modal !== "settings" || state.settings.tab !== "profile") return;

  rootEl.querySelectorAll<HTMLButtonElement>("[data-profile-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const f = btn.dataset.profileEdit as
        | "displayName" | "password" | "bio" | "bannerColor" | undefined;
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
    // I.6(b): live-preview в profile-card-head без render() (сохраняет
    // фокус и каретку инпута).
    const previewName = rootEl.querySelector<HTMLDivElement>(".profile-card-display");
    if (previewName) previewName.textContent = dnInput.value.trim() || state.me?.displayName || state.me?.username || "";
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

  // I.6: bio / bannerColor edits.
  const bioInput = rootEl.querySelector<HTMLTextAreaElement>("#profile-bio-input");
  bioInput?.addEventListener("input", () => {
    state.profileEdit.draftBio = bioInput.value;
    // Обновляем счётчик символов без render() (текстарея сохраняет фокус).
    const hint = bioInput.parentElement?.querySelector<HTMLElement>(".profile-field-hint");
    if (hint) hint.textContent = t("pf.bio.chars", { n: 600 - bioInput.value.length });
    // I.6(b): live-preview bio в profile-card-head через renderBody.
    const previewBio = rootEl.querySelector<HTMLDivElement>(".profile-card-bio-preview");
    if (previewBio) previewBio.innerHTML = renderBody(bioInput.value);
  });
  rootEl.querySelector<HTMLButtonElement>("#profile-bio-save")?.addEventListener("click", () => {
    void saveProfileExtra("bio");
  });

  const bcInput = rootEl.querySelector<HTMLInputElement>("#profile-banner-color-input");
  bcInput?.addEventListener("input", () => {
    state.profileEdit.draftBannerColor = bcInput.value;
    const label = rootEl.querySelector<HTMLSpanElement>("#profile-banner-color-val");
    if (label) label.textContent = bcInput.value;
    // I.6(b): live-preview banner background. Если banner_media_id есть,
    // временно убираем data-banner-media чтобы CSS solid-color победил.
    const banner = rootEl.querySelector<HTMLDivElement>(".profile-banner-area");
    if (banner) {
      banner.style.background = bcInput.value;
      banner.removeAttribute("data-banner-media");
    }
  });
  rootEl.querySelector<HTMLButtonElement>("#profile-banner-color-clear")?.addEventListener("click", () => {
    state.profileEdit.draftBannerColor = "";
    render();
  });
  rootEl.querySelector<HTMLButtonElement>("#profile-banner-color-save")?.addEventListener("click", () => {
    void saveProfileExtra("bannerColor");
  });

  // I.6: загрузка/удаление баннер-картинки (двухступенчатый flow как для аватара).
  rootEl.querySelector<HTMLButtonElement>("#profile-banner-upload")?.addEventListener("click", () => {
    rootEl.querySelector<HTMLInputElement>("#profile-banner-input")?.click();
  });
  rootEl.querySelector<HTMLInputElement>("#profile-banner-input")?.addEventListener("change", async (e) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      state.status = "Баннер должен быть картинкой";
      render();
      return;
    }
    try {
      state.status = "Загрузка баннера…";
      render();
      const uploaded = await httpClient.uploadFile<PendingUpload>("/api/v1/uploads", file);
      const updated = await httpClient.put<Me & { updatedAt: string }>(
        "/api/v1/users/me/banner",
        { mediaId: uploaded.id }
      );
      if (state.me) {
        state.me = { ...state.me, bannerMediaId: updated.bannerMediaId };
      }
      setTransientStatus("Баннер обновлён");
    } catch (err) {
      state.status = describeError(err);
      render();
    } finally {
      input.value = "";
    }
  });
  rootEl.querySelector<HTMLButtonElement>("#profile-banner-remove")?.addEventListener("click", async () => {
    try {
      const updated = await httpClient.del<Me & { updatedAt: string }>("/api/v1/users/me/banner");
      if (state.me) {
        state.me = { ...state.me, bannerMediaId: undefined, bannerColor: updated.bannerColor ?? state.me.bannerColor };
      }
      setTransientStatus("Баннер удалён");
    } catch (err) {
      state.status = describeError(err);
      render();
    }
  });
}

// I.6: общий save для bio/bannerColor — все через PUT /users/me
// с pointer-полем. Сервер возвращает обновлённый meView, обновляем state.me.
async function saveProfileExtra(field: "bio" | "bannerColor"): Promise<void> {
  const pe = state.profileEdit;
  pe.saving = true;
  pe.error = null;
  render();
  const body: Record<string, string> = {};
  if (field === "bio") body.bio = pe.draftBio.trim();
  if (field === "bannerColor") body.bannerColor = pe.draftBannerColor.trim();
  try {
    const updated = await httpClient.put<Me & { updatedAt: string }>("/api/v1/users/me", body);
    state.me = {
      ...(state.me as Me),
      bio: updated.bio,
      bannerColor: updated.bannerColor,
      displayName: updated.displayName ?? state.me?.displayName,
      avatarMediaId: updated.avatarMediaId ?? state.me?.avatarMediaId,
      bannerMediaId: updated.bannerMediaId ?? state.me?.bannerMediaId
    };
    state.profileEdit.field = null;
    state.profileEdit.saving = false;
    setTransientStatus(field === "bio" ? "Био обновлено" : "Цвет баннера обновлён");
  } catch (err) {
    pe.saving = false;
    pe.error = describeError(err);
    render();
  }
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
function openCreateChannelModal(workspaceId: string, kind: "text" | "voice", categoryId: string | null = null): void {
  state.createChannel = {
    workspaceId,
    kind,
    name: "",
    isPrivate: false,
    selectedRoles: new Set(),
    roles: state.createChannel.workspaceId === workspaceId ? state.createChannel.roles : [],
    rolesLoading: true,
    saving: false,
    error: null,
    categoryId
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
  const kindLabel = cc.kind === "voice" ? "голосовой" : cc.kind === "forum" ? "форум" : "текстовый";
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
          ${cc.kind === "forum"
            ? `<div class="modal-hint">Форум — доска постов: участники создают темы и обсуждают их в тредах. Приватные форумы пока не поддерживаются.</div>`
            : `<label class="cc-field cc-field-toggle">
            <input id="create-channel-private" type="checkbox" ${cc.isPrivate ? "checked" : ""} />
            <span class="cc-field-toggle-body">
              <span class="cc-field-label">🔒 Приватный канал</span>
              <span class="cc-field-hint">Видят только выбранные роли + админы. Можно сменить позже в настройках канала.</span>
            </span>
          </label>
          <div class="cc-roles">${rolesBlock}</div>`}
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

  // J.5: переключатель типа канала. Для forum перерендер НУЖЕН — блок
  // приватности скрывается (Wave 9: приватные форумы не поддерживаются),
  // для text/voice достаточно записи в state.
  rootEl.querySelectorAll<HTMLInputElement>('input[name="cc-kind"]').forEach((r) => {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      const prev = state.createChannel.kind;
      state.createChannel.kind = r.value as "text" | "voice" | "forum";
      if (r.value === "forum") {
        state.createChannel.isPrivate = false;
        state.createChannel.selectedRoles = new Set();
      }
      if (prev === "forum" || r.value === "forum") render();
    });
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
      isPrivate: cc.isPrivate,
      categoryId: cc.categoryId ?? undefined
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
    // realtime channel.created может прилететь до того, как POST-ответ
    // вернулся, и уже вставить канал в state — поэтому здесь дедуп.
    if (!state.channels.some((c) => c.id === ch.id)) {
      state.channels = [...state.channels, ch];
    }
    state.modal = null;
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
function renderCreateForumPostModal(): string {
  const fp = state.createForumPost;
  const ch = state.channels.find((c) => c.id === fp.channelId);
  if (!ch) return "";
  const errBlock = fp.error ? `<div class="modal-error">${escapeHtml(fp.error)}</div>` : "";
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

function attachCreateForumPostHandlers(): void {
  if (state.modal !== "createForumPost") return;
  const titleInput = rootEl.querySelector<HTMLInputElement>("#forum-post-title");
  titleInput?.addEventListener("input", () => {
    state.createForumPost.title = titleInput.value;
  });
  const bodyInput = rootEl.querySelector<HTMLTextAreaElement>("#forum-post-body");
  bodyInput?.addEventListener("input", () => {
    state.createForumPost.body = bodyInput.value;
  });
  rootEl.querySelector<HTMLButtonElement>("#forum-post-submit")?.addEventListener("click", () => {
    void submitCreateForumPost();
  });
}

async function submitCreateForumPost(): Promise<void> {
  const fp = state.createForumPost;
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
    const thread = await httpClient.post<Channel>(`/api/v1/channels/${fp.channelId}/forum/posts`, { title });
    if (!state.channels.some((c) => c.id === thread.id)) {
      state.channels = [...state.channels, thread];
    }
    try {
      await httpClient.post(`/api/v1/channels/${thread.id}/messages`, { body });
    } catch (err) {
      state.status = describeError(err);
    }
    state.modal = null;
    fp.saving = false;
    await selectChannel(thread.id);
  } catch (err) {
    fp.saving = false;
    fp.error = describeError(err);
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
          <select id="welcome-channel-select" class="listbox">
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
  "message.mention_everyone",
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
        <button id="role-create" class="ghost" data-tooltip="Создать роль">+</button>
      </div>
      <ul>
        ${rs.roles.map((r) => `
          <li class="roles-list-item ${r.id === rs.selectedRoleId ? "active" : ""}" data-select-role="${r.id}" draggable="true" data-tooltip="Перетащи, чтобы изменить позицию">
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
            ${draft.color ? `<button id="role-color-clear" class="ghost" data-tooltip="Без цвета">✕</button>` : ""}
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
          <h3>${t("modal.roles")} · ${escapeHtml(ws.name)}</h3>
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
    // Wave 5: модалка и сайдбар смотрят на один и тот же набор ролей.
    if (state.selectedWorkspaceId === wsId) {
      state.wsRoles = state.workspaceRoles.roles;
      userColorCache = null;
    }
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

// Wave 5: drag-reorder ролей. Перемещаем роль в списке (отсортирован по
// position desc) и пересчитываем позиции всем сверху вниз с шагом 10 —
// PATCH'им только те, у кого позиция реально изменилась.
let _roleDragId: string | null = null;

async function reorderRole(dragId: string, targetId: string, after: boolean): Promise<void> {
  const rs = state.workspaceRoles;
  const wsId = rs.workspaceId;
  if (!wsId) return;
  const ordered = [...rs.roles];
  const fromIdx = ordered.findIndex((r) => r.id === dragId);
  if (fromIdx === -1) return;
  const [moved] = ordered.splice(fromIdx, 1);
  let toIdx = ordered.findIndex((r) => r.id === targetId);
  if (toIdx === -1) return;
  if (after) toIdx += 1;
  ordered.splice(toIdx, 0, moved);

  const updates: Array<{ id: string; position: number }> = [];
  ordered.forEach((r, i) => {
    const pos = (ordered.length - i) * 10;
    if (r.position !== pos) {
      r.position = pos;
      updates.push({ id: r.id, position: pos });
    }
  });
  // Оптимистично применяем порядок; при ошибке перезагрузим с сервера.
  rs.roles = ordered;
  if (state.selectedWorkspaceId === wsId) {
    state.wsRoles = state.wsRoles
      .map((r) => {
        const upd = ordered.find((x) => x.id === r.id);
        return upd ? { ...r, position: upd.position } : r;
      })
      .sort((a, b) => b.position - a.position);
    userColorCache = null;
  }
  syncWorkspaceRoleDraft();
  render();
  try {
    for (const u of updates) {
      await httpClient.patch(`/api/v1/workspaces/${wsId}/roles/${u.id}`, { position: u.position });
    }
  } catch (err) {
    rs.error = describeError(err);
    await reloadWorkspaceRoles();
  }
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
    // Wave 5: drag-reorder позиций (H.5(1)) — вместо ручного числа в input.
    el.addEventListener("dragstart", (e) => {
      const id = el.dataset.selectRole;
      if (!id) return;
      _roleDragId = id;
      e.dataTransfer?.setData("text/plain", id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      el.classList.add("drag-source");
    });
    el.addEventListener("dragend", () => {
      _roleDragId = null;
      el.classList.remove("drag-source");
      rootEl.querySelectorAll(".roles-list-item.drop-before, .roles-list-item.drop-after")
        .forEach((x) => x.classList.remove("drop-before", "drop-after"));
    });
    el.addEventListener("dragover", (e) => {
      if (!_roleDragId || _roleDragId === el.dataset.selectRole) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rect = el.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      el.classList.toggle("drop-after", after);
      el.classList.toggle("drop-before", !after);
    });
    el.addEventListener("dragleave", () => {
      el.classList.remove("drop-before", "drop-after");
    });
    el.addEventListener("drop", (e) => {
      if (!_roleDragId) return;
      e.preventDefault();
      const targetId = el.dataset.selectRole;
      const rect = el.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      el.classList.remove("drop-before", "drop-after");
      if (targetId && targetId !== _roleDragId) {
        void reorderRole(_roleDragId, targetId, after);
      }
    });
  });

  rootEl.querySelector<HTMLButtonElement>("#role-create")?.addEventListener("click", async () => {
    const wsId = rs.workspaceId;
    if (!wsId) return;
    const nameRaw = await promptDialog({
      title: "Новая роль",
      label: "Название",
      placeholder: "например, Модератор"
    });
    const name = nameRaw?.trim();
    if (!name) return;
    const codeRaw = await promptDialog({
      title: "Код роли",
      body: "Только латиница (a-z), цифры, _ и -. Должен быть уникален в воркспейсе.",
      label: "Код",
      initial: slugify(name)
    });
    const code = codeRaw?.trim();
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
      // H.7/Wave 5: цвет/позиция роли могли поменяться — обновить wsRoles
      // для member-sidebar и .author в сообщениях.
      if (state.selectedWorkspaceId === wsId) {
        state.wsRoles = state.wsRoles.map((r) => (r.id === updated.id ? updated : r));
        userColorCache = null;
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
    const ok = await confirmDialog({
      title: "Удалить роль",
      body: `Удалить роль «${sel.name}»? Назначения участникам исчезнут.`,
      confirmLabel: "Удалить",
      danger: true
    });
    if (!ok) return;
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
        // Wave 5: членство влияет на union-цвет и hoisted-секции сайдбара.
        if (state.selectedWorkspaceId === wsId) {
          state.wsRoles = state.wsRoles.map((r) => (r.id === sel.id ? { ...r, memberUserIds: sel.memberUserIds } : r));
          userColorCache = null;
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
    if (state.notificationsLoading) return `<div class="search-empty">${t("common.loading")}</div>`;
    if (items.length === 0) return `<div class="search-empty">${t("notifmodal.empty")}</div>`;
    return `<ul class="notif-list">
      ${items.map(renderNotificationItem).join("")}
    </ul>`;
  })();
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide" role="dialog">
        <div class="modal-header">
          <h3>${t("modal.notifications")}</h3>
          <div class="modal-header-actions">
            ${state.notificationsUnread > 0
              ? `<button id="notif-mark-all" class="ghost">${t("notifmodal.markall")}</button>`
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
    n.kind === "reply" ? "↩" :
    n.kind === "mention_everyone" ? "📣" :
    n.kind === "friend_request" || n.kind === "friend_accept" ? "👥" : "@";
  return `
    <li class="notif-item ${unread ? "unread" : ""}" data-notif-id="${n.id}">
      <span class="notif-kind">${kindIcon}</span>
      <div class="notif-body">
        <div class="notif-title">${escapeHtml(title)}</div>
        ${body ? `<div class="notif-snippet">${escapeHtml(body)}</div>` : ""}
        <div class="notif-time" data-tooltip="${escapeHtml(formatTime(n.createdAt))}">${escapeHtml(formatTimeSmart(n.createdAt))}</div>
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
    if (loading) return `<div class="search-empty">${t("search.searching")}</div>`;
    if (query.trim().length < 2) return `<div class="search-empty">${t("search.minchars")}</div>`;
    if (hits.length === 0) return `<div class="search-empty">${t("search.none")}</div>`;
    return `<ul class="search-results">
      ${hits.map(renderSearchHit).join("")}
    </ul>`;
  })();
  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide" role="dialog">
        <div class="modal-header">
          <h3>${t("modal.search")} · ${escapeHtml(ws.name)}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="modal-body">
          <input id="search-input" class="search-input" type="text" autocomplete="off"
                 placeholder="${t("search.placeholder")}" value="${escapeHtml(query)}" />
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
        <span class="search-hit-time" data-tooltip="${escapeHtml(formatTime(hit.createdAt))}">${escapeHtml(formatTimeSmart(hit.createdAt))}</span>
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
          <h3>${t("modal.audit")} · ${escapeHtml(ws.name)}</h3>
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
  // I.12(b): targetType-фильтр. Собираем уникальные значения из текущих
  // entries (а не из захардкоженного списка) — список actions со временем
  // меняется, не хочется забыть обновить.
  const targetTypes = Array.from(new Set(state.auditEntries.map((e) => e.targetType).filter(Boolean))).sort();
  const targetOpts = targetTypes
    .map((t) => `<option value="${escapeHtml(t)}"${f.targetType === t ? " selected" : ""}>${escapeHtml(t)}</option>`)
    .join("");
  const hasAnyFilter = !!(f.action || f.actor || f.from || f.to || f.targetType);
  return `
    <div class="audit-filter">
      <select id="audit-filter-action" class="listbox">
        <option value=""${!f.action ? " selected" : ""}>Все события</option>
        ${opts}
      </select>
      <select id="audit-filter-target" class="listbox">
        <option value=""${!f.targetType ? " selected" : ""}>Все типы объектов</option>
        ${targetOpts}
      </select>
      <input id="audit-filter-actor" type="text" placeholder="Имя автора…" value="${escapeHtml(f.actor)}" />
      <input id="audit-filter-from" type="date" data-tooltip="С" value="${escapeHtml(f.from)}" />
      <input id="audit-filter-to" type="date" data-tooltip="По" value="${escapeHtml(f.to)}" />
      ${hasAnyFilter ? `<button id="audit-filter-clear" class="ghost" data-tooltip="Сбросить">✕</button>` : ""}
      <button id="audit-export-csv" class="primary" data-tooltip="Скачать видимые записи (CSV, ru-метки)">Экспорт CSV</button>
      <button id="audit-export-full" class="ghost" data-tooltip="Полный экспорт с сервера: все записи под фильтр (раздел/период/тип/код), коды действий без перевода">Полный экспорт</button>
    </div>
  `;
}

function applyAuditFilter(entries: AuditEntry[]): AuditEntry[] {
  const f = state.auditFilter;
  const actorQ = f.actor.trim().toLowerCase();
  // I.12: from = начало дня в локальной TZ; to = конец дня (включительно).
  // Сравниваем createdAt как `new Date(...)`-таймстампы.
  const fromTs = f.from ? new Date(`${f.from}T00:00:00`).getTime() : null;
  const toTs = f.to ? new Date(`${f.to}T23:59:59.999`).getTime() : null;
  if (!f.action && !f.targetType && !actorQ && fromTs === null && toTs === null) return entries;
  return entries.filter((e) => {
    if (f.action && e.action !== f.action) return false;
    if (f.targetType && e.targetType !== f.targetType) return false;
    if (actorQ) {
      const actorName = e.actorId ? describePeer(e.actorId).toLowerCase() : "система";
      if (!actorName.includes(actorQ)) return false;
    }
    if (fromTs !== null || toTs !== null) {
      const ts = new Date(e.createdAt).getTime();
      if (fromTs !== null && ts < fromTs) return false;
      if (toTs !== null && ts > toTs) return false;
    }
    return true;
  });
}

// I.12: CSV-экспорт отфильтрованных записей. RFC 4180-совместимый escape —
// каждое поле в кавычках, внутренние `"` дублируются. Excel понимает
// UTF-8 BOM для русских заголовков. Filename — `audit-<slug>-<YYYY-MM-DD>.csv`.
function exportAuditCsv(): void {
  const ws = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  if (!ws) return;
  const rows = applyAuditFilter(state.auditEntries);
  if (rows.length === 0) {
    setTransientStatus("Под фильтр ничего не попало — нечего экспортировать");
    return;
  }
  const header = ["Дата (ISO)", "Автор", "Действие", "Тип объекта", "ID объекта"];
  const escape = (v: string): string => `"${v.replace(/"/g, '""')}"`;
  const lines = [header.map(escape).join(",")];
  for (const e of rows) {
    const actor = e.actorId ? describePeer(e.actorId) : "система";
    const info = AUDIT_ACTION_INFO[e.action as keyof typeof AUDIT_ACTION_INFO];
    const action = info ? info.ru : e.action;
    lines.push(
      [e.createdAt, actor, action, e.targetType, e.targetId].map(escape).join(",")
    );
  }
  const csv = "﻿" + lines.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const today = new Date().toISOString().slice(0, 10);
  const slug = (ws.slug || ws.name || "workspace").replace(/[^a-z0-9_-]+/gi, "-");
  const a = document.createElement("a");
  a.href = url;
  a.download = `audit-${slug}-${today}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  setTransientStatus(`Скачано: ${rows.length} событий`);
}

// I.12(a): полный экспорт через server-side endpoint. В отличие от
// exportAuditCsv (рендерит то что лежит в state.auditEntries, ≤200 записей,
// с ru-labels), это идёт за всеми записями под фильтр (период/код/тип) —
// сервер стримит CSV напрямую с UTF-8 BOM. На выходе action-коды без
// перевода — стабильный формат для архива/импорта в BI.
async function exportAuditCsvFromServer(): Promise<void> {
  const ws = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  if (!ws) return;
  const f = state.auditFilter;
  const params = new URLSearchParams();
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  if (f.action) params.set("action", f.action);
  if (f.targetType) params.set("targetType", f.targetType);
  const qs = params.toString();
  const path = `/api/v1/workspaces/${ws.id}/audit/export${qs ? `?${qs}` : ""}`;
  setTransientStatus("Запрос полного экспорта…");
  try {
    const blob = await httpClient.getBlob(path);
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0, 10);
    const slug = (ws.slug || ws.name || "workspace").replace(/[^a-z0-9_-]+/gi, "-");
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-${slug}-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setTransientStatus("Полный экспорт скачан");
  } catch (err) {
    state.status = describeError(err);
    render();
  }
}

// G.10: профиль-модалка в Discord-стиле — карточка с акцентным баннером
// (там же кнопка change-avatar), крупным аватаром поверх границы баннера,
// именем+username под ним, и списком inline-edit полей. Только один field
// активен одновременно (state.profileEdit.field), остальные показывают
// статичное значение и кнопку «Изменить».
// I.1: SETTINGS_TABS — порядок и группировка табов в sidebar'е. Каждая
// группа отрисовывается своим заголовком. Содержимое табов кроме
// `profile` пока заглушки (см. I.2-I.8/I.11 в TASKS.md).
interface SettingsTabDef {
  id: SettingsTab;
  label: string;
}

interface SettingsTabGroup {
  title: string;
  tabs: SettingsTabDef[];
}

// I.7: списки локализуются через t() — пересоздаём при каждом рендере,
// чтобы смена locale в settings.language применялась мгновенно.
function settingsTabGroups(): SettingsTabGroup[] {
  return [
    {
      title: t("settings.group.account"),
      tabs: [
        { id: "profile", label: t("settings.tab.profile") },
        { id: "privacy", label: t("settings.tab.privacy") }
      ]
    },
    {
      title: t("settings.group.interact"),
      tabs: [
        { id: "voice", label: t("settings.tab.voice") },
        { id: "notifications", label: t("settings.tab.notifications") },
        { id: "hotkeys", label: t("settings.tab.hotkeys") },
        { id: "language", label: t("settings.tab.language") }
      ]
    },
    {
      title: t("settings.group.appearance"),
      tabs: [
        { id: "appearance", label: t("settings.tab.appearance") }
      ]
    },
    {
      title: t("settings.group.connection"),
      tabs: [
        { id: "server", label: t("settings.tab.server") }
      ]
    }
  ];
}

// I.11: индекс «что лежит в каждом табе». Используется для live-фильтра
// в #settings-search. Label — точное название H3-секции (для scrollIntoView
// после переключения таба ищем h3 с этим textContent'ом). Keywords —
// дополнительные синонимы, чтобы «микрофон» подсвечивал секцию «Голос».
interface SettingsSearchEntry {
  tab: SettingsTab;
  label: string;
  keywords?: string[];
}

// Wave 6: функция, а не const — label'ы должны совпадать с переведёнными
// h3-заголовками секций (по ним работает scrollIntoView после перехода).
function settingsSearchIndex(): SettingsSearchEntry[] {
  return [
    { tab: "profile", label: t("settings.tab.profile"), keywords: ["аватар", "имя", "никнейм", "почта", "пароль", "биография", "баннер", "avatar", "password", "email", "bio", "banner"] },
    { tab: "voice", label: t("vs.voice.title"), keywords: ["микрофон", "громкость", "вход", "audio", "input", "microphone"] },
    { tab: "voice", label: t("vs.cam.title"), keywords: ["видео", "разрешение", "720p", "1080p", "webcam", "video"] },
    { tab: "voice", label: t("vs.ptt.title"), keywords: ["ptt", "рация", "зажать", "talkie", "push"] },
    { tab: "voice", label: t("vs.denoise.title"), keywords: ["denoiser", "rucord", "ns", "noise", "шум"] },
    { tab: "voice", label: t("vs.advanced.title"), keywords: ["ec", "agc", "эхо", "autogain", "усиление", "echo"] },
    { tab: "hotkeys", label: t("hk.cat.voice"), keywords: ["mute", "deafen", "горячие клавиши", "хоткей", "shortcut"] },
    { tab: "hotkeys", label: t("hk.cat.channels"), keywords: ["unread", "переход", "пометить прочитанным", "alt"] },
    { tab: "hotkeys", label: t("hk.cat.messages"), keywords: ["редактировать", "edit"] },
    { tab: "hotkeys", label: t("hk.cat.general"), keywords: ["quick switcher", "поиск", "ctrl k", "ctrl f"] },
    { tab: "privacy", label: t("pv.sessions.title"), keywords: ["сессии", "sessions", "устройства", "devices", "logout"] },
    { tab: "privacy", label: t("pv.logoutall.title"), keywords: ["logout", "logout-all", "revoke"] },
    { tab: "notifications", label: t("nt.desktop.title"), keywords: ["desktop", "popup", "разрешение", "permission"] },
    { tab: "notifications", label: t("nt.sound.title"), keywords: ["sound", "beep", "звук", "тишина"] },
    { tab: "notifications", label: t("nt.suppress.title"), keywords: ["everyone", "here", "mute", "глушить"] },
    { tab: "appearance", label: t("ap.theme.title"), keywords: ["dark", "light", "тёмная", "светлая", "auto"] },
    { tab: "appearance", label: t("ap.accent.title"), keywords: ["accent", "color", "цвет"] },
    { tab: "appearance", label: t("ap.density.title"), keywords: ["density", "cozy", "compact", "уютная", "компактная"] },
    { tab: "appearance", label: t("ap.messages.title"), keywords: ["группировка", "role", "цвет ролей", "group"] },
    { tab: "appearance", label: t("ap.gif.title"), keywords: ["gif", "apng", "анимация", "hover", "наведение"] },
    { tab: "language", label: t("settings.language.title"), keywords: ["locale", "language", "russian", "english", "ru", "en", "перевод"] },
    { tab: "language", label: t("settings.timeformat.title"), keywords: ["12-часовой", "24-часовой", "am", "pm", "часы", "time format"] },
    { tab: "server", label: t("sv.title"), keywords: ["адрес", "подключение", "https", "сертификат", "address", "connection", "url", "tls"] }
  ];
}

function findSettingsTab(id: SettingsTab): SettingsTabDef {
  for (const group of settingsTabGroups()) {
    const tab = group.tabs.find((t) => t.id === id);
    if (tab) return tab;
  }
  // Не должно случиться — fallback на profile.
  return settingsTabGroups()[0].tabs[0];
}

function renderSettingsModal(): string {
  const me = state.me;
  if (!me) return "";
  const activeTab = state.settings.tab;
  const activeDef = findSettingsTab(activeTab);
  const displayName = me.displayName || me.username;

  const sidebar = `
    <aside class="settings-sidebar">
      <button class="settings-user" data-settings-tab="profile" data-tooltip="Открыть профиль">
        ${renderAvatar({
          avatarMediaId: me.avatarMediaId,
          fallbackText: displayName,
          sizePx: 36,
          className: "settings-user-avatar"
        })}
        <div class="settings-user-body">
          <div class="settings-user-name">${escapeHtml(displayName)}</div>
          <div class="settings-user-hint">${escapeHtml(t("settings.user.edit"))}</div>
        </div>
      </button>
      <div class="settings-search-wrap">
        <input id="settings-search" class="settings-search" type="text"
               placeholder="${escapeHtml(t("settings.search"))}"
               value="${escapeHtml(state.settings.search)}"
               autocomplete="off" spellcheck="false" />
        <div id="settings-search-results" class="settings-search-results" hidden></div>
      </div>
      <nav class="settings-nav">
        ${settingsTabGroups().map(renderSettingsGroup).join("")}
      </nav>
      <button id="settings-logout-btn" class="settings-logout">
        ${icon("log-out", { size: 16 })} <span>${escapeHtml(t("settings.logout"))}</span>
      </button>
    </aside>
  `;

  const content = `
    <section class="settings-content">
      <header class="settings-content-header">
        <h2>${escapeHtml(activeDef.label)}</h2>
        <button class="ghost settings-close" data-modal-close aria-label="Закрыть">✕</button>
      </header>
      <div class="settings-content-body">
        <div class="settings-content-inner">
          ${renderSettingsTabContent(activeTab)}
        </div>
      </div>
    </section>
  `;

  return `
    <input id="profile-avatar-input" type="file" accept="image/*" hidden />
    <div class="settings-modal" data-modal-close role="dialog">
      ${sidebar}
      ${content}
    </div>
  `;
}

function renderSettingsGroup(group: SettingsTabGroup): string {
  return `
    <div class="settings-group">
      <div class="settings-group-title">${escapeHtml(group.title)}</div>
      ${group.tabs.map(renderSettingsTabButton).join("")}
    </div>
  `;
}

function renderSettingsTabButton(tab: SettingsTabDef): string {
  const active = state.settings.tab === tab.id ? " active" : "";
  return `
    <button class="settings-tab${active}" data-settings-tab="${tab.id}">
      ${escapeHtml(tab.label)}
    </button>
  `;
}

function renderSettingsTabContent(tab: SettingsTab): string {
  if (tab === "profile") return renderSettingsProfileTab();
  if (tab === "voice") return renderSettingsVoiceTab();
  if (tab === "hotkeys") return renderSettingsHotkeysTab();
  if (tab === "appearance") return renderSettingsAppearanceTab();
  if (tab === "notifications") return renderSettingsNotificationsTab();
  if (tab === "privacy") return renderSettingsPrivacyTab();
  if (tab === "language") return renderSettingsLanguageTab();
  return renderSettingsServerTab();
}

// Вкладка «Сервер»: адрес, проверка связи, смена. Результат проверки живёт в
// модуле (как список сеансов на вкладке «Конфиденциальность»), а не в AppState.
type ServerCheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok" }
  | { status: "error"; message: string };

let _serverCheck: ServerCheckState = { status: "idle" };

function renderSettingsServerTab(): string {
  const production = isProductionShell();
  const serverUrl = production ? (getStoredServerUrl() ?? "") : httpClient.baseUrl || window.location.origin;
  const check = _serverCheck;
  const checkResult = check.status === "checking"
    ? `<div class="settings-hint">${t("sv.check.running")}</div>`
    : check.status === "ok"
      ? `<div class="settings-hint settings-server-ok">${t("sv.check.ok")}</div>`
      : check.status === "error"
        ? `<div class="modal-error">${escapeHtml(check.message)}</div>`
        : "";
  return `
    <div class="settings-section">
      <h3>${t("sv.title")}</h3>
      <small class="settings-hint">${production ? t("sv.hint") : t("sv.hint.dev")}</small>
      <div class="settings-server-url"><code>${escapeHtml(serverUrl)}</code></div>
      ${production && isInsecureServerUrl(serverUrl) ? `<div class="settings-server-warning" role="status">${escapeHtml(INSECURE_SERVER_WARNING)}</div>` : ""}
      ${checkResult}
      ${production ? `
        <div class="admin-actions settings-server-actions">
          <button id="server-check"${check.status === "checking" ? " disabled" : ""}>${t("sv.check.button")}</button>
          <button id="server-switch" class="danger">${t("sv.switch.button")}</button>
        </div>
      ` : ""}
    </div>
  `;
}

function attachSettingsServerHandlers(): void {
  if (state.modal !== "settings" || state.settings.tab !== "server") return;
  rootEl.querySelector<HTMLButtonElement>("#server-check")?.addEventListener("click", async () => {
    const url = getStoredServerUrl();
    if (!url) return;
    _serverCheck = { status: "checking" };
    render();
    try {
      await checkServerReachable(url);
      _serverCheck = { status: "ok" };
    } catch (err) {
      _serverCheck = { status: "error", message: err instanceof ServerCheckError ? err.message : describeError(err) };
    }
    render();
  });
  rootEl.querySelector<HTMLButtonElement>("#server-switch")?.addEventListener("click", () => {
    void switchServer();
  });
}

// I.4: state для capture-режима. Когда юзер кликнул на binding-кнопку,
// модуль ждёт первый keydown с не-модификаторной клавишей и записывает
// chord. Esc отменяет capture.
let _capturingActionId: ActionId | null = null;

// Wave 6: лейблы хоткеев. Сами defs живут в hotkeys.ts (самодостаточный
// модуль без i18n-зависимости) — переводим на рендере: t("hk.<id>") с
// fallback'ом на def.label, если ключа в словаре нет (новые action'ы
// не сломаются до добавления перевода).
function hkLabel(def: ActionDef): string {
  const key = `hk.${def.id}`;
  const s = t(key);
  return s === key ? def.label : s;
}

function hkDesc(def: ActionDef): string {
  if (!def.description) return "";
  const key = `hk.${def.id}.desc`;
  const s = t(key);
  return s === key ? def.description : s;
}

function renderSettingsHotkeysTab(): string {
  const actions = getHotkeyActions();
  // K.3: предвычисляем словарь chord → ActionId[] чтобы подсветить
  // конфликты. Только enabled-binding'и с непустым chord'ом считаются.
  const conflictMap = new Map<string, ActionDef[]>();
  for (const a of actions) {
    const b = getHotkeyBinding(a.id);
    if (!b.enabled || !b.chord) continue;
    const sig = formatChord(b.chord);
    const list = conflictMap.get(sig) ?? [];
    list.push(a);
    conflictMap.set(sig, list);
  }
  const byCategory = new Map<ActionDef["category"], ActionDef[]>();
  for (const a of actions) {
    const list = byCategory.get(a.category) ?? [];
    list.push(a);
    byCategory.set(a.category, list);
  }
  const sections = Array.from(byCategory.entries())
    .map(([cat, list]) => {
      const rows = list.map((a) => renderHotkeyRow(a, conflictMap)).join("");
      return `
        <div class="settings-section">
          <h3>${escapeHtml(t(`hk.cat.${cat}`))}</h3>
          <div class="hotkeys-list">${rows}</div>
        </div>
      `;
    })
    .join("");
  // #5c: статус глобальных хоткеев. Если плагин не загрузился (web) или
  // часть биндингов не зарегистрировалась — показываем баннер, чтобы было
  // видно, почему хоткеи не работают в свёрнутом окне.
  const globalBanner = (() => {
    if (!isGlobalSupported()) {
      return `<div class="settings-hint settings-hint-warn">${t("hk.global.unsupported")}</div>`;
    }
    const failed = getHotkeyActions().filter((a) => getGlobalStatus(a.id) === "failed");
    const bare = getHotkeyActions().filter((a) => getGlobalStatus(a.id) === "bare");
    const parts: string[] = [];
    if (bare.length > 0) {
      parts.push(`<div class="settings-hint settings-hint-warn">${t("hk.global.bare", { list: escapeHtml(bare.map(hkLabel).join(", ")) })}</div>`);
    }
    if (failed.length > 0) {
      parts.push(`<div class="settings-hint settings-hint-warn">${t("hk.global.failed", { list: escapeHtml(failed.map(hkLabel).join(", ")) })}</div>`);
    }
    return parts.join("");
  })();
  return `
    <div class="settings-hint" style="margin-bottom: 16px;">
      ${t("hk.intro")}
    </div>
    ${globalBanner}
    ${sections}
  `;
}

// #5c: бейдж статуса глобальной регистрации для voice-action'ов.
function globalStatusBadge(id: ActionId): string {
  const st: GlobalStatus = getGlobalStatus(id);
  if (st === "registered") {
    return `<span class="hotkeys-global ok" data-tooltip="${t("hk.badge.ok")}">🌐</span>`;
  }
  if (st === "failed") {
    return `<span class="hotkeys-global fail" data-tooltip="${t("hk.badge.fail")}">🌐✕</span>`;
  }
  if (st === "bare") {
    return `<span class="hotkeys-global fail" data-tooltip="${t("hk.badge.bare")}">🌐✕</span>`;
  }
  return "";
}

function renderHotkeyRow(def: ActionDef, conflicts: Map<string, ActionDef[]>): string {
  const b = getHotkeyBinding(def.id);
  const isCapturing = _capturingActionId === def.id;
  const chordLabel = isCapturing ? t("hk.capture") : formatChord(b.chord);
  // K.3: ищем тех, кто тоже сидит на этом chord'е. Если список >1 —
  // подсвечиваем warning + tooltip с именами других.
  const sig = b.chord ? formatChord(b.chord) : "";
  const others = sig ? (conflicts.get(sig) ?? []).filter((a) => a.id !== def.id) : [];
  const conflictBadge = others.length > 0
    ? `<span class="hotkeys-conflict" data-tooltip="${t("hk.conflict", { list: escapeHtml(others.map(hkLabel).join(", ")) })}">⚠</span>`
    : "";
  const desc = hkDesc(def);
  return `
    <div class="hotkeys-row ${b.enabled ? "" : "disabled"} ${others.length > 0 ? "has-conflict" : ""}" data-hotkey-row="${def.id}">
      <label class="hotkeys-toggle" data-tooltip="${b.enabled ? t("hk.toggle.off") : t("hk.toggle.on")}">
        <input type="checkbox" data-hotkey-toggle="${def.id}" ${b.enabled ? "checked" : ""} />
        <span class="hotkeys-toggle-track"></span>
      </label>
      <div class="hotkeys-info">
        <div class="hotkeys-label">${escapeHtml(hkLabel(def))} ${conflictBadge} ${globalStatusBadge(def.id)}</div>
        ${desc ? `<div class="hotkeys-desc">${escapeHtml(desc)}</div>` : ""}
      </div>
      <button class="hotkeys-chord ${isCapturing ? "capturing" : ""}" data-hotkey-capture="${def.id}">
        ${escapeHtml(chordLabel)}
      </button>
      <button class="ghost hotkeys-reset" data-hotkey-reset="${def.id}" data-tooltip="${t("hk.reset")}">
        ${icon("x", { size: 14 })}
      </button>
      <button class="ghost hotkeys-clear" data-hotkey-clear="${def.id}" data-tooltip="${t("hk.clear")}" ${b.chord ? "" : "disabled"}>
        ${icon("trash", { size: 14 })}
      </button>
    </div>
  `;
}

function attachSettingsHotkeysHandlers(): void {
  if (state.modal !== "settings" || state.settings.tab !== "hotkeys") {
    // Юзер ушёл с таба — отменяем capture, чтобы случайный keydown
    // не записался в чужой chord.
    _capturingActionId = null;
    return;
  }
  rootEl.querySelectorAll<HTMLButtonElement>("[data-hotkey-capture]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.hotkeyCapture as ActionId | undefined;
      if (!id) return;
      _capturingActionId = _capturingActionId === id ? null : id;
      render();
    });
  });
  rootEl.querySelectorAll<HTMLButtonElement>("[data-hotkey-reset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.hotkeyReset as ActionId | undefined;
      if (!id) return;
      resetHotkeyBinding(id);
      render();
    });
  });
  // K.1: «Снять привязку» — ставит chord=null, оставляя action в списке.
  rootEl.querySelectorAll<HTMLButtonElement>("[data-hotkey-clear]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.hotkeyClear as ActionId | undefined;
      if (!id) return;
      setHotkeyChord(id, null);
      render();
    });
  });
  rootEl.querySelectorAll<HTMLInputElement>("[data-hotkey-toggle]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.hotkeyToggle as ActionId | undefined;
      if (!id) return;
      setHotkeyEnabled(id, cb.checked);
      render();
    });
  });
}

// Listener в installGlobalKeyboardShortcuts перехватывает keydown во
// время capture'а ДО основного dispatcher'а — иначе нажатие, например,
// Ctrl+K в capture-режиме открыло бы Quick Switcher вместо привязки.
function maybeCaptureKey(ev: KeyboardEvent): boolean {
  if (!_capturingActionId) return false;
  if (ev.key === "Escape") {
    _capturingActionId = null;
    ev.preventDefault();
    render();
    return true;
  }
  // K.1: Delete / Backspace в capture-режиме = «Не назначено».
  if (ev.code === "Delete" || ev.code === "Backspace") {
    ev.preventDefault();
    setHotkeyChord(_capturingActionId, null);
    _capturingActionId = null;
    render();
    return true;
  }
  const chord = chordFromEvent(ev);
  if (!chord) return true; // ждём не-модификаторную клавишу
  ev.preventDefault();
  const targetId = _capturingActionId;
  _capturingActionId = null;
  // I.4(4): если этот chord уже занят другим action'ом — спросим, заменить ли.
  // Без подтверждения молча перепривяжем, юзер потом удивится почему
  // оба action'а срабатывают.
  const sig = formatChord(chord);
  const conflicts = getHotkeyActions().filter((a) => {
    if (a.id === targetId) return false;
    const b = getHotkeyBinding(a.id);
    return b.enabled && b.chord && formatChord(b.chord) === sig;
  });
  if (conflicts.length > 0) {
    const names = conflicts.map((c) => c.label).join(", ");
    render();
    void (async () => {
      const ok = await confirmDialog({
        title: "Хоткей уже занят",
        body: `${sig} назначен на: ${names}. Заменить — снимет привязки с этих action'ов.`,
        confirmLabel: "Заменить",
        danger: true
      });
      if (!ok) return;
      for (const c of conflicts) setHotkeyChord(c.id, null);
      setHotkeyChord(targetId, chord);
      render();
    })();
    return true;
  }
  setHotkeyChord(targetId, chord);
  render();
  return true;
}

// I.5: тема, accent, density, группировка, цвета ролей. Все изменения —
// сразу пишутся через updateAppearance() (которое триггерит applyAppearance()
// → outline на <html>). Затем render() — чтобы UI таба и весь chat-list
// обновились с новым `grouped`/`roleColors` режимом.
function renderSettingsAppearanceTab(): string {
  const s = getAppearance();
  // Wave 6: map-параметр нарочно не `t` — не шейдить функцию перевода.
  const themeOpts: { id: ThemeMode; label: string; sub: string }[] = [
    { id: "dark", label: t("ap.theme.dark"), sub: t("ap.theme.dark.sub") },
    { id: "light", label: t("ap.theme.light"), sub: t("ap.theme.light.sub") },
    { id: "auto", label: t("ap.theme.auto"), sub: t("ap.theme.auto.sub") }
  ];
  const themeCards = themeOpts
    .map((opt) => `
      <label class="vs-denoiser-option ${s.theme === opt.id ? "active" : ""}">
        <input type="radio" name="ap-theme" value="${opt.id}" ${s.theme === opt.id ? "checked" : ""} />
        <div class="vs-denoiser-option-body">
          <div class="vs-denoiser-option-head">
            <span class="vs-denoiser-option-label">${escapeHtml(opt.label)}</span>
          </div>
          <div class="vs-denoiser-option-sub">${escapeHtml(opt.sub)}</div>
        </div>
      </label>
    `).join("");

  const densityOpts: { id: Density; label: string; sub: string }[] = [
    { id: "cozy", label: t("ap.density.cozy"), sub: t("ap.density.cozy.sub") },
    { id: "compact", label: t("ap.density.compact"), sub: t("ap.density.compact.sub") }
  ];
  const densityCards = densityOpts
    .map((opt) => `
      <label class="vs-denoiser-option ${s.density === opt.id ? "active" : ""}">
        <input type="radio" name="ap-density" value="${opt.id}" ${s.density === opt.id ? "checked" : ""} />
        <div class="vs-denoiser-option-body">
          <div class="vs-denoiser-option-head">
            <span class="vs-denoiser-option-label">${escapeHtml(opt.label)}</span>
          </div>
          <div class="vs-denoiser-option-sub">${escapeHtml(opt.sub)}</div>
        </div>
      </label>
    `).join("");

  const accentValue = s.accent || "#5865f2";
  const accentDisplay = s.accent || t("ap.accent.default");

  return `
    <div class="settings-section">
      <h3>${t("ap.theme.title")}</h3>
      <div class="vs-denoiser-list">${themeCards}</div>
    </div>

    <div class="settings-section">
      <h3>${t("ap.accent.title")}</h3>
      <div class="settings-row">
        <label for="ap-accent">${t("ap.accent.label")}</label>
        <div class="settings-slider-wrap" style="gap: 12px;">
          <input id="ap-accent" type="color" value="${escapeHtml(accentValue)}" />
          <span id="ap-accent-val" class="settings-slider-val" style="min-width: 120px;">${escapeHtml(accentDisplay)}</span>
          <button id="ap-accent-reset" class="ghost" data-tooltip="${t("ap.accent.reset")}">${icon("x", { size: 14 })}</button>
        </div>
        <small class="settings-hint">${t("ap.accent.hint")}</small>
      </div>
    </div>

    <div class="settings-section">
      <h3>${t("ap.density.title")}</h3>
      <div class="vs-denoiser-list">${densityCards}</div>
    </div>

    <div class="settings-section">
      <h3>${t("ap.messages.title")}</h3>
      <label class="settings-check">
        <input type="checkbox" id="ap-group" ${s.groupMessages ? "checked" : ""} />
        <span>${t("ap.messages.group")}</span>
      </label>
      <label class="settings-check">
        <input type="checkbox" id="ap-role-colors" ${s.roleColors ? "checked" : ""} />
        <span>${t("ap.messages.rolecolors")}</span>
      </label>
    </div>

    <div class="settings-section">
      <h3>${t("ap.gif.title")}</h3>
      <div class="settings-row" style="display:flex; gap:8px; align-items:center;">
        <select id="ap-gif-avatars" class="settings-select">
          <option value="always" ${s.gifAvatars === "always" ? "selected" : ""}>${t("ap.gif.always")}</option>
          <option value="hover" ${s.gifAvatars === "hover" ? "selected" : ""}>${t("ap.gif.hover")}</option>
          <option value="never" ${s.gifAvatars === "never" ? "selected" : ""}>${t("ap.gif.never")}</option>
        </select>
      </div>
      <small class="settings-hint">
        ${t("ap.gif.hint")}
      </small>
    </div>
  `;
}

function attachSettingsAppearanceHandlers(): void {
  if (state.modal !== "settings" || state.settings.tab !== "appearance") return;
  rootEl.querySelectorAll<HTMLInputElement>('input[name="ap-theme"]').forEach((r) => {
    r.addEventListener("change", () => {
      if (r.checked) {
        updateAppearance({ theme: r.value as ThemeMode });
        render();
      }
    });
  });
  rootEl.querySelectorAll<HTMLInputElement>('input[name="ap-density"]').forEach((r) => {
    r.addEventListener("change", () => {
      if (r.checked) {
        updateAppearance({ density: r.value as Density });
        render();
      }
    });
  });
  const accent = rootEl.querySelector<HTMLInputElement>("#ap-accent");
  accent?.addEventListener("input", () => {
    updateAppearance({ accent: accent.value });
    const label = rootEl.querySelector<HTMLSpanElement>("#ap-accent-val");
    if (label) label.textContent = accent.value;
  });
  rootEl.querySelector<HTMLButtonElement>("#ap-accent-reset")?.addEventListener("click", () => {
    updateAppearance({ accent: "" });
    render();
  });
  rootEl.querySelector<HTMLInputElement>("#ap-group")?.addEventListener("change", (e) => {
    updateAppearance({ groupMessages: (e.currentTarget as HTMLInputElement).checked });
    render();
  });
  rootEl.querySelector<HTMLInputElement>("#ap-role-colors")?.addEventListener("change", (e) => {
    updateAppearance({ roleColors: (e.currentTarget as HTMLInputElement).checked });
    render();
  });
  // I.14: режим анимации аватаров. render() пересоздаёт avatar-слоты —
  // attachAvatarSlots перезаполнит их уже в новом режиме.
  rootEl.querySelector<HTMLSelectElement>("#ap-gif-avatars")?.addEventListener("change", (e) => {
    updateAppearance({ gifAvatars: (e.currentTarget as HTMLSelectElement).value as GifAvatarsMode });
    render();
  });
}

// I.8: вкладка «Уведомления». Toggle desktop-уведомлений (с кнопкой
// «Разрешить» если permission=default), toggle звука + кнопка «Прослушать»,
// toggle подавления @everyone/@here.
function renderSettingsNotificationsTab(): string {
  const s = getNotificationSettings();
  const permission = typeof Notification !== "undefined" ? Notification.permission : "default";
  const permissionLabel =
    permission === "granted"
      ? `<span class="settings-hint" style="color:#43b581">${t("nt.perm.granted")}</span>`
      : permission === "denied"
        ? `<span class="settings-hint" style="color:#d6453a">${t("nt.perm.denied")}</span>`
        : `<button id="notif-request-permission" class="primary">${t("nt.perm.request")}</button>`;

  return `
    <div class="settings-section">
      <h3>${t("nt.desktop.title")}</h3>
      <label class="settings-check">
        <input type="checkbox" id="notif-desktop" ${s.desktopEnabled ? "checked" : ""} />
        <span>${t("nt.desktop.toggle")}</span>
      </label>
      <small class="settings-hint">
        ${t("nt.desktop.hint")}
      </small>
      <div class="settings-row" style="margin-top: 8px;">${permissionLabel}</div>
    </div>

    <div class="settings-section">
      <h3>${t("nt.sound.title")}</h3>
      <label class="settings-check">
        <input type="checkbox" id="notif-sound" ${s.soundEnabled ? "checked" : ""} />
        <span>${t("nt.sound.toggle")}</span>
      </label>
      <div class="settings-row" style="margin-top: 8px; display: flex; gap: 8px; align-items: center;">
        <select id="notif-sound-kind" class="settings-select">
          ${(Object.keys(SOUND_LABELS) as NotificationSoundKind[])
            .map((k) => `<option value="${k}"${s.sound === k ? " selected" : ""}>${t(`sound.${k}`)}</option>`)
            .join("")}
        </select>
        <button id="notif-sound-test" class="primary">${t("nt.sound.test")}</button>
      </div>
      <small class="settings-hint">
        ${t("nt.sound.hint")}
      </small>
    </div>

    <div class="settings-section">
      <h3>${t("nt.suppress.title")}</h3>
      <label class="settings-check">
        <input type="checkbox" id="notif-mute-everyone" ${s.muteEveryone ? "checked" : ""} />
        <span>${t("nt.suppress.everyone")}</span>
      </label>
      <small class="settings-hint">
        ${t("nt.suppress.hint")}
      </small>
    </div>
  `;
}

function attachSettingsNotificationsHandlers(): void {
  if (state.modal !== "settings" || state.settings.tab !== "notifications") return;
  rootEl.querySelector<HTMLInputElement>("#notif-desktop")?.addEventListener("change", async (e) => {
    const enabled = (e.currentTarget as HTMLInputElement).checked;
    updateNotificationSettings({ desktopEnabled: enabled });
    if (enabled && typeof Notification !== "undefined" && Notification.permission === "default") {
      await requestBrowserNotificationPermission();
      render();
    }
  });
  rootEl.querySelector<HTMLInputElement>("#notif-sound")?.addEventListener("change", (e) => {
    updateNotificationSettings({ soundEnabled: (e.currentTarget as HTMLInputElement).checked });
  });
  rootEl.querySelector<HTMLInputElement>("#notif-mute-everyone")?.addEventListener("change", (e) => {
    updateNotificationSettings({ muteEveryone: (e.currentTarget as HTMLInputElement).checked });
  });
  rootEl.querySelector<HTMLSelectElement>("#notif-sound-kind")?.addEventListener("change", (e) => {
    const kind = (e.currentTarget as HTMLSelectElement).value as NotificationSoundKind;
    updateNotificationSettings({ sound: kind });
    playNotificationSound(kind); // сразу даём услышать выбор
  });
  rootEl.querySelector<HTMLButtonElement>("#notif-sound-test")?.addEventListener("click", () => {
    // preview-аргумент игнорирует soundEnabled — юзер услышит даже при выключенном.
    playNotificationSound(getNotificationSettings().sound);
  });
  rootEl.querySelector<HTMLButtonElement>("#notif-request-permission")?.addEventListener("click", async () => {
    await requestBrowserNotificationPermission();
    render();
  });
}

// I.10: privacy & sessions tab. Список активных сессий + кнопки revoke
// per-session + «Выйти со всех устройств». Cache в модуль-локалке, чтобы
// не дёргать API на каждый render().
interface SessionView {
  id: string;
  deviceLabel: string;
  userAgent?: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}
let _sessions: SessionView[] | null = null;
let _sessionsLoading = false;
let _sessionsError: string | null = null;

function ensureSessionsLoaded(): void {
  if (_sessions !== null || _sessionsLoading) return;
  _sessionsLoading = true;
  void httpClient
    .get<{ items: SessionView[] }>("/api/v1/users/me/sessions")
    .then((r) => {
      _sessions = r.items ?? [];
      _sessionsLoading = false;
      _sessionsError = null;
      if (state.modal === "settings" && state.settings.tab === "privacy") render();
    })
    .catch((err) => {
      _sessionsLoading = false;
      _sessionsError = describeError(err);
      if (state.modal === "settings" && state.settings.tab === "privacy") render();
    });
}

// I.7: «Язык и время». RU/EN селект + radio time-format (auto/12/24).
// Изменения применяются мгновенно: setLocale/setTimeFormat пишут в
// localStorage и дёргают listeners → render() обновляет UI без перезагрузки.
function renderSettingsLanguageTab(): string {
  const locale = getLocale();
  const fmt = getTimeFormat();
  const sample = new Date();
  // Превью: формат времени с текущей настройкой, чтобы юзер видел эффект.
  const samplePreview = sample.toLocaleTimeString(intlLocale(), {
    hour: "2-digit", minute: "2-digit", hour12: hour12Setting()
  });
  return `
    <div class="settings-section">
      <h3>${escapeHtml(t("settings.language.title"))}</h3>
      <div class="settings-hint">${escapeHtml(t("settings.language.hint"))}</div>
      <select id="settings-locale" class="settings-select">
        <option value="ru"${locale === "ru" ? " selected" : ""}>${escapeHtml(t("settings.language.option.ru"))}</option>
        <option value="en"${locale === "en" ? " selected" : ""}>${escapeHtml(t("settings.language.option.en"))}</option>
      </select>
    </div>
    <div class="settings-section">
      <h3>${escapeHtml(t("settings.timeformat.title"))}</h3>
      <div class="settings-hint">${escapeHtml(t("settings.timeformat.hint"))}</div>
      <div class="settings-radio-group">
        <label class="settings-radio">
          <input type="radio" name="settings-time-format" value="auto" ${fmt === "auto" ? "checked" : ""} />
          <span>${escapeHtml(t("settings.timeformat.option.auto"))}</span>
        </label>
        <label class="settings-radio">
          <input type="radio" name="settings-time-format" value="h24" ${fmt === "h24" ? "checked" : ""} />
          <span>${escapeHtml(t("settings.timeformat.option.h24"))}</span>
        </label>
        <label class="settings-radio">
          <input type="radio" name="settings-time-format" value="h12" ${fmt === "h12" ? "checked" : ""} />
          <span>${escapeHtml(t("settings.timeformat.option.h12"))}</span>
        </label>
      </div>
      <div class="settings-hint" style="margin-top:8px">Сейчас: <strong>${escapeHtml(samplePreview)}</strong></div>
    </div>
  `;
}

function renderSettingsPrivacyTab(): string {
  ensureSessionsLoaded();
  const list = _sessions ?? [];
  const sessionsBlock = _sessionsLoading
    ? `<div class="settings-hint">${t("pv.sessions.loading")}</div>`
    : _sessionsError
      ? `<div class="modal-error">${escapeHtml(_sessionsError)}</div>`
      : list.length === 0
        ? `<div class="settings-hint">${t("pv.sessions.none")}</div>`
        : `<ul class="sessions-list">
            ${list.map((s) => `
              <li class="sessions-item${s.current ? " current" : ""}">
                <div class="sessions-item-info">
                  <div class="sessions-item-label">
                    ${escapeHtml(s.deviceLabel || t("pv.sessions.device"))}
                    ${s.current ? `<span class="sessions-current-badge">${t("pv.sessions.current")}</span>` : ""}
                  </div>
                  ${s.userAgent ? `<div class="sessions-item-ua">${escapeHtml(s.userAgent)}</div>` : ""}
                  <div class="sessions-item-meta">
                    ${t("pv.sessions.meta", { created: formatTimeSmart(s.createdAt), seen: formatTimeSmart(s.lastSeenAt) })}
                  </div>
                </div>
                ${s.current
                  ? ""
                  : `<button class="danger session-revoke" data-session-id="${escapeHtml(s.id)}">${t("pv.sessions.revoke")}</button>`}
              </li>
            `).join("")}
          </ul>`;
  return `
    <div class="settings-section">
      <h3>${t("pv.sessions.title")}</h3>
      <small class="settings-hint">
        ${t("pv.sessions.hint")}
      </small>
      ${sessionsBlock}
    </div>
    <div class="settings-section">
      <h3>${t("pv.logoutall.title")}</h3>
      <small class="settings-hint">
        ${t("pv.logoutall.hint")}
      </small>
      <div class="admin-actions">
        <button id="privacy-logout-all" class="danger">${t("pv.logoutall.title")}</button>
      </div>
    </div>
    <div class="settings-section">
      <h3>${t("pv.export.title")}</h3>
      <small class="settings-hint">
        ${t("pv.export.hint")}
      </small>
    </div>
  `;
}

function attachSettingsPrivacyHandlers(): void {
  if (state.modal !== "settings" || state.settings.tab !== "privacy") return;
  rootEl.querySelectorAll<HTMLButtonElement>(".session-revoke").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const sid = btn.dataset.sessionId;
      if (!sid) return;
      const ok = await confirmDialog({
        title: "Завершить сеанс",
        body: "Refresh-токен этой сессии будет отозван. Устройство выйдет из аккаунта.",
        confirmLabel: "Завершить",
        danger: true
      });
      if (!ok) return;
      try {
        await httpClient.del(`/api/v1/users/me/sessions/${sid}`);
        _sessions = (_sessions ?? []).filter((s) => s.id !== sid);
        render();
      } catch (err) {
        _sessionsError = describeError(err);
        render();
      }
    });
  });
  rootEl.querySelector<HTMLButtonElement>("#privacy-logout-all")?.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Выйти со всех устройств?",
      body: "Все сессии кроме текущей будут завершены.",
      confirmLabel: "Выйти со всех",
      danger: true
    });
    if (!ok) return;
    try {
      const resp = await httpClient.post<{ revoked: number }>("/api/v1/auth/logout-all", {});
      _sessions = (_sessions ?? []).filter((s) => s.current);
      setTransientStatus(`Завершено сеансов: ${resp.revoked}`);
      render();
    } catch (err) {
      _sessionsError = describeError(err);
      render();
    }
  });
}

// I.2: state для рендера voice-таба и lifecycle тестов микрофона/камеры.
// Девайсы кешируются в `_settingsDevices` после первого enumerateDevices() —
// иначе при каждом render() слайдер дёргался бы новым промисом. Тест-стримы
// и AudioContext живут в модуль-локалках чтобы их можно было корректно
// потушить при закрытии модалки.
let _settingsDevices: EnumeratedDevices | null = null;
let _settingsDevicesLoading = false;
let _micTestStream: MediaStream | null = null;
let _micTestAudioCtx: AudioContext | null = null;
let _micTestAnalyser: AnalyserNode | null = null;
let _micTestRaf: number | null = null;
let _camTestStream: MediaStream | null = null;
let _settingsVoiceSubscribed = false;

function ensureSettingsDevicesLoaded(): void {
  if (_settingsDevicesLoading || _settingsDevices) return;
  _settingsDevicesLoading = true;
  enumerateVoiceDevices()
    .then((d) => {
      _settingsDevices = d;
    })
    .catch(() => {
      _settingsDevices = { audioInputs: [], audioOutputs: [], videoInputs: [] };
    })
    .finally(() => {
      _settingsDevicesLoading = false;
      if (state.modal === "settings" && state.settings.tab === "voice") render();
    });
}

// Любое изменение voiceSettings (например, юзер свайпнул output-volume —
// мы это сохраняем сразу) должно подтянуть громкость на active <video>
// без полного render() (он порвал бы юзер-controls).
function ensureVoiceSettingsSubscribed(): void {
  if (_settingsVoiceSubscribed) return;
  _settingsVoiceSubscribed = true;
  subscribeVoiceSettings(() => {
    // setSinkId/volume применятся при следующем attachVoiceVideoStreams.
    // Если активного звонка нет — нечего обновлять.
    attachVoiceVideoStreams();
  });
}

function stopMicTest(): void {
  if (_micTestRaf !== null) {
    cancelAnimationFrame(_micTestRaf);
    _micTestRaf = null;
  }
  _micTestAnalyser?.disconnect();
  _micTestAnalyser = null;
  if (_micTestAudioCtx) {
    void _micTestAudioCtx.close();
    _micTestAudioCtx = null;
  }
  if (_micTestStream) {
    for (const t of _micTestStream.getTracks()) t.stop();
    _micTestStream = null;
  }
}

function stopCamTest(): void {
  if (_camTestStream) {
    for (const t of _camTestStream.getTracks()) t.stop();
    _camTestStream = null;
  }
}

// Вызывается из attachSettingsHandlers когда модалка закрыта или таб
// сменился — иначе тесты бы продолжали жрать микрофон/камеру в фоне.
function stopVoiceTestsIfNotActive(): void {
  if (state.modal !== "settings" || state.settings.tab !== "voice") {
    stopMicTest();
    stopCamTest();
  }
}

function renderSettingsVoiceTab(): string {
  ensureSettingsDevicesLoaded();
  ensureVoiceSettingsSubscribed();
  const s = getVoiceSettings();
  const devices = _settingsDevices;
  const sinkSupported = typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === "function";
  const micTesting = _micTestStream !== null;
  const camTesting = _camTestStream !== null;
  const needPerm = !devices ||
    (devices.audioInputs.length === 0 && devices.videoInputs.length === 0) ||
    devices.audioInputs.some((d) => !d.label);

  const audioInOptions = renderDeviceOptions(devices?.audioInputs ?? [], s.audioInputId);
  const audioOutOptions = renderDeviceOptions(devices?.audioOutputs ?? [], s.audioOutputId);
  const videoInOptions = renderDeviceOptions(devices?.videoInputs ?? [], s.videoInputId);

  return `
    <div class="settings-section">
      <h3>${t("vs.voice.title")}</h3>
      <div class="settings-row">
        <label for="vs-audio-in">${t("vs.mic")}</label>
        <select id="vs-audio-in" class="settings-select">
          <option value="">${t("vs.sysdefault.m")}</option>
          ${audioInOptions}
        </select>
      </div>
      <div class="settings-row">
        <label for="vs-audio-out">${t("vs.speakers")}</label>
        <select id="vs-audio-out" class="settings-select" ${sinkSupported ? "" : "disabled"}>
          <option value="">${t("vs.sysdefault.m")}</option>
          ${audioOutOptions}
        </select>
        ${sinkSupported
          ? ""
          : `<small class="settings-hint">${t("vs.nosink")}</small>`}
      </div>
      <div class="settings-row settings-row-slider">
        <label for="vs-mic-gain">${t("vs.micgain")}</label>
        <div class="settings-slider-wrap">
          <input id="vs-mic-gain" type="range" min="0" max="200" step="1" value="${Math.round(s.micGain * 100)}" />
          <span id="vs-mic-gain-val" class="settings-slider-val">${Math.round(s.micGain * 100)}%</span>
        </div>
        <small class="settings-hint">${t("vs.micgain.hint")}</small>
      </div>
      <div class="settings-row settings-row-slider">
        <label for="vs-out-vol">${t("vs.outvol")}</label>
        <div class="settings-slider-wrap">
          <input id="vs-out-vol" type="range" min="0" max="100" step="1" value="${Math.round(s.outputVolume * 100)}" />
          <span id="vs-out-vol-val" class="settings-slider-val">${Math.round(s.outputVolume * 100)}%</span>
        </div>
      </div>
      <div class="settings-row">
        <button id="vs-test-mic" class="${micTesting ? "danger" : "primary"}">
          ${micTesting ? t("vs.mictest.stop") : t("vs.mictest.start")}
        </button>
        <div class="vs-meter ${micTesting ? "active" : ""}">
          <div id="vs-meter-fill" class="vs-meter-fill"></div>
        </div>
      </div>
      ${needPerm && !micTesting
        ? `<small class="settings-hint">${t("vs.needperm")}</small>`
        : ""}
    </div>

    <div class="settings-section">
      <h3>${t("vs.cam.title")}</h3>
      <div class="settings-row">
        <label for="vs-video-in">${t("vs.cam.device")}</label>
        <select id="vs-video-in" class="settings-select">
          <option value="">${t("vs.sysdefault.n")}</option>
          ${videoInOptions}
        </select>
      </div>
      <div class="settings-row">
        <label>${t("vs.cam.res")}</label>
        <div class="settings-radio-group">
          ${(["360p", "720p", "1080p"] as CameraResolution[])
            .map(
              (r) => `
            <label class="settings-radio">
              <input type="radio" name="vs-res" value="${r}" ${s.cameraResolution === r ? "checked" : ""} />
              <span>${r}</span>
            </label>
          `
            )
            .join("")}
        </div>
        <small class="settings-hint">${t("vs.cam.res.hint")}</small>
      </div>
      <div class="settings-row">
        <label>${t("vs.cam.effect")}</label>
        <div class="settings-radio-group">
          ${([["none", t("vs.cam.effect.none")], ["blur-light", t("vs.cam.effect.blurLight")], ["blur-strong", t("vs.cam.effect.blurStrong")]] as [CameraEffect, string][])
            .map(
              ([v, label]) => `
            <label class="settings-radio">
              <input type="radio" name="vs-cam-effect" value="${v}" ${s.cameraEffect === v ? "checked" : ""} />
              <span>${label}</span>
            </label>
          `
            )
            .join("")}
        </div>
        <small class="settings-hint">${t("vs.cam.effect.hint")}</small>
      </div>
      <div class="settings-row">
        <button id="vs-test-cam" class="${camTesting ? "danger" : "primary"}">
          ${camTesting ? t("vs.camtest.stop") : t("vs.camtest.start")}
        </button>
      </div>
      <video id="vs-cam-preview" class="vs-cam-preview" autoplay muted playsinline ${camTesting ? "" : "hidden"}></video>
    </div>

    <div class="settings-section">
      <h3>${t("vs.ptt.title")}</h3>
      <label class="settings-check">
        <input type="checkbox" id="vs-ptt-enable" ${s.pushToTalk ? "checked" : ""} />
        <span>${t("vs.ptt.enable")}</span>
      </label>
      <small class="settings-hint">
        ${t("vs.ptt.hint", { link: `<a href="#" data-settings-tab="hotkeys">${t("vs.ptt.hotkeys_link")}</a>` })}
      </small>
      <div class="settings-row settings-row-slider" ${s.pushToTalk ? "" : 'style="opacity:0.5;pointer-events:none"'}>
        <label for="vs-ptt-delay">${t("vs.ptt.delay")}</label>
        <div class="settings-slider-wrap">
          <input id="vs-ptt-delay" type="range" min="0" max="2000" step="50" value="${s.pttReleaseDelay}" />
          <span id="vs-ptt-delay-val" class="settings-slider-val">${t("vs.ptt.delay.ms", { v: s.pttReleaseDelay })}</span>
        </div>
        <small class="settings-hint">${t("vs.ptt.delay.hint")}</small>
      </div>
    </div>

    <div class="settings-section">
      <h3>${t("vs.denoise.title")}</h3>
      ${renderDenoiserBlock(s)}
    </div>

    <div class="settings-section">
      <h3>${t("vs.advanced.title")}</h3>
      <label class="settings-check">
        <input type="checkbox" id="vs-ec" ${s.echoCancellation ? "checked" : ""} />
        <span>${t("vs.ec")}</span>
      </label>
      <label class="settings-check">
        <input type="checkbox" id="vs-agc" ${s.autoGainControl ? "checked" : ""} />
        <span>${t("vs.agc")}</span>
      </label>
    </div>
  `;
}

// I.3 + N.2/N.4: блок выбора режима шумоподавления. Опции:
// - off               — никакого NS, голос идёт «как есть» (полезно для
//                       музыкальных стримов / гитары — браузерный NS режет
//                       обертоны).
// - browser           — нативный WebRTC-стек Chromium (NS3). Дефолт.
//                       Хорошо чистит вентилятор/клавиатуру/эхо.
// - rucord            — RNNoise (ML) через AudioWorklet, denoiser.ts.
//                       Слайдер интенсивности = dry/wet микс.
// - rucord-aggressive — нативный NS + RNNoise на 100% поверх; для сложных
//                       шумов (кафе, улица, открытое окно).
//
// Slider intensity 0-100 виден всегда, но активен только для rucord:
// browser-NS не принимает intensity, aggressive всегда работает на 100%.
// Смена режима применяется со следующего звонка; интенсивность — на лету.
function renderDenoiserBlock(s: VoiceSettings): string {
  const modes: { id: DenoiserMode; label: string; sub: string }[] = [
    { id: "off", label: t("vs.dn.off"), sub: t("vs.dn.off.sub") },
    { id: "browser", label: t("vs.dn.browser"), sub: t("vs.dn.browser.sub") },
    { id: "rucord", label: t("vs.dn.rucord"), sub: t("vs.dn.rucord.sub") },
    { id: "rucord-aggressive", label: t("vs.dn.aggr"), sub: t("vs.dn.aggr.sub") }
  ];
  const intensityActive = s.denoiserMode === "rucord";
  const radios = modes
    .map((m) => {
      const checked = s.denoiserMode === m.id ? "checked" : "";
      return `
        <label class="vs-denoiser-option ${s.denoiserMode === m.id ? "active" : ""}">
          <input type="radio" name="vs-denoiser" value="${m.id}" ${checked} />
          <div class="vs-denoiser-option-body">
            <div class="vs-denoiser-option-head">
              <span class="vs-denoiser-option-label">${escapeHtml(m.label)}</span>
            </div>
            <div class="vs-denoiser-option-sub">${escapeHtml(m.sub)}</div>
          </div>
        </label>
      `;
    })
    .join("");
  return `
    <div class="vs-denoiser-list">${radios}</div>
    <div class="settings-row settings-row-slider">
      <label for="vs-denoiser-intensity">${t("vs.dn.intensity")}</label>
      <div class="settings-slider-wrap">
        <input id="vs-denoiser-intensity" type="range" min="0" max="100" step="1"
               value="${s.denoiserIntensity}" ${intensityActive ? "" : "disabled"} />
        <span id="vs-denoiser-intensity-val" class="settings-slider-val">${s.denoiserIntensity}%</span>
      </div>
      <small class="settings-hint">
        ${intensityActive ? t("vs.dn.intensity.active") : t("vs.dn.intensity.inactive")}
      </small>
    </div>
  `;
}

function renderDeviceOptions(devices: MediaDeviceInfo[], selectedId: string | null): string {
  return devices
    .map((d, i) => {
      const label = d.label || t("vs.device_n", { n: i + 1 });
      const selected = d.deviceId === selectedId ? " selected" : "";
      return `<option value="${escapeHtml(d.deviceId)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

async function startMicTest(): Promise<void> {
  if (_micTestStream) return;
  try {
    _micTestStream = await navigator.mediaDevices.getUserMedia({ audio: buildAudioConstraints() });
  } catch (err) {
    state.status = describeError(err);
    render();
    return;
  }
  const AudioCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  _micTestAudioCtx = new AudioCtor();
  const source = _micTestAudioCtx.createMediaStreamSource(_micTestStream);
  _micTestAnalyser = _micTestAudioCtx.createAnalyser();
  _micTestAnalyser.fftSize = 256;
  source.connect(_micTestAnalyser);
  const buf = new Uint8Array(_micTestAnalyser.frequencyBinCount);
  const loop = () => {
    if (!_micTestAnalyser) return;
    _micTestAnalyser.getByteFrequencyData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i];
    const avg = sum / buf.length / 255; // 0..1
    const fill = rootEl.querySelector<HTMLDivElement>("#vs-meter-fill");
    if (fill) fill.style.width = `${Math.min(100, avg * 200)}%`;
    _micTestRaf = requestAnimationFrame(loop);
  };
  _micTestRaf = requestAnimationFrame(loop);
  // Освежим имена устройств — теперь labels доступны.
  _settingsDevices = null;
  ensureSettingsDevicesLoaded();
  render();
}

async function startCamTest(): Promise<void> {
  if (_camTestStream) return;
  try {
    _camTestStream = await navigator.mediaDevices.getUserMedia({ video: buildVideoConstraints() });
  } catch (err) {
    state.status = describeError(err);
    render();
    return;
  }
  _settingsDevices = null;
  ensureSettingsDevicesLoaded();
  render();
  // srcObject ставим post-render, иначе element ещё не в DOM.
  requestAnimationFrame(() => {
    const v = rootEl.querySelector<HTMLVideoElement>("#vs-cam-preview");
    if (v && _camTestStream) v.srcObject = _camTestStream;
  });
}

function attachSettingsVoiceHandlers(): void {
  if (state.modal !== "settings" || state.settings.tab !== "voice") return;

  rootEl.querySelector<HTMLSelectElement>("#vs-audio-in")?.addEventListener("change", (e) => {
    updateVoiceSettings({ audioInputId: (e.currentTarget as HTMLSelectElement).value || null });
  });
  rootEl.querySelector<HTMLSelectElement>("#vs-audio-out")?.addEventListener("change", (e) => {
    updateVoiceSettings({ audioOutputId: (e.currentTarget as HTMLSelectElement).value || null });
  });
  rootEl.querySelector<HTMLSelectElement>("#vs-video-in")?.addEventListener("change", (e) => {
    updateVoiceSettings({ videoInputId: (e.currentTarget as HTMLSelectElement).value || null });
  });

  // Слайдеры: live-update value-label без render() (иначе слетит pointer-capture).
  const micGain = rootEl.querySelector<HTMLInputElement>("#vs-mic-gain");
  micGain?.addEventListener("input", () => {
    const pct = Number(micGain.value);
    const label = rootEl.querySelector<HTMLSpanElement>("#vs-mic-gain-val");
    if (label) label.textContent = `${pct}%`;
    updateVoiceSettings({ micGain: pct / 100 });
  });
  const outVol = rootEl.querySelector<HTMLInputElement>("#vs-out-vol");
  outVol?.addEventListener("input", () => {
    const pct = Number(outVol.value);
    const label = rootEl.querySelector<HTMLSpanElement>("#vs-out-vol-val");
    if (label) label.textContent = `${pct}%`;
    updateVoiceSettings({ outputVolume: pct / 100 });
  });

  rootEl.querySelectorAll<HTMLInputElement>('input[name="vs-res"]').forEach((r) => {
    r.addEventListener("change", () => {
      if (r.checked) updateVoiceSettings({ cameraResolution: r.value as CameraResolution });
    });
  });

  // Wave 9: эффект камеры (размытие фона). Применится при следующем
  // включении камеры — активные треки не пересобираем.
  rootEl.querySelectorAll<HTMLInputElement>('input[name="vs-cam-effect"]').forEach((r) => {
    r.addEventListener("change", () => {
      if (r.checked) updateVoiceSettings({ cameraEffect: r.value as CameraEffect });
    });
  });

  rootEl.querySelector<HTMLInputElement>("#vs-ec")?.addEventListener("change", (e) => {
    updateVoiceSettings({ echoCancellation: (e.currentTarget as HTMLInputElement).checked });
  });
  rootEl.querySelector<HTMLInputElement>("#vs-agc")?.addEventListener("change", (e) => {
    updateVoiceSettings({ autoGainControl: (e.currentTarget as HTMLInputElement).checked });
  });
  // I.9: PTT-режим. Включение — auto-mute активные сессии (если PTT не зажат
  // сейчас). Выключение — оставляем mute как есть, юзер сам разрулит.
  rootEl.querySelector<HTMLInputElement>("#vs-ptt-enable")?.addEventListener("change", (e) => {
    const enabled = (e.currentTarget as HTMLInputElement).checked;
    updateVoiceSettings({ pushToTalk: enabled });
    // applyPttModeToActiveSessions сам открывает/закрывает гейт по флагу.
    applyPttModeToActiveSessions();
    updatePttIndicator();
    render(); // toggle меняет disabled-state слайдера задержки
  });
  const pttDelay = rootEl.querySelector<HTMLInputElement>("#vs-ptt-delay");
  pttDelay?.addEventListener("input", () => {
    const ms = Number(pttDelay.value) | 0;
    const label = rootEl.querySelector<HTMLSpanElement>("#vs-ptt-delay-val");
    if (label) label.textContent = t("vs.ptt.delay.ms", { v: ms });
    updateVoiceSettings({ pttReleaseDelay: ms });
  });
  // I.3: denoiser-режим (radio-кнопки) + intensity-слайдер.
  rootEl.querySelectorAll<HTMLInputElement>('input[name="vs-denoiser"]').forEach((r) => {
    r.addEventListener("change", () => {
      if (r.checked) {
        updateVoiceSettings({ denoiserMode: r.value as DenoiserMode });
        render(); // intensity-slider дисэйблится/включается → перерисуем
      }
    });
  });
  const intensity = rootEl.querySelector<HTMLInputElement>("#vs-denoiser-intensity");
  intensity?.addEventListener("input", () => {
    const pct = Number(intensity.value);
    const label = rootEl.querySelector<HTMLSpanElement>("#vs-denoiser-intensity-val");
    if (label) label.textContent = `${pct}%`;
    updateVoiceSettings({ denoiserIntensity: pct });
  });

  rootEl.querySelector<HTMLButtonElement>("#vs-test-mic")?.addEventListener("click", () => {
    if (_micTestStream) {
      stopMicTest();
      render();
    } else {
      void startMicTest();
    }
  });
  rootEl.querySelector<HTMLButtonElement>("#vs-test-cam")?.addEventListener("click", () => {
    if (_camTestStream) {
      stopCamTest();
      render();
    } else {
      void startCamTest();
    }
  });

  // На re-render с активным cam-test — переподцепить srcObject (innerHTML
  // нового тэга чистый).
  if (_camTestStream) {
    const v = rootEl.querySelector<HTMLVideoElement>("#vs-cam-preview");
    if (v && v.srcObject !== _camTestStream) v.srcObject = _camTestStream;
  }
}

function renderSettingsProfileTab(): string {
  const me = state.me;
  if (!me) return "";
  const editing = state.profileEdit.field;
  const pe = state.profileEdit;
  // I.6(b): live-preview — при editing подменяем поле в profile-card-head
  // на текущий draft. Юзер сразу видит как профиль будет выглядеть
  // для других, не уходя из настроек.
  const previewDisplayName = editing === "displayName" && pe.draftDisplayName.trim()
    ? pe.draftDisplayName.trim()
    : (me.displayName || me.username);
  const previewBio = editing === "bio" ? pe.draftBio : (me.bio ?? "");
  const previewBannerColor = editing === "bannerColor" ? pe.draftBannerColor : (me.bannerColor ?? "");
  // I.6: баннер — либо image (banner_media_id), либо solid-цвет
  // (banner_color), либо дефолтный gradient. data-banner-media для
  // lazy-load (тот же mediaBlobCache, что для аватаров). Если редактируем
  // bannerColor — игнорим banner_media_id и показываем live solid-цвет.
  const useMedia = me.bannerMediaId && editing !== "bannerColor";
  const bannerStyle = useMedia
    ? "" // image приедет через data-banner-media
    : previewBannerColor
      ? `background: ${escapeHtml(previewBannerColor)};`
      : "";
  const bannerAttrs = useMedia ? ` data-banner-media="${escapeHtml(me.bannerMediaId)}"` : "";
  return `
    <div class="profile-card-head">
      <div class="profile-banner-area" style="${bannerStyle}"${bannerAttrs}>
        <div class="profile-banner-actions">
          <button id="profile-banner-upload" class="ghost profile-banner-btn" data-tooltip="${t("pf.banner.upload")}">
            ${icon("pencil", { size: 14 })}
          </button>
          ${me.bannerMediaId
            ? `<button id="profile-banner-remove" class="ghost profile-banner-btn" data-tooltip="${t("pf.banner.remove")}">${icon("trash", { size: 14 })}</button>`
            : ""}
        </div>
      </div>
      <input id="profile-banner-input" type="file" accept="image/*" hidden />
      <div class="profile-card-avatar-wrap">
        ${renderAvatar({
          avatarMediaId: me.avatarMediaId,
          fallbackText: previewDisplayName,
          sizePx: 96,
          className: "profile-card-avatar",
          decoration: profileStyleDraft ? (profileStyleDraft.decoration || undefined) : me.avatarDecoration
        })}
        <button id="profile-avatar-upload" class="profile-card-avatar-edit" data-tooltip="${t("pf.avatar.change")}">
          ${icon("pencil", { size: 14 })}
        </button>
        ${me.avatarMediaId
          ? `<button id="profile-avatar-remove" class="profile-card-avatar-remove" data-tooltip="${t("pf.avatar.remove")}">${icon("trash", { size: 12 })}</button>`
          : ""}
      </div>
      <div class="profile-card-name">
        <div class="profile-card-display">${escapeHtml(previewDisplayName)}</div>
        <div class="profile-card-username">@${escapeHtml(me.username)}</div>
      </div>
      ${previewBio
        ? `<div class="profile-card-bio-preview">${renderBody(previewBio)}</div>`
        : ""}
    </div>
    <div class="profile-card-fields">
      ${renderProfileField({
        label: t("pf.displayname"),
        value: me.displayName || "—",
        field: "displayName",
        editing: editing === "displayName",
        body: renderProfileEditDisplayName(me.displayName ?? "")
      })}
      ${renderProfileField({
        label: t("pf.bio"),
        value: me.bio || "—",
        field: "bio",
        editing: editing === "bio",
        body: renderProfileEditBio()
      })}
      ${renderProfileField({
        label: t("pf.bannercolor"),
        value: me.bannerColor || t("ap.accent.default"),
        field: "bannerColor",
        editing: editing === "bannerColor",
        body: renderProfileEditBannerColor()
      })}
      ${renderProfileField({
        label: t("pf.username"),
        value: "@" + me.username,
        field: "username",
        editing: false,
        disabled: true,
        disabledHint: t("pf.username.hint"),
        body: ""
      })}
      ${renderProfileField({
        label: t("pf.email"),
        value: me.email,
        field: "email",
        editing: false,
        disabled: true,
        disabledHint: t("pf.email.hint"),
        body: ""
      })}
      ${renderProfileField({
        label: t("pf.password"),
        value: "••••••••",
        field: "password",
        editing: editing === "password",
        body: renderProfileEditPassword()
      })}
    </div>
    ${renderProfileStyleSection(me, previewDisplayName)}
    ${renderProfileWidgetsSection()}
  `;
}

// Wave 7 (I.13): редактор виджетов профиля. Draft — module-level (как
// profileStyleDraft): инпуты пишут без render(), кнопки порядка/удаления —
// с render(). Сохранение — полная замена через PUT /users/me/widgets.
let widgetsDraft: ProfileWidget[] | null = null;
let widgetsLoading = false;
let widgetsSaving = false;

function renderProfileWidgetsSection(): string {
  const rows = widgetsDraft === null
    ? `<div class="settings-hint">${t("common.loading")}</div>`
    : widgetsDraft.length === 0
      ? `<div class="settings-hint" style="margin:8px 0">${t("pw.empty")}</div>`
      : widgetsDraft.map((w, i) => `
          <div class="widget-edit-row">
            <span class="profile-widget-icon">${widgetIcon(w.url)}</span>
            <input type="text" maxlength="48" placeholder="${t("pw.name.ph")}" value="${escapeHtml(w.label)}" data-widget-label="${i}" class="widget-edit-label" />
            <input type="text" maxlength="300" placeholder="https://…" value="${escapeHtml(w.url)}" data-widget-url="${i}" class="widget-edit-url" />
            <button class="ghost" data-widget-up="${i}" data-tooltip="${t("pw.up")}" ${i === 0 ? "disabled" : ""}>↑</button>
            <button class="ghost" data-widget-down="${i}" data-tooltip="${t("pw.down")}" ${i === (widgetsDraft?.length ?? 0) - 1 ? "disabled" : ""}>↓</button>
            <button class="ghost danger" data-widget-remove="${i}" data-tooltip="${t("common.delete")}">✕</button>
          </div>
        `).join("");
  const canAdd = (widgetsDraft?.length ?? 0) < 8;
  return `
    <div class="settings-section profile-widgets-section">
      <h3>${t("pw.title")}</h3>
      <small class="settings-hint">
        ${t("pw.hint")}
      </small>
      ${rows}
      <div class="admin-actions">
        ${canAdd && widgetsDraft !== null ? `<button id="pw-add" class="ghost">${t("pw.add")}</button>` : ""}
        ${widgetsDraft !== null ? `<button id="pw-save" class="primary" ${widgetsSaving ? "disabled" : ""}>${widgetsSaving ? t("common.saving") : t("pw.save")}</button>` : ""}
      </div>
    </div>
  `;
}

async function loadMyWidgets(): Promise<void> {
  if (widgetsLoading || !state.me) return;
  widgetsLoading = true;
  try {
    const data = await httpClient.get<{ items: ProfileWidget[] }>(`/api/v1/users/${state.me.id}/widgets`);
    widgetsDraft = data.items ?? [];
  } catch {
    widgetsDraft = [];
  } finally {
    widgetsLoading = false;
    render();
  }
}

async function saveMyWidgets(): Promise<void> {
  if (!widgetsDraft) return;
  // Пустые строки молча выкидываем — юзер добавил ряд и передумал.
  const cleaned = widgetsDraft.filter((w) => w.label.trim() !== "" || w.url.trim() !== "");
  widgetsSaving = true;
  render();
  try {
    const data = await httpClient.put<{ items: ProfileWidget[] }>("/api/v1/users/me/widgets", {
      widgets: cleaned.map((w) => ({ kind: w.kind, label: w.label.trim(), url: w.url.trim() }))
    });
    widgetsDraft = data.items ?? [];
    setTransientStatus("Виджеты сохранены");
  } catch (err) {
    state.status = describeError(err);
  } finally {
    widgetsSaving = false;
    render();
  }
}

// Wave 7 (I.17–I.19): секция «Стиль профиля». Draft живёт в module-level
// profileStyleDraft (а не state) — input'ы пишут в него без render(),
// чтобы не терять фокус; сбрасывается при закрытии настроек и после save.
interface ProfileStyleDraft {
  themeOn: boolean;
  themeA: string;
  themeB: string;
  gradOn: boolean;
  gradA: string;
  gradB: string;
  badgeEmoji: string;
  badgeLabel: string;
  // I.15–I.16: id пресета либо "" (без рамки/эффекта).
  decoration: string;
  effect: string;
}

let profileStyleDraft: ProfileStyleDraft | null = null;
let profileStyleSaving = false;

function styleDraftFromMe(me: Me): ProfileStyleDraft {
  const theme = parseGradient(me.profileTheme);
  const grad = parseGradient(me.nameGradient);
  return {
    themeOn: !!theme,
    themeA: theme?.[0] ?? "#1e1f22",
    themeB: theme?.[1] ?? "#5865f2",
    gradOn: !!grad,
    gradA: grad?.[0] ?? "#5865f2",
    gradB: grad?.[1] ?? "#eb459e",
    badgeEmoji: me.badgeEmoji ?? "",
    badgeLabel: me.badgeLabel ?? "",
    decoration: me.avatarDecoration ?? "",
    effect: me.profileEffect ?? ""
  };
}

function ensureStyleDraft(): ProfileStyleDraft {
  if (!profileStyleDraft && state.me) profileStyleDraft = styleDraftFromMe(state.me);
  return profileStyleDraft ?? styleDraftFromMe({ badgeEmoji: "", badgeLabel: "" } as Me);
}

function renderProfileStyleSection(me: Me, previewName: string): string {
  const sd = profileStyleDraft ?? styleDraftFromMe(me);
  const gradPreviewStyle = sd.gradOn
    ? ` style="background:linear-gradient(90deg,${escapeHtml(sd.gradA)},${escapeHtml(sd.gradB)});-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:600;"`
    : ` style="font-weight:600;"`;
  return `
    <div class="settings-section profile-style-section">
      <h3>${t("ps.title")}</h3>
      <small class="settings-hint">
        ${t("ps.hint")}
      </small>
      <div class="profile-style-row">
        <label class="settings-check">
          <input type="checkbox" id="ps-theme-on" ${sd.themeOn ? "checked" : ""} />
          <span>${t("ps.theme")}</span>
        </label>
        <input type="color" id="ps-theme-a" value="${escapeHtml(sd.themeA)}" ${sd.themeOn ? "" : "disabled"} />
        <input type="color" id="ps-theme-b" value="${escapeHtml(sd.themeB)}" ${sd.themeOn ? "" : "disabled"} />
      </div>
      <div class="profile-style-row">
        <label class="settings-check">
          <input type="checkbox" id="ps-grad-on" ${sd.gradOn ? "checked" : ""} />
          <span>${t("ps.grad")}</span>
        </label>
        <input type="color" id="ps-grad-a" value="${escapeHtml(sd.gradA)}" ${sd.gradOn ? "" : "disabled"} />
        <input type="color" id="ps-grad-b" value="${escapeHtml(sd.gradB)}" ${sd.gradOn ? "" : "disabled"} />
        <span id="ps-grad-preview" class="profile-style-preview"${gradPreviewStyle}>${escapeHtml(previewName)}</span>
      </div>
      <div class="profile-style-row">
        <span class="profile-style-label">${t("ps.badge")}</span>
        <input type="text" id="ps-badge-emoji" maxlength="8" placeholder="🦄" value="${escapeHtml(sd.badgeEmoji)}" class="profile-style-emoji" />
        <input type="text" id="ps-badge-label" maxlength="48" placeholder="${t("ps.badge.label.ph")}" value="${escapeHtml(sd.badgeLabel)}" class="profile-style-badge-label" />
      </div>
      <div class="profile-style-row">
        <span class="profile-style-label">${t("ps.deco")}</span>
        <select id="ps-decoration" class="perm-select">
          <option value="">${t("ps.deco.none")}</option>
          ${AVATAR_DECORATIONS.map((d) => `<option value="${d.id}" ${sd.decoration === d.id ? "selected" : ""}>${escapeHtml(t(`deco.${d.id}`))}</option>`).join("")}
        </select>
        <span class="profile-style-deco-preview avatar-pic${sd.decoration ? ` avatar-deco-${escapeHtml(sd.decoration)}` : ""}" style="width:28px;height:28px;font-size:13px;"><span class="avatar-letter">${escapeHtml((me.displayName || me.username || "?").charAt(0).toUpperCase())}</span></span>
      </div>
      <div class="profile-style-row">
        <span class="profile-style-label">${t("ps.fx")}</span>
        <select id="ps-effect" class="perm-select">
          <option value="">${t("ps.fx.none")}</option>
          ${PROFILE_EFFECTS.map((e) => `<option value="${e.id}" ${sd.effect === e.id ? "selected" : ""}>${escapeHtml(t(`fx.${e.id}`))}</option>`).join("")}
        </select>
        <small class="settings-hint" style="margin:0">${t("ps.fx.hint")}</small>
      </div>
      <div class="admin-actions">
        <button id="ps-style-save" class="primary" ${profileStyleSaving ? "disabled" : ""}>
          ${profileStyleSaving ? t("common.saving") : t("ps.save")}
        </button>
      </div>
    </div>
  `;
}

async function saveProfileStyle(): Promise<void> {
  const sd = profileStyleDraft ?? (state.me ? styleDraftFromMe(state.me) : null);
  if (!sd || !state.me) return;
  profileStyleSaving = true;
  render();
  try {
    const updated = await httpClient.put<Me>("/api/v1/users/me", {
      profileTheme: sd.themeOn ? `${sd.themeA},${sd.themeB}` : "",
      nameGradient: sd.gradOn ? `${sd.gradA},${sd.gradB}` : "",
      badgeEmoji: sd.badgeEmoji.trim(),
      badgeLabel: sd.badgeLabel.trim(),
      avatarDecoration: sd.decoration,
      profileEffect: sd.effect
    });
    state.me = {
      ...state.me,
      profileTheme: updated.profileTheme,
      nameGradient: updated.nameGradient,
      badgeEmoji: updated.badgeEmoji,
      badgeLabel: updated.badgeLabel,
      avatarDecoration: updated.avatarDecoration,
      profileEffect: updated.profileEffect
    };
    // Своё имя в чате/сайдбаре рисуется из state.members — обновим локально,
    // не дожидаясь user.updated/refetch'а.
    state.members = state.members.map((m) =>
      m.userId === state.me?.id
        ? {
            ...m,
            profileTheme: updated.profileTheme,
            nameGradient: updated.nameGradient,
            badgeEmoji: updated.badgeEmoji,
            badgeLabel: updated.badgeLabel,
            avatarDecoration: updated.avatarDecoration,
            profileEffect: updated.profileEffect
          }
        : m
    );
    profileStyleDraft = null;
    setTransientStatus("Стиль профиля сохранён");
  } catch (err) {
    state.status = describeError(err);
  } finally {
    profileStyleSaving = false;
    render();
  }
}

function renderProfileEditBio(): string {
  const pe = state.profileEdit;
  const errBlock = pe.error ? `<div class="modal-error">${escapeHtml(pe.error)}</div>` : "";
  const remaining = 600 - pe.draftBio.length;
  return `
    <textarea id="profile-bio-input" maxlength="600" rows="4"
              placeholder="${t("pf.bio.ph")}">${escapeHtml(pe.draftBio)}</textarea>
    <div class="profile-field-hint" style="text-align:right;">${t("pf.bio.chars", { n: remaining })}</div>
    ${errBlock}
    <div class="profile-field-actions">
      <button class="ghost" data-profile-cancel>${t("common.cancel")}</button>
      <button id="profile-bio-save" class="primary" ${pe.saving ? "disabled" : ""}>
        ${pe.saving ? t("common.saving") : t("common.save")}
      </button>
    </div>
  `;
}

function renderProfileEditBannerColor(): string {
  const pe = state.profileEdit;
  const errBlock = pe.error ? `<div class="modal-error">${escapeHtml(pe.error)}</div>` : "";
  const colorValue = pe.draftBannerColor || "#5865f2";
  return `
    <div class="settings-slider-wrap" style="gap:12px; align-items:center;">
      <input id="profile-banner-color-input" type="color" value="${escapeHtml(colorValue)}" />
      <span id="profile-banner-color-val" class="settings-slider-val" style="min-width:120px;">${escapeHtml(pe.draftBannerColor || t("ap.accent.default"))}</span>
      <button id="profile-banner-color-clear" class="ghost" data-tooltip="${t("pf.clear")}">${icon("x", { size: 14 })}</button>
    </div>
    <small class="profile-field-hint">${t("pf.bannercolor.hint")}</small>
    ${errBlock}
    <div class="profile-field-actions">
      <button class="ghost" data-profile-cancel>${t("common.cancel")}</button>
      <button id="profile-banner-color-save" class="primary" ${pe.saving ? "disabled" : ""}>
        ${pe.saving ? t("common.saving") : t("common.save")}
      </button>
    </div>
  `;
}

function attachSettingsHandlers(): void {
  // I.2: тушим mic/cam тесты как только модалка закрылась или таб сменился —
  // вызываем безусловно (не только когда modal=settings), чтобы при закрытии
  // модалки стримы освобождались.
  stopVoiceTestsIfNotActive();
  // I.10: при закрытии модалки сбрасываем sessions-кеш, чтобы следующее
  // открытие privacy-таба перетянуло актуальный список.
  if (state.modal !== "settings") {
    _sessions = null;
    _sessionsError = null;
    profileStyleDraft = null;
    widgetsDraft = null;
    return;
  }
  // Wave 7 (I.13): редактор виджетов. Ленивая загрузка своих виджетов при
  // первом рендере профиль-таба.
  if (state.settings.tab === "profile" && widgetsDraft === null && !widgetsLoading) {
    void loadMyWidgets();
  }
  rootEl.querySelectorAll<HTMLInputElement>("[data-widget-label]").forEach((inp) => {
    inp.addEventListener("input", () => {
      const i = Number(inp.dataset.widgetLabel);
      if (widgetsDraft?.[i]) widgetsDraft[i].label = inp.value;
    });
  });
  rootEl.querySelectorAll<HTMLInputElement>("[data-widget-url]").forEach((inp) => {
    inp.addEventListener("input", () => {
      const i = Number(inp.dataset.widgetUrl);
      if (widgetsDraft?.[i]) widgetsDraft[i].url = inp.value;
    });
  });
  rootEl.querySelectorAll<HTMLButtonElement>("[data-widget-up]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.widgetUp);
      if (!widgetsDraft || i <= 0) return;
      [widgetsDraft[i - 1], widgetsDraft[i]] = [widgetsDraft[i], widgetsDraft[i - 1]];
      render();
    });
  });
  rootEl.querySelectorAll<HTMLButtonElement>("[data-widget-down]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.widgetDown);
      if (!widgetsDraft || i >= widgetsDraft.length - 1) return;
      [widgetsDraft[i], widgetsDraft[i + 1]] = [widgetsDraft[i + 1], widgetsDraft[i]];
      render();
    });
  });
  rootEl.querySelectorAll<HTMLButtonElement>("[data-widget-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.widgetRemove);
      if (!widgetsDraft) return;
      widgetsDraft.splice(i, 1);
      render();
    });
  });
  rootEl.querySelector<HTMLButtonElement>("#pw-add")?.addEventListener("click", () => {
    if (!widgetsDraft || widgetsDraft.length >= 8) return;
    widgetsDraft.push({ kind: "link", label: "", url: "" });
    render();
  });
  rootEl.querySelector<HTMLButtonElement>("#pw-save")?.addEventListener("click", () => {
    void saveMyWidgets();
  });
  // Wave 7: «Стиль профиля». Чекбоксы триггерят render() (надо включить/
  // выключить color-input'ы), цвета/текст пишут в draft без render(),
  // превью градиента обновляется прямым DOM-стилем.
  rootEl.querySelector<HTMLInputElement>("#ps-theme-on")?.addEventListener("change", (e) => {
    ensureStyleDraft().themeOn = (e.currentTarget as HTMLInputElement).checked;
    render();
  });
  rootEl.querySelector<HTMLInputElement>("#ps-grad-on")?.addEventListener("change", (e) => {
    ensureStyleDraft().gradOn = (e.currentTarget as HTMLInputElement).checked;
    render();
  });
  const updateGradPreview = (): void => {
    const sd = ensureStyleDraft();
    const prev = rootEl.querySelector<HTMLSpanElement>("#ps-grad-preview");
    if (!prev) return;
    if (sd.gradOn) {
      prev.style.background = `linear-gradient(90deg,${sd.gradA},${sd.gradB})`;
      prev.style.webkitBackgroundClip = "text";
      prev.style.backgroundClip = "text";
      prev.style.color = "transparent";
    }
  };
  rootEl.querySelector<HTMLInputElement>("#ps-theme-a")?.addEventListener("input", (e) => {
    ensureStyleDraft().themeA = (e.currentTarget as HTMLInputElement).value;
  });
  rootEl.querySelector<HTMLInputElement>("#ps-theme-b")?.addEventListener("input", (e) => {
    ensureStyleDraft().themeB = (e.currentTarget as HTMLInputElement).value;
  });
  rootEl.querySelector<HTMLInputElement>("#ps-grad-a")?.addEventListener("input", (e) => {
    ensureStyleDraft().gradA = (e.currentTarget as HTMLInputElement).value;
    updateGradPreview();
  });
  rootEl.querySelector<HTMLInputElement>("#ps-grad-b")?.addEventListener("input", (e) => {
    ensureStyleDraft().gradB = (e.currentTarget as HTMLInputElement).value;
    updateGradPreview();
  });
  rootEl.querySelector<HTMLInputElement>("#ps-badge-emoji")?.addEventListener("input", (e) => {
    ensureStyleDraft().badgeEmoji = (e.currentTarget as HTMLInputElement).value;
  });
  rootEl.querySelector<HTMLInputElement>("#ps-badge-label")?.addEventListener("input", (e) => {
    ensureStyleDraft().badgeLabel = (e.currentTarget as HTMLInputElement).value;
  });
  // I.15–I.16: селекты рамки/эффекта. render() — чтобы обновить превью
  // рамки рядом с селектом и на большом аватаре сверху.
  rootEl.querySelector<HTMLSelectElement>("#ps-decoration")?.addEventListener("change", (e) => {
    ensureStyleDraft().decoration = (e.currentTarget as HTMLSelectElement).value;
    render();
  });
  rootEl.querySelector<HTMLSelectElement>("#ps-effect")?.addEventListener("change", (e) => {
    ensureStyleDraft().effect = (e.currentTarget as HTMLSelectElement).value;
  });
  rootEl.querySelector<HTMLButtonElement>("#ps-style-save")?.addEventListener("click", () => {
    void saveProfileStyle();
  });
  rootEl.querySelectorAll<HTMLButtonElement>("[data-settings-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.settingsTab as SettingsTab | undefined;
      if (!tab) return;
      state.settings.tab = tab;
      state.profileEdit.field = null;
      state.profileEdit.error = null;
      state.profileEdit.okMessage = null;
      render();
    });
  });
  rootEl.querySelector<HTMLButtonElement>("#settings-logout-btn")?.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Выйти из аккаунта?",
      confirmLabel: "Выйти",
      danger: true
    });
    if (!ok) return;
    void httpClient.logout();
  });
  attachSettingsVoiceHandlers();
  attachSettingsHotkeysHandlers();
  attachSettingsAppearanceHandlers();
  attachSettingsNotificationsHandlers();
  attachSettingsPrivacyHandlers();
  attachSettingsServerHandlers();
  attachSettingsLanguageHandlers();
  attachSettingsSearchHandler();
}

function attachSettingsLanguageHandlers(): void {
  rootEl.querySelector<HTMLSelectElement>("#settings-locale")?.addEventListener("change", (e) => {
    const v = (e.currentTarget as HTMLSelectElement).value as Locale;
    setLocale(v);
    render();
  });
  rootEl.querySelectorAll<HTMLInputElement>('input[name="settings-time-format"]').forEach((r) => {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      setTimeFormat(r.value as TimeFormat);
      render();
    });
  });
}

// I.11: live-filter настроек. Прямой DOM-mutate без render() — иначе
// каждый ввод сорвал бы фокус и каретку из инпута. На клик по результату
// переключаем таб через render() и скроллим к h3 по textContent'у.
let _pendingSearchScroll: string | null = null;

function attachSettingsSearchHandler(): void {
  const input = rootEl.querySelector<HTMLInputElement>("#settings-search");
  const results = rootEl.querySelector<HTMLDivElement>("#settings-search-results");
  if (!input || !results) return;

  // I.11(a): подсвечивает первое вхождение query в label через <mark>.
  // Регистрация query одинаковая для матчинга и highlight — обе lowercased,
  // но индекс восстанавливаем по оригинальному label, чтобы не порушить cyrillic.
  const highlightLabel = (label: string, q: string): string => {
    const idx = label.toLowerCase().indexOf(q);
    if (idx < 0) return escapeHtml(label);
    return escapeHtml(label.slice(0, idx)) +
      `<mark>${escapeHtml(label.slice(idx, idx + q.length))}</mark>` +
      escapeHtml(label.slice(idx + q.length));
  };

  // I.11(b): индекс выделенной строки в dropdown'е. -1 = ничего не выделено.
  let activeIdx = -1;

  const updateActive = (): void => {
    const items = results.querySelectorAll<HTMLButtonElement>(".settings-search-item");
    items.forEach((el, i) => el.classList.toggle("active", i === activeIdx));
    if (activeIdx >= 0 && items[activeIdx]) {
      items[activeIdx].scrollIntoView({ block: "nearest" });
    }
  };

  const renderResults = (): void => {
    const q = input.value.trim().toLowerCase();
    state.settings.search = input.value;
    activeIdx = -1;
    if (q.length < 2) {
      results.hidden = true;
      results.innerHTML = "";
      return;
    }
    const matches = settingsSearchIndex().filter((e) => {
      const hay = (e.label + " " + (e.keywords ?? []).join(" ")).toLowerCase();
      return hay.includes(q);
    });
    if (matches.length === 0) {
      results.hidden = false;
      results.innerHTML = `<div class="settings-search-empty">${t("search.none")}</div>`;
      return;
    }
    results.hidden = false;
    results.innerHTML = matches
      .map((m) => {
        const tabLabel = findSettingsTab(m.tab).label;
        return `
          <button class="settings-search-item"
                  data-search-tab="${m.tab}"
                  data-search-anchor="${escapeHtml(m.label)}">
            <span class="settings-search-item-label">${highlightLabel(m.label, q)}</span>
            <span class="settings-search-item-tab">${escapeHtml(tabLabel)}</span>
          </button>
        `;
      })
      .join("");
    // Первая строка выделена по умолчанию — Enter сразу её выберет.
    activeIdx = 0;
    updateActive();
  };

  const selectActive = (): void => {
    const items = results.querySelectorAll<HTMLButtonElement>(".settings-search-item");
    const btn = activeIdx >= 0 ? items[activeIdx] : items[0];
    btn?.click();
  };

  input.addEventListener("input", renderResults);
  input.addEventListener("focus", renderResults);
  // setTimeout — даём click по результату сработать до того как dropdown скроется.
  input.addEventListener("blur", () => {
    setTimeout(() => {
      results.hidden = true;
    }, 150);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      state.settings.search = "";
      results.hidden = true;
      results.innerHTML = "";
      input.blur();
      return;
    }
    const items = results.querySelectorAll<HTMLButtonElement>(".settings-search-item");
    if (items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = (activeIdx + 1) % items.length;
      updateActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = (activeIdx - 1 + items.length) % items.length;
      updateActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectActive();
    }
  });

  results.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-search-tab]");
    if (!btn) return;
    const tab = btn.dataset.searchTab as SettingsTab | undefined;
    const anchor = btn.dataset.searchAnchor ?? "";
    if (!tab) return;
    state.settings.tab = tab;
    state.settings.search = "";
    _pendingSearchScroll = anchor;
    state.profileEdit.field = null;
    state.profileEdit.error = null;
    state.profileEdit.okMessage = null;
    render();
  });

  if (_pendingSearchScroll) {
    const anchor = _pendingSearchScroll;
    _pendingSearchScroll = null;
    requestAnimationFrame(() => {
      const body = rootEl.querySelector<HTMLDivElement>(".settings-content-body");
      if (!body) return;
      const target = Array.from(body.querySelectorAll("h3")).find(
        (h) => h.textContent?.trim() === anchor
      );
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      target.classList.add("settings-anchor-flash");
      setTimeout(() => target.classList.remove("settings-anchor-flash"), 1500);
    });
  }
}

interface ProfileFieldOpts {
  label: string;
  value: string;
  field: "displayName" | "username" | "email" | "password" | "bio" | "bannerColor";
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
    ? `<span class="profile-field-disabled" data-tooltip="${escapeHtml(opts.disabledHint ?? "")}">${t("pf.na")}</span>`
    : `<button class="ghost profile-field-edit" data-profile-edit="${opts.field}">${t("pf.edit")}</button>`;
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
           placeholder="${escapeHtml(currentValue || t("pf.displayname.ph"))}"
           value="${escapeHtml(pe.draftDisplayName)}" />
    ${errBlock}
    <div class="profile-field-actions">
      <button class="ghost" data-profile-cancel>${t("common.cancel")}</button>
      <button id="profile-display-save" class="primary" ${pe.saving ? "disabled" : ""}>
        ${pe.saving ? t("common.saving") : t("common.save")}
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
        <span class="profile-pw-label">${t("pf.pw.current")}</span>
        <input id="profile-pw-current" type="password" autocomplete="current-password" value="${escapeHtml(pe.currentPassword)}" />
      </label>
      <label>
        <span class="profile-pw-label">${t("pf.pw.new")}</span>
        <input id="profile-pw-new" type="password" autocomplete="new-password" minlength="8" value="${escapeHtml(pe.newPassword)}" />
      </label>
      <label>
        <span class="profile-pw-label">${t("pf.pw.confirm")}</span>
        <input id="profile-pw-confirm" type="password" autocomplete="new-password" minlength="8" value="${escapeHtml(pe.confirmPassword)}" />
      </label>
    </div>
    ${errBlock}
    ${okBlock}
    <div class="profile-field-actions">
      <button class="ghost" data-profile-cancel>${t("common.cancel")}</button>
      <button id="profile-pw-save" class="primary" ${pe.saving ? "disabled" : ""}>
        ${pe.saving ? t("common.saving") : t("pf.pw.save")}
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
          <h3>${t("modal.members")} · ${escapeHtml(ws.name)}</h3>
          <button class="ghost modal-close-btn" data-modal-close>✕</button>
        </div>
        <div class="modal-body">
          ${
            state.membersLoading
              ? `<div class="invites-empty">${t("common.loading")}</div>`
              : `<table class="members-table">
                  <thead><tr><th>${t("members.table.user")}</th><th>${t("members.table.role")}</th><th></th></tr></thead>
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
        ${!isSelf ? `<button class="ghost member-dm" data-user-id="${m.userId}" data-tooltip="Личное сообщение">${icon("reply")}</button>` : ""}
        ${showCall ? `<button class="ghost member-call" data-user-id="${m.userId}" data-tooltip="Позвонить">${icon("phone")}</button>` : ""}
        ${showKick ? `<button class="ghost member-kick" data-user-id="${m.userId}" data-tooltip="Удалить">${icon("trash")}</button>` : ""}
      </td>
    </tr>
  `;
}

// J.5(a): drag-reorder каналов и категорий. Поддержано:
//   - перетащить канал в пределах одной категории (изменяет position),
//   - перетащить канал в другую категорию (изменяет categoryId + position),
//   - перетащить категорию между категориями (изменяет position).
// Не поддерживается: пересортировка orphan-канала среди категорий (просто
// перетаскивай в категорию или после/до другого orphan-канала).
//
// Алгоритм: при drop берём целевой index в группе и переназначаем
// position для всех затронутых элементов как `(idx+1) * 100`. Это
// проще midpoint'ов и не страдает от collisions; зато на каждый drop
// идёт N PATCH-ов. Для воркспейса в 100 каналов это пренебрежимо
// мало (sidebar не моргает — обновление local-state-first).
let _dragKind: "channel" | "category" | null = null;
let _dragId: string | null = null;

function attachDragReorderHandlers(): void {
  // --- Channel drag ---
  rootEl.querySelectorAll<HTMLLIElement>('[data-ch][draggable="true"]').forEach((li) => {
    li.addEventListener("dragstart", (e) => {
      const id = li.dataset.ch;
      if (!id) return;
      _dragKind = "channel";
      _dragId = id;
      e.dataTransfer?.setData("text/plain", id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      li.classList.add("drag-source");
    });
    li.addEventListener("dragend", () => {
      _dragKind = null;
      _dragId = null;
      li.classList.remove("drag-source");
      rootEl.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
    });
    li.addEventListener("dragover", (e) => {
      if (_dragKind !== "channel") return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rect = li.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      li.classList.toggle("drop-after", after);
      li.classList.toggle("drop-before", !after);
    });
    li.addEventListener("dragleave", () => {
      li.classList.remove("drop-before", "drop-after");
    });
    li.addEventListener("drop", (e) => {
      if (_dragKind !== "channel" || !_dragId) return;
      e.preventDefault();
      const targetId = li.dataset.ch;
      const targetCatId = li.dataset.catId || null;
      const rect = li.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      li.classList.remove("drop-before", "drop-after");
      if (targetId && targetId !== _dragId) {
        void moveChannelTo(_dragId, targetCatId, targetId, after);
      }
    });
  });

  // --- Drop канала на заголовок категории = переместить канал в начало
  //     этой категории. ---
  rootEl.querySelectorAll<HTMLDivElement>("[data-cat-drag]").forEach((header) => {
    header.addEventListener("dragstart", (e) => {
      const id = header.dataset.catDrag;
      if (!id) return;
      _dragKind = "category";
      _dragId = id;
      e.dataTransfer?.setData("text/plain", id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      header.classList.add("drag-source");
    });
    header.addEventListener("dragend", () => {
      _dragKind = null;
      _dragId = null;
      header.classList.remove("drag-source");
      rootEl.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
    });
    header.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      if (_dragKind === "channel") {
        // Канал на категорию — подсветим целиком.
        header.classList.add("drop-after");
      } else if (_dragKind === "category") {
        const rect = header.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        header.classList.toggle("drop-after", after);
        header.classList.toggle("drop-before", !after);
      }
    });
    header.addEventListener("dragleave", () => {
      header.classList.remove("drop-before", "drop-after");
    });
    header.addEventListener("drop", (e) => {
      e.preventDefault();
      const targetCatId = header.dataset.catDrag;
      header.classList.remove("drop-before", "drop-after");
      if (!targetCatId || !_dragId) return;
      if (_dragKind === "channel") {
        void moveChannelTo(_dragId, targetCatId, null, false);
      } else if (_dragKind === "category" && _dragId !== targetCatId) {
        const rect = header.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        void moveCategoryTo(_dragId, targetCatId, after);
      }
    });
  });
}

async function moveChannelTo(
  channelId: string,
  newCategoryId: string | null,
  beforeChannelId: string | null,
  insertAfter: boolean
): Promise<void> {
  const ch = state.channels.find((c) => c.id === channelId);
  if (!ch) return;
  // Сначала optimistic: уберём из старого места, вставим в новое, renumber'нём
  // позиции в затронутых категориях. PATCH'и шлём в фоне.
  const oldCategoryId = ch.categoryId ?? null;
  // Все каналы целевой категории в текущем порядке.
  const targetSiblings = state.channels
    .filter((c) => (c.categoryId ?? null) === newCategoryId && c.id !== channelId)
    .sort((a, b) => a.position - b.position);
  let insertIdx: number;
  if (beforeChannelId) {
    insertIdx = targetSiblings.findIndex((c) => c.id === beforeChannelId);
    if (insertIdx < 0) insertIdx = targetSiblings.length;
    else if (insertAfter) insertIdx += 1;
  } else {
    insertIdx = 0;
  }
  const newOrder = [...targetSiblings.slice(0, insertIdx), ch, ...targetSiblings.slice(insertIdx)];
  // Renumber: position = (idx + 1) * 100.
  const updates: { id: string; position: number; categoryId?: string | null }[] = [];
  newOrder.forEach((c, idx) => {
    const newPos = (idx + 1) * 100;
    const needsUpdate = c.id === channelId
      ? c.position !== newPos || (c.categoryId ?? null) !== newCategoryId
      : c.position !== newPos;
    if (needsUpdate) {
      updates.push({
        id: c.id,
        position: newPos,
        categoryId: c.id === channelId ? newCategoryId : undefined
      });
    }
  });
  // Optimistic local update.
  state.channels = state.channels.map((c) => {
    if (c.id === channelId) {
      const newPos = (newOrder.indexOf(ch) + 1) * 100;
      return { ...c, categoryId: newCategoryId, position: newPos };
    }
    const u = updates.find((x) => x.id === c.id);
    if (u) return { ...c, position: u.position };
    return c;
  });
  // Если канал ушёл из старой категории, та категория тоже может потребовать renumber'а
  // (между бывшими соседями появилась "дыра", но позиции остаются монотонными — не страшно).
  void oldCategoryId;
  render();
  // PATCH-flush в фоне.
  for (const u of updates) {
    const body: Record<string, unknown> = { position: u.position };
    if (u.categoryId !== undefined) body.categoryId = u.categoryId ?? "";
    try {
      await httpClient.patch<Channel>(`/api/v1/channels/${u.id}`, body);
    } catch (err) {
      state.status = describeError(err);
      render();
      return;
    }
  }
}

async function moveCategoryTo(
  categoryId: string,
  targetCategoryId: string,
  insertAfter: boolean
): Promise<void> {
  const cats = [...state.categories].sort((a, b) => a.position - b.position);
  const fromIdx = cats.findIndex((c) => c.id === categoryId);
  if (fromIdx < 0) return;
  const [moved] = cats.splice(fromIdx, 1);
  let toIdx = cats.findIndex((c) => c.id === targetCategoryId);
  if (toIdx < 0) toIdx = cats.length;
  else if (insertAfter) toIdx += 1;
  cats.splice(toIdx, 0, moved);
  const updates: { id: string; position: number }[] = [];
  cats.forEach((c, idx) => {
    const newPos = (idx + 1) * 100;
    if (c.position !== newPos) updates.push({ id: c.id, position: newPos });
  });
  state.categories = cats.map((c, idx) => ({ ...c, position: (idx + 1) * 100 }));
  render();
  for (const u of updates) {
    try {
      await httpClient.patch<ChannelCategory>(`/api/v1/categories/${u.id}`, { position: u.position });
    } catch (err) {
      state.status = describeError(err);
      render();
      return;
    }
  }
}

function attachShellHandlers(): void {
  // J.3: NSFW gate — клик «Продолжить» сохраняет ack и перерисовывает чат-вид;
  // «Назад» сбрасывает выбранный канал.
  rootEl.querySelector<HTMLButtonElement>("#nsfw-accept")?.addEventListener("click", (e) => {
    const channelId = (e.currentTarget as HTMLButtonElement).dataset.channelId;
    if (!channelId) return;
    setNsfwAck(channelId);
    render();
  });
  rootEl.querySelector<HTMLButtonElement>("#nsfw-decline")?.addEventListener("click", () => {
    state.selectedChannelId = null;
    render();
  });

  rootEl.querySelector<HTMLButtonElement>("#profile-logout-btn")?.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Выйти из аккаунта?",
      confirmLabel: "Выйти",
      danger: true
    });
    if (!ok) return;
    void httpClient.logout();
  });

  rootEl.querySelector<HTMLButtonElement>("#open-profile")?.addEventListener("click", () => {
    state.modal = "settings";
    state.settings.tab = "profile";
    state.profileEdit.field = null;
    state.profileEdit.error = null;
    state.profileEdit.okMessage = null;
    render();
  });

  attachSettingsHandlers();

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
  rootEl.querySelector<HTMLSelectElement>("#audit-filter-target")?.addEventListener("change", (ev) => {
    state.auditFilter.targetType = (ev.currentTarget as HTMLSelectElement).value;
    render();
  });
  rootEl.querySelector<HTMLInputElement>("#audit-filter-actor")?.addEventListener("input", (ev) => {
    state.auditFilter.actor = (ev.currentTarget as HTMLInputElement).value;
    // Без render() — обновляем только список. Но фильтр живёт в state и
    // applyAuditFilter, поэтому надо ререндер. Каретку сохраняем через PRESERVED_INPUT_SELECTORS.
    render();
  });
  rootEl.querySelector<HTMLInputElement>("#audit-filter-from")?.addEventListener("change", (ev) => {
    state.auditFilter.from = (ev.currentTarget as HTMLInputElement).value;
    render();
  });
  rootEl.querySelector<HTMLInputElement>("#audit-filter-to")?.addEventListener("change", (ev) => {
    state.auditFilter.to = (ev.currentTarget as HTMLInputElement).value;
    render();
  });
  rootEl.querySelector<HTMLButtonElement>("#audit-filter-clear")?.addEventListener("click", () => {
    state.auditFilter = { action: "", actor: "", from: "", to: "", targetType: "" };
    render();
  });
  rootEl.querySelector<HTMLButtonElement>("#audit-export-full")?.addEventListener("click", () => {
    void exportAuditCsvFromServer();
  });
  rootEl.querySelector<HTMLButtonElement>("#audit-export-csv")?.addEventListener("click", () => {
    exportAuditCsv();
  });

  rootEl.querySelector<HTMLButtonElement>("#open-audit")?.addEventListener("click", async () => {
    state.modal = "audit";
    state.auditFilter = { action: "", actor: "", from: "", to: "", targetType: "" };
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

  // J.2: открытие настроек канала переехало на hover-кнопку
  // [data-ch-settings] прямо на канале в sidebar. Handler ниже
  // в блоке "[data-ch]"-обработчиков.
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

  rootEl.querySelector<HTMLButtonElement>("#open-pins")?.addEventListener("click", () => {
    const ch = state.selectedChannelId;
    if (!ch) return;
    togglePinsPopup(ch);
  });

  // Wave 9: форум. Открытие поста/родителя (карточка, breadcrumb) + модалка
  // «Новый пост».
  rootEl.querySelectorAll<HTMLElement>("[data-ch-open]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.chOpen;
      if (id) void selectChannel(id);
    });
  });
  rootEl.querySelector<HTMLButtonElement>("#forum-new-post")?.addEventListener("click", () => {
    const ch = state.selectedChannelId;
    if (!ch) return;
    state.createForumPost = { channelId: ch, title: "", body: "", saving: false, error: null };
    state.modal = "createForumPost";
    render();
    requestAnimationFrame(() => {
      rootEl.querySelector<HTMLInputElement>("#forum-post-title")?.focus();
    });
  });
  attachCreateForumPostHandlers();

  // #4a: кнопка звонка в DM-хедере. Тот же placeCall, что из профиля/member-list.
  rootEl.querySelector<HTMLButtonElement>("#dm-call")?.addEventListener("click", async (ev) => {
    const userId = (ev.currentTarget as HTMLButtonElement).dataset.userId;
    if (!userId) return;
    if (callMgr.isActive() || voiceMgr.isActive()) {
      setTransientStatus("Уже в звонке");
      return;
    }
    try {
      await callMgr.placeCall(userId);
      applyPttModeToActiveSessions();
    } catch (err) {
      state.status = describeError(err);
      render();
    }
  });

  rootEl.querySelectorAll<HTMLDivElement>(".pin-row[data-pin-jump]").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.pinJump;
      if (!id) return;
      state.pinsPopupOpen = false;
      render();
      // Если сообщение уже в message-list — скроллим к нему. Если нет —
      // (закреплено старое, за пределами окна) — открываем поиск/jump-to
      // по id. Пока минимум: только scroll если есть в DOM.
      requestAnimationFrame(() => {
        const el = rootEl.querySelector<HTMLDivElement>(`.message[data-id="${id}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("message-highlight");
          setTimeout(() => el.classList.remove("message-highlight"), 1500);
        } else {
          setTransientStatus("Сообщение выше истории — открой поиск для перехода");
        }
      });
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
      const ok = await confirmDialog({
        title: "Удалить участника",
        body: "Участник будет исключён из воркспейса. Его сообщения останутся.",
        confirmLabel: "Удалить",
        danger: true
      });
      if (!ok) return;
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
    // Wave 5: ПКМ по участнику — быстрые действия + назначение ролей.
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const userId = el.getAttribute("data-member-user");
      if (!userId) return;
      const x = Math.min(ev.clientX, window.innerWidth - 240);
      const y = Math.min(ev.clientY, window.innerHeight - 320);
      state.memberMenu = { userId, x, y };
      render();
    });
  });

  rootEl.querySelector<HTMLElement>("[data-member-menu-close]")?.addEventListener("click", () => {
    state.memberMenu = null;
    render();
  });

  // Wave 5 (J.5b): ПКМ по заголовку категории.
  rootEl.querySelectorAll<HTMLElement>("[data-cat-drag]").forEach((header) => {
    header.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const id = header.dataset.catDrag;
      if (!id) return;
      const x = Math.min(ev.clientX, window.innerWidth - 220);
      const y = Math.min(ev.clientY, window.innerHeight - 120);
      state.categoryMenu = { categoryId: id, x, y };
      render();
    });
  });
  rootEl.querySelector<HTMLElement>("[data-category-menu-close]")?.addEventListener("click", () => {
    state.categoryMenu = null;
    render();
  });
  rootEl.querySelectorAll<HTMLButtonElement>("[data-category-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.categoryAction;
      const id = btn.dataset.id;
      if (!action || !id) return;
      state.categoryMenu = null;
      if (action === "permissions") {
        void openCategoryPermissions(id);
        return;
      }
      if (action === "copy-id") {
        try {
          await navigator.clipboard.writeText(id);
          state.status = "ID категории скопирован";
        } catch {
          state.status = "Не удалось скопировать";
        }
        render();
        return;
      }
    });
  });
  // Wave 5: селекты в модалке прав категории.
  rootEl.querySelectorAll<HTMLSelectElement>(".cat-perm-select").forEach((sel) => {
    sel.addEventListener("change", () => {
      const key = sel.dataset.key;
      const action = sel.dataset.action;
      if (!key || !action) return;
      if (!state.categoryPerms.draft[key]) state.categoryPerms.draft[key] = {};
      state.categoryPerms.draft[key][action] = sel.value as "inherit" | "grant" | "deny";
    });
  });
  rootEl.querySelector<HTMLButtonElement>("#cat-perm-save")?.addEventListener("click", () => {
    void saveCategoryPermissions();
  });

  rootEl.querySelectorAll<HTMLButtonElement>("[data-member-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.memberAction;
      const userId = btn.dataset.id;
      if (!action || !userId) return;
      if (action === "profile") {
        state.memberMenu = null;
        openUserProfile(userId);
        return;
      }
      if (action === "dm") {
        state.memberMenu = null;
        void openDMWith({ userId });
        return;
      }
      if (action === "call") {
        state.memberMenu = null;
        render();
        try {
          await callMgr.placeCall(userId);
          applyPttModeToActiveSessions();
        } catch (err) {
          state.status = describeError(err);
          render();
        }
        return;
      }
      if (action === "copy-id") {
        state.memberMenu = null;
        try {
          await navigator.clipboard.writeText(userId);
          state.status = "ID участника скопирован";
        } catch {
          state.status = "Не удалось скопировать";
        }
        render();
        return;
      }
      if (action === "toggle-role") {
        // Меню НЕ закрываем — можно навесить несколько ролей подряд.
        const roleId = btn.dataset.roleId;
        const wsId = state.selectedWorkspaceId;
        const role = state.wsRoles.find((r) => r.id === roleId);
        if (!roleId || !wsId || !role) return;
        const has = role.memberUserIds.includes(userId);
        try {
          if (has) {
            await httpClient.del(`/api/v1/workspaces/${wsId}/roles/${roleId}/members/${userId}`);
            role.memberUserIds = role.memberUserIds.filter((x) => x !== userId);
          } else {
            await httpClient.post(`/api/v1/workspaces/${wsId}/roles/${roleId}/members/${userId}`);
            role.memberUserIds = [...role.memberUserIds, userId];
          }
          userColorCache = null;
        } catch (err) {
          state.status = describeError(err);
        }
        render();
        return;
      }
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
      applyPttModeToActiveSessions();
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
        applyPttModeToActiveSessions();
      } catch (err) {
        state.status = describeError(err);
        render();
      }
    });
  });

  rootEl.querySelector<HTMLButtonElement>("#call-accept")?.addEventListener("click", async () => {
    try {
      await callMgr.acceptIncoming();
      applyPttModeToActiveSessions();
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
    manualToggleMute();
  });
  rootEl.querySelector<HTMLButtonElement>("#call-deafen")?.addEventListener("click", () => {
    toggleDeafen();
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
      applyPttModeToActiveSessions();
    } catch (err) {
      state.status = describeError(err);
      render();
    }
  });
  // voice-кнопки могут существовать одновременно в room (content) и в
  // strip (sidebar) — навешиваем хэндлер на все.
  for (const btn of rootEl.querySelectorAll<HTMLButtonElement>("#voice-mute")) {
    btn.addEventListener("click", () => manualToggleMute());
  }
  for (const btn of rootEl.querySelectorAll<HTMLButtonElement>("#voice-deafen")) {
    btn.addEventListener("click", () => toggleDeafen());
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
    // K.4: Discord-pattern — двойной клик по voice-каналу сразу подключает.
    // Одиночный клик остаётся «peek» (открыть voice-room с участниками,
    // без join'а). Не-voice каналы dblclick игнорят.
    li.addEventListener("dblclick", async () => {
      const id = li.dataset.ch;
      if (!id) return;
      const ch = state.channels.find((c) => c.id === id);
      if (!ch || ch.kind !== "voice") return;
      const snap = voiceMgr.getSnapshot();
      if (snap.channelId === id && snap.state !== "leaving") return; // уже там
      try {
        await voiceMgr.join(id);
        applyPttModeToActiveSessions();
      } catch (err) {
        state.status = describeError(err);
        render();
      }
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
  attachDragReorderHandlers();

  // J.2: hover-кнопки на канале. stopPropagation, чтобы клик не съел
  // также `selectChannel`-handler на <li>.
  rootEl.querySelectorAll<HTMLButtonElement>("[data-ch-settings]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const id = btn.dataset.chSettings;
      if (!id) return;
      const ch = state.channels.find((c) => c.id === id);
      state.modal = "channelSettings";
      state.channelSettings = {
        channelId: id,
        tab: "overview",
        loading: true,
        saving: false,
        error: null,
        data: null,
        draft: {},
        userData: null,
        userDraft: {},
        overviewDraft: {
          name: ch?.name ?? "",
          topic: ch?.topic ?? "",
          slowMode: ch?.slowModeSeconds ?? 0,
          isNsfw: !!ch?.isNsfw,
          categoryId: ch?.categoryId ?? "",
          nameColor: ch?.nameColor ?? ""
        }
      };
      render();
      void loadChannelPermissions();
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

  // Wave 3: друзья — форма добавления, табы, действия per-row.
  rootEl.querySelector<HTMLFormElement>("#friend-add-form")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const input = rootEl.querySelector<HTMLInputElement>("#friend-add-input");
    const username = input?.value.trim().toLowerCase().replace(/^@/, "") ?? "";
    if (!username) return;
    if (input) input.value = "";
    void sendFriendRequest(username);
  });
  rootEl.querySelectorAll<HTMLButtonElement>("[data-friends-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.friendsTab = btn.dataset.friendsTab as FriendsTab;
      state.friendAddError = null;
      state.friendAddOk = null;
      render();
    });
  });
  rootEl.querySelectorAll<HTMLButtonElement>("[data-friend-accept]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void friendAction(btn.dataset.friendAccept!, "accept");
    });
  });
  rootEl.querySelectorAll<HTMLButtonElement>("[data-friend-remove]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void friendAction(btn.dataset.friendRemove!, "remove");
    });
  });
  rootEl.querySelectorAll<HTMLButtonElement>("[data-friend-remove-confirm]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const userId = btn.dataset.friendRemoveConfirm!;
      const ok = await confirmDialog({
        title: "Удалить из друзей",
        body: `Убрать ${describePeer(userId)} из друзей?`,
        confirmLabel: "Удалить",
        danger: true
      });
      if (ok) void friendAction(userId, "remove");
    });
  });
  rootEl.querySelectorAll<HTMLButtonElement>("[data-friend-unblock]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void friendAction(btn.dataset.friendUnblock!, "unblock");
    });
  });
  rootEl.querySelectorAll<HTMLButtonElement>("[data-friend-msg]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void openDMWith({ userId: btn.dataset.friendMsg! });
    });
  });
  rootEl.querySelectorAll<HTMLElement>("[data-friend-profile]").forEach((row) => {
    row.addEventListener("click", () => {
      openUserProfile(row.dataset.friendProfile!);
    });
  });
  // Collapse-плашка сообщения заблокированного — клик раскрывает.
  rootEl.querySelectorAll<HTMLElement>("[data-reveal-blocked]").forEach((el) => {
    el.addEventListener("click", () => {
      state.revealedBlocked.add(el.dataset.revealBlocked!);
      render();
    });
  });
  // Profile-popup: добавить в друзья / заблокировать.
  rootEl.querySelectorAll<HTMLButtonElement>("[data-friend-add]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void (async () => {
        try {
          await httpClient.post("/api/v1/friends/requests", { userId: btn.dataset.friendAdd });
          setTransientStatus("Заявка в друзья отправлена");
          await loadFriends();
        } catch (err) {
          state.status = describeError(err);
          render();
        }
      })();
    });
  });
  rootEl.querySelectorAll<HTMLButtonElement>("[data-friend-block]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const userId = btn.dataset.friendBlock!;
      const ok = await confirmDialog({
        title: "Заблокировать пользователя",
        body: `${describePeer(userId)} не сможет писать вам в ЛС и звонить, а его сообщения в общих каналах будут свёрнуты. Он об этом не узнает.`,
        confirmLabel: "Заблокировать",
        danger: true
      });
      if (ok) void friendAction(userId, "block");
    });
  });
  // Wave 3: приватная заметка в profile-popup. Кеш — чтобы re-render'ы
  // попапа не дёргали GET повторно; PUT на change (blur).
  const noteEl = rootEl.querySelector<HTMLTextAreaElement>("#user-note-input");
  if (noteEl) {
    const noteUserId = noteEl.dataset.noteUser!;
    if (userNoteCache.has(noteUserId)) {
      if (!noteEl.value) noteEl.value = userNoteCache.get(noteUserId)!;
    } else {
      userNoteCache.set(noteUserId, "");
      void httpClient
        .get<{ note: string }>(`/api/v1/users/${noteUserId}/note`)
        .then((res) => {
          userNoteCache.set(noteUserId, res.note ?? "");
          const fresh = rootEl.querySelector<HTMLTextAreaElement>(`#user-note-input[data-note-user="${CSS.escape(noteUserId)}"]`);
          if (fresh && !fresh.value) fresh.value = res.note ?? "";
        })
        .catch(() => {
          /* нет заметки/сети — оставляем пустую */
        });
    }
    noteEl.addEventListener("change", () => {
      const text = noteEl.value.trim();
      userNoteCache.set(noteUserId, text);
      void httpClient
        .put(`/api/v1/users/${noteUserId}/note`, { note: text })
        .then(() => setTransientStatus("Заметка сохранена"))
        .catch((err) => {
          state.status = describeError(err);
          render();
        });
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
      if (action === "notif") {
        const level = (btn.dataset.level ?? "") as NotifLevel | "";
        void setWorkspaceNotifLevel(id, level);
        return;
      }
      if (action === "remove-icon") {
        const ok = await confirmDialog({
          title: "Удалить иконку",
          body: `Удалить иконку воркспейса «${ws.name}»?`,
          confirmLabel: "Удалить",
          danger: true
        });
        if (!ok) {
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
      if (action === "archive" || action === "unarchive") {
        // Wave 8: soft-archive через PATCH. realtime channel.updated догонит
        // остальных клиентов; локально апдейтим ответом сразу.
        try {
          const updated = await httpClient.patch<Channel>(`/api/v1/channels/${id}`, {
            archived: action === "archive"
          });
          state.channels = state.channels.map((c) => (c.id === id ? updated : c));
        } catch (err) {
          state.status = describeError(err);
        }
        render();
        return;
      }
      if (action === "rename") {
        const nextRaw = await promptDialog({
          title: "Переименовать канал",
          label: "Новое имя",
          initial: ch.name,
          placeholder: "общая, voice, гейминг…"
        });
        const next = nextRaw?.trim();
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
        const ok = await confirmDialog({
          title: "Удалить канал",
          body: `История сообщений и вложения канала #${ch.name} удалятся безвозвратно.`,
          confirmText: ch.name,
          confirmLabel: "Удалить",
          danger: true
        });
        if (!ok) {
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

  rootEl.querySelector<HTMLButtonElement>("#update-install")?.addEventListener("click", () => {
    void startUpdateInstall();
  });

  rootEl.querySelector<HTMLButtonElement>("#ws-rail-create")?.addEventListener("click", async () => {
    const raw = await promptDialog({
      title: "Новый воркспейс",
      label: "Название",
      placeholder: "Моё сообщество"
    });
    const name = raw?.trim();
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
      realtimeClient.refreshSubscriptions();
      await selectWorkspace(ws.id);
    } catch (err) {
      state.status = describeError(err);
      render();
    }
  });

  rootEl.querySelector<HTMLButtonElement>("#ws-rail-invite")?.addEventListener("click", async () => {
    const raw = await promptDialog({
      title: "Принять приглашение",
      label: "Код инвайта",
      placeholder: "abc123…"
    });
    const code = raw?.trim();
    if (!code) return;
    try {
      const res = await httpClient.post<{ workspaceId: string; role: string; channelId?: string }>(
        `/api/v1/invites/${encodeURIComponent(code)}/accept`
      );
      await loadWorkspaces();
      realtimeClient.refreshSubscriptions();
      await selectWorkspace(res.workspaceId);
      // J.3(a): если инвайт был channel-scoped — открываем сразу нужный канал.
      if (res.channelId) {
        await selectChannel(res.channelId);
      }
      setTransientStatus("Вы вступили в воркспейс");
    } catch (err) {
      state.status = describeError(err);
      render();
    }
  });

  // J.5: «+ канал» внутри категории / orphan-блока. Открывает createChannel-
  // модалку с предзаполненным categoryId — пользователь сам выбирает kind
  // через radio в модалке (раньше kind определялся фиксированной hardcode-
  // секцией text/voice, теперь категории могут содержать оба типа).
  rootEl.querySelectorAll<HTMLButtonElement>(".ch-category-add[data-create-in-category]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      if (!state.selectedWorkspaceId) return;
      const catId = btn.dataset.createInCategory ?? null;
      openCreateChannelModal(state.selectedWorkspaceId, "text", catId);
    });
  });
  rootEl.querySelectorAll<HTMLButtonElement>(".ch-category-add[data-create-orphan]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      if (!state.selectedWorkspaceId) return;
      openCreateChannelModal(state.selectedWorkspaceId, "text", null);
    });
  });

  // J.5: workspace-dropdown — toggle на заголовок.
  rootEl.querySelector<HTMLButtonElement>("#open-ws-menu")?.addEventListener("click", (e) => {
    e.stopPropagation();
    state.workspaceMenuOpen = !state.workspaceMenuOpen;
    if (state.workspaceMenuOpen && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    render();
  });
  // Клик по любому пункту меню — закрываем и выполняем действие.
  rootEl.querySelectorAll<HTMLButtonElement>("[data-ws-menu]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const action = btn.dataset.wsMenu;
      const wsId = state.selectedWorkspaceId;
      if (!wsId) return;
      state.workspaceMenuOpen = false;
      if (action === "invite") {
        state.modal = "invites";
        render();
        await loadInvites();
        return;
      }
      if (action === "settings") {
        openWorkspaceSettings(wsId);
        return;
      }
      if (action === "create-channel") {
        openCreateChannelModal(wsId, "text", null);
        return;
      }
      if (action === "create-category") {
        render();
        await createCategoryFlow(wsId);
        return;
      }
      render();
    });
  });
  // Click-outside закрывает dropdown.
  if (state.workspaceMenuOpen) {
    const onOutside = (ev: MouseEvent): void => {
      const target = ev.target as HTMLElement | null;
      if (target?.closest(".ws-menu") || target?.closest("#open-ws-menu")) return;
      state.workspaceMenuOpen = false;
      document.removeEventListener("click", onOutside, true);
      render();
    };
    setTimeout(() => document.addEventListener("click", onOutside, true), 0);
  }

  // J.5: ⚙ управления категорией — выпадающее меню «Переименовать / Удалить».
  rootEl.querySelectorAll<HTMLButtonElement>(".ch-category-settings").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const catId = btn.dataset.categoryId;
      if (!catId) return;
      const cat = state.categories.find((c) => c.id === catId);
      if (!cat) return;
      const ok = await confirmDialog({
        title: `Категория «${cat.name}»`,
        body: "Что сделать?",
        confirmLabel: "Переименовать",
        cancelLabel: "Удалить"
      });
      if (ok) {
        // Переименовать
        const raw = await promptDialog({
          title: "Переименовать категорию",
          label: "Название",
          initial: cat.name
        });
        const name = raw?.trim();
        if (!name || name === cat.name) return;
        try {
          const updated = await httpClient.patch<ChannelCategory>(`/api/v1/categories/${cat.id}`, { name });
          state.categories = state.categories.map((c) => (c.id === updated.id ? updated : c));
          render();
        } catch (err) {
          state.status = describeError(err);
          render();
        }
      } else {
        // Удалить — typed-confirm на имя категории.
        const confirmed = await confirmDialog({
          title: "Удалить категорию",
          body: `Категория «${cat.name}» исчезнет, каналы переедут в «Без категории».`,
          confirmText: cat.name,
          confirmLabel: "Удалить",
          danger: true
        });
        if (!confirmed) return;
        try {
          await httpClient.del(`/api/v1/categories/${cat.id}`);
          state.categories = state.categories.filter((c) => c.id !== cat.id);
          state.channels = state.channels.map((ch) =>
            ch.categoryId === cat.id ? { ...ch, categoryId: null } : ch
          );
          render();
        } catch (err) {
          state.status = describeError(err);
          render();
        }
      }
    });
  });

  // J.6: toggle свёрнутости категории.
  rootEl.querySelectorAll<HTMLButtonElement>("[data-category-collapse]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const catId = btn.dataset.categoryCollapse;
      if (!catId) return;
      if (state.collapsedCategories.has(catId)) state.collapsedCategories.delete(catId);
      else state.collapsedCategories.add(catId);
      saveCollapsedCategories();
      render();
    });
  });
  // Wave 8: collapse-toggle блока «Архив».
  rootEl.querySelector<HTMLButtonElement>("[data-archive-collapse]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    try {
      localStorage.setItem(ARCHIVE_COLLAPSED_KEY, isArchiveCollapsed() ? "0" : "1");
    } catch {
      /* quota / disabled */
    }
    render();
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
      const ok = await confirmDialog({
        title: "Удалить сообщение?",
        body: "Сообщение будет помечено удалённым; отменить нельзя.",
        confirmLabel: "Удалить",
        danger: true
      });
      if (!ok) return;
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

  rootEl.querySelectorAll<HTMLButtonElement>(".action-pin").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      if (!id) return;
      const wasPinned = btn.dataset.pinned === "1";
      try {
        if (wasPinned) {
          await httpClient.del(`/api/v1/messages/${id}/pin`);
          setTransientStatus("Откреплено");
        } else {
          await httpClient.put(`/api/v1/messages/${id}/pin`);
          setTransientStatus("Закреплено");
        }
      } catch (err) {
        state.status = describeError(err);
        render();
      }
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

  // Wave 2: «➕» в quick-picker'е реакций → полный emoji-picker.
  rootEl.querySelectorAll<HTMLButtonElement>(".picker-more").forEach((btn) => {
    btn.addEventListener("click", () => {
      const messageId = btn.dataset.reactMore;
      if (!messageId) return;
      openEmojiPicker({
        anchor: btn,
        onPick: (emoji) => {
          state.pickerForMessageId = null;
          void toggleReaction(messageId, emoji);
        }
      });
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
    // Wave 2: lightbox по клику. Слоты пересоздаются каждым render()
    // (кроме restored через snapshot) — dataset-флаг защищает restored
    // от двойного binding'а.
    if (!slot.dataset.lbBound) {
      slot.dataset.lbBound = "1";
      slot.addEventListener("click", () => openImageLightbox(slot));
    }
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
  // I.14: GIF/APNG-аватары. gifStaticCache хранит первый кадр по media-url
  // (присутствие записи = «этот media анимированный»). Режим из I.5:
  // always — анимация всегда; hover — статичный кадр + анимация при
  // наведении; never — только статичный кадр.
  const fillAvatarSlot = (s: HTMLSpanElement, animUrl: string, staticUrl: string | null): void => {
    if (s.querySelector("img")) return;
    const mode = getAppearance().gifAvatars;
    const useStatic = staticUrl !== null && mode !== "always";
    s.insertAdjacentHTML("afterbegin", `<img class="avatar-img" src="${useStatic ? staticUrl : animUrl}" alt="" />`);
    if (staticUrl !== null && mode === "hover" && !s.dataset.gifBound) {
      s.dataset.gifBound = "1";
      s.addEventListener("mouseenter", () => {
        const img = s.querySelector<HTMLImageElement>(".avatar-img");
        if (img) img.src = animUrl;
      });
      s.addEventListener("mouseleave", () => {
        const img = s.querySelector<HTMLImageElement>(".avatar-img");
        if (img) img.src = staticUrl;
      });
    }
  };
  rootEl.querySelectorAll<HTMLSpanElement>(".avatar-pic.has-media").forEach((slot) => {
    const mediaId = slot.dataset.avatarMedia;
    if (!mediaId) return;
    if (slot.querySelector("img")) return;
    const url = `/api/v1/media/${mediaId}`;
    const cached = mediaBlobCache.get(url);
    if (cached) {
      fillAvatarSlot(slot, cached, gifStaticCache.get(url) ?? null);
      return;
    }
    void (async () => {
      try {
        const blob = await httpClient.getBlob(url);
        const blobUrl = URL.createObjectURL(blob);
        mediaBlobCache.set(url, blobUrl);
        let staticUrl: string | null = null;
        if (blob.type === "image/gif" || blob.type === "image/apng") {
          staticUrl = await extractFirstFrame(blob, blobUrl);
          if (staticUrl) gifStaticCache.set(url, staticUrl);
        }
        // Может быть несколько слотов с тем же media-id (мой аватар в
        // user-strip и в моих сообщениях). Заполним все.
        rootEl.querySelectorAll<HTMLSpanElement>(
          `.avatar-pic.has-media[data-avatar-media="${CSS.escape(mediaId)}"]`
        ).forEach((s) => fillAvatarSlot(s, blobUrl, staticUrl));
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

  // I.6: lazy-load баннер профиля. data-banner-media → blob через тот же
  // mediaBlobCache, вставляется как inline-background через style.
  rootEl.querySelectorAll<HTMLElement>("[data-banner-media]").forEach((slot) => {
    const mediaId = slot.dataset.bannerMedia;
    if (!mediaId) return;
    if (slot.dataset.bannerLoaded === mediaId) return;
    const url = `/api/v1/media/${mediaId}`;
    const apply = (blobUrl: string) => {
      slot.style.backgroundImage = `url("${blobUrl}")`;
      slot.style.backgroundSize = "cover";
      slot.style.backgroundPosition = "center";
      slot.dataset.bannerLoaded = mediaId;
    };
    const cached = mediaBlobCache.get(url);
    if (cached) {
      apply(cached);
      return;
    }
    void (async () => {
      try {
        const blob = await httpClient.getBlob(url);
        const blobUrl = URL.createObjectURL(blob);
        mediaBlobCache.set(url, blobUrl);
        rootEl.querySelectorAll<HTMLElement>(`[data-banner-media="${CSS.escape(mediaId)}"]`).forEach((s) => {
          if (s.dataset.bannerLoaded === mediaId) return;
          apply.call(null, blobUrl);
          s.style.backgroundImage = `url("${blobUrl}")`;
          s.style.backgroundSize = "cover";
          s.style.backgroundPosition = "center";
          s.dataset.bannerLoaded = mediaId;
        });
      } catch {
        /* fallback на bannerColor / default gradient */
      }
    })();
  });

  // mention-автокомплит: ловим `@<prefix>` перед каретой и показываем
  // popup. Все обновления — direct DOM, чтобы не дёргать render() и не
  // терять фокус/курсор в input'е (см. техдолг про инкрементальный апдейт).
  const composerInput = rootEl.querySelector<HTMLInputElement>('#send-form input[name="body"]');
  const mentionPopup = rootEl.querySelector<HTMLDivElement>("#mention-popup");
  // Wave 8: попап `#канал` — есть только в workspace-каналах (в DM нет).
  const channelPopup = rootEl.querySelector<HTMLDivElement>("#channel-popup");
  if (composerInput && mentionPopup) {
    composerInput.addEventListener("input", () => {
      saveDraft(state.selectedChannelId, composerInput.value);
      if (composerInput.value) maybeSendTyping();
      updateMentionPopup(composerInput, mentionPopup);
      if (channelPopup) updateChannelPopup(composerInput, channelPopup);
      updateSlashPopup(composerInput);
    });
    // Wave 2: кнопка-смайл рядом с send. Вставка по каретке + dispatch
    // input — чтобы draft сохранился и mention-popup пересчитался.
    rootEl.querySelector<HTMLButtonElement>("#composer-emoji")?.addEventListener("click", (ev) => {
      const anchor = ev.currentTarget as HTMLElement;
      openEmojiPicker({
        anchor,
        onPick: (emoji) => {
          const start = composerInput.selectionStart ?? composerInput.value.length;
          const end = composerInput.selectionEnd ?? start;
          composerInput.value = composerInput.value.slice(0, start) + emoji + composerInput.value.slice(end);
          const caret = start + emoji.length;
          composerInput.focus({ preventScroll: true });
          composerInput.setSelectionRange(caret, caret);
          composerInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
    });
    composerInput.addEventListener("click", () => {
      updateMentionPopup(composerInput, mentionPopup);
      if (channelPopup) updateChannelPopup(composerInput, channelPopup);
    });
    composerInput.addEventListener("keyup", (ev) => {
      // ArrowLeft/Right двигают каретку — пересчитаем токен. Стрелки
      // вверх/вниз и Enter обрабатываются на keydown ниже.
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight" || ev.key === "Home" || ev.key === "End") {
        updateMentionPopup(composerInput, mentionPopup);
        if (channelPopup) updateChannelPopup(composerInput, channelPopup);
      }
    });
    composerInput.addEventListener("keydown", (ev) => {
      // Edit прошлого своего сообщения по стрелке вверх (Discord/Slack):
      // пустой композер + ArrowUp + не активен mention-popup и не идёт edit.
      if (
        ev.key === "ArrowUp" &&
        composerInput.value === "" &&
        !state.editingMessageId &&
        (!state.mentionAutocomplete || mentionPopup.hidden) &&
        (!state.channelAutocomplete || !channelPopup || channelPopup.hidden)
      ) {
        if (tryEditLastOwnMessage()) {
          ev.preventDefault();
          return;
        }
      }
      // Wave 8: навигация по channel-попапу. Токены `@…` и `#…` взаимно
      // исключающие — активен максимум один попап.
      if (channelPopup && state.channelAutocomplete && !channelPopup.hidden) {
        const chMatches = filterChannelMatches(state.channelAutocomplete.query);
        if (chMatches.length > 0) {
          if (ev.key === "ArrowDown") {
            ev.preventDefault();
            state.channelAutocomplete.selectIndex = (state.channelAutocomplete.selectIndex + 1) % chMatches.length;
            renderChannelPopupContent(channelPopup, chMatches, state.channelAutocomplete.selectIndex);
            return;
          } else if (ev.key === "ArrowUp") {
            ev.preventDefault();
            state.channelAutocomplete.selectIndex =
              (state.channelAutocomplete.selectIndex - 1 + chMatches.length) % chMatches.length;
            renderChannelPopupContent(channelPopup, chMatches, state.channelAutocomplete.selectIndex);
            return;
          } else if (ev.key === "Enter" || ev.key === "Tab") {
            ev.preventDefault();
            applyChannelPick(composerInput, channelPopup, chMatches[state.channelAutocomplete.selectIndex].name);
            return;
          } else if (ev.key === "Escape") {
            ev.preventDefault();
            hideChannelPopup(channelPopup);
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
      setTimeout(() => {
        hideMentionPopup(mentionPopup);
        if (channelPopup) hideChannelPopup(channelPopup);
      }, 120);
    });
    mentionPopup.addEventListener("mousedown", (ev) => {
      const target = (ev.target as HTMLElement).closest<HTMLElement>("[data-mention-username]");
      if (!target) return;
      ev.preventDefault();
      applyMentionPick(composerInput, mentionPopup, target.dataset.mentionUsername!);
    });
    channelPopup?.addEventListener("mousedown", (ev) => {
      const target = (ev.target as HTMLElement).closest<HTMLElement>("[data-channel-pick]");
      if (!target) return;
      ev.preventDefault();
      applyChannelPick(composerInput, channelPopup, target.dataset.channelPick!);
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
        await httpClient.put("/api/v1/users/me", { displayName: slash.name });
        if (state.me) state.me = { ...state.me, displayName: slash.name };
        setTransientStatus(`Имя изменено на «${slash.name}»`);
      } catch (err) {
        state.status = describeError(err);
      }
      render();
      return;
    }
    const bodyToSend = slash.body;
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
        body: bodyToSend,
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
      // J.3(b): slow-mode 429 → сохраняем draft, ставим countdown.
      const slow = isSlowModeError(err);
      if (slow) {
        setSlowMode(channelIdSnapshot, slow.retry);
        setTransientStatus(`Медленный режим: подожди ${slow.retry}с`);
        input.value = body;
        saveDraft(channelIdSnapshot, body);
        state.pendingUploads = pendingSnapshot;
        state.replyingTo = replyingSnapshot;
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
          confirmLabel: "Отправить файл"
        });
        if (accepted) {
          state.status = "Отправка как файл…";
          render();
          try {
            const file = new File([body], "message.txt", { type: "text/plain" });
            const uploaded = await httpClient.uploadFile<PendingUpload>("/api/v1/uploads", file);
            const allAttachments = [...attachmentIds, uploaded.id];
            const created = await httpClient.post<Message>(
              `/api/v1/channels/${channelIdSnapshot}/messages`,
              {
                body: "",
                clientMessageId: crypto.randomUUID(),
                attachmentIds: allAttachments,
                replyToMessageId: replyingSnapshot?.messageId ?? undefined
              }
            );
            if (created && created.id && !state.messages.some((m) => m.id === created.id)) {
              state.messages = [
                ...state.messages,
                { ...created, reactions: created.reactions ?? {}, attachments: created.attachments ?? [] }
              ];
            }
            setTransientStatus("Отправлено как файл");
            return;
          } catch (fileErr) {
            state.status = describeError(fileErr);
            input.value = body;
            saveDraft(channelIdSnapshot, body);
            state.pendingUploads = pendingSnapshot;
            state.replyingTo = replyingSnapshot;
            render();
            return;
          }
        }
      }
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

  // Wave 10: «Тред» из сообщения. Endpoint идемпотентен: если тред уже
  // есть (гонка с другим клиентом) — бэк вернёт существующий, открываем его.
  rootEl.querySelectorAll<HTMLButtonElement>(".action-thread").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const messageId = btn.dataset.id;
      const channelId = state.selectedChannelId;
      if (!messageId || !channelId) return;
      try {
        const thread = await httpClient.post<Channel>(
          `/api/v1/channels/${channelId}/messages/${messageId}/thread`,
          {}
        );
        if (!state.channels.some((c) => c.id === thread.id)) {
          state.channels = [...state.channels, thread];
        }
        await selectChannel(thread.id);
      } catch (err) {
        state.status = describeError(err);
        render();
      }
    });
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
        return;
      }
      // Wave 8: клик по #channel-ссылке — переход в канал (включая архивные).
      const chLink = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-channel-link]");
      const chId = chLink?.dataset.channelLink;
      if (chId && chId !== state.selectedChannelId) {
        ev.stopPropagation();
        void selectChannel(chId);
      }
    });
  }
}

// Wave 2: плавающая date-пилюля при скролле (Discord-style). Показывает
// день верхней видимой границы, исчезает через 1.2с после остановки.
let stickyDateHideTimer: ReturnType<typeof setTimeout> | null = null;

function updateStickyDate(list: HTMLDivElement): void {
  const pill = rootEl.querySelector<HTMLElement>("#sticky-date");
  if (!pill) return;
  if (list.scrollTop < 20) {
    pill.hidden = true;
    return;
  }
  const listRect = list.getBoundingClientRect();
  let label: string | null = null;
  // Дивайдеров в окне немного (1 на день) — линейный проход дешёвый.
  for (const holder of Array.from(list.querySelectorAll<HTMLElement>(".day-divider"))) {
    if (holder.getBoundingClientRect().top <= listRect.top + 12) {
      label = holder.textContent?.trim() ?? null;
    } else {
      break;
    }
  }
  if (!label) {
    pill.hidden = true;
    return;
  }
  pill.textContent = label;
  pill.hidden = false;
  if (stickyDateHideTimer) clearTimeout(stickyDateHideTimer);
  stickyDateHideTimer = setTimeout(() => {
    pill.hidden = true;
  }, 1200);
}

function onMessageListScroll(e: Event): void {
  const list = e.currentTarget as HTMLDivElement;
  const bottomDistance = list.scrollHeight - list.scrollTop - list.clientHeight;
  state.stickToBottom = bottomDistance < 80;
  updateStickyDate(list);
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

// MentionOption — элемент попапа: реальный участник либо псевдо-пункт
// @everyone/@here (Wave 4). Псевдо-пункты не показываем в DM.
interface MentionOption {
  username: string;
  displayName?: string;
}

function filterMentionMatches(query: string): MentionOption[] {
  const q = query.toLowerCase();
  const meId = state.me?.id;
  const out: MentionOption[] = [];
  for (const m of state.members) {
    if (m.userId === meId) continue;
    if (!m.username.startsWith(q)) continue;
    out.push(m);
    if (out.length >= 8) break;
  }
  // @everyone/@here — в конце списка, только в workspace-каналах. Сервер
  // сам молча проигнорит пинг, если права message.mention_everyone нет.
  if (!state.dmMode) {
    if ("everyone".startsWith(q)) out.push({ username: "everyone", displayName: "Уведомить всех участников" });
    if ("here".startsWith(q)) out.push({ username: "here", displayName: "Уведомить участников онлайн" });
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

function renderMentionPopupContent(popup: HTMLDivElement, matches: MentionOption[], selectIndex: number): void {
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

// ---- channel popup (Wave 8) ------------------------------------------------
// `#<prefix>` перед кареткой → попап каналов текущего воркспейса, зеркалит
// mention-попап. Предлагаем только «линкуемые» имена (без пробелов) — иначе
// вставленный токен не превратился бы в ссылку в renderBody.

const CHANNEL_TOKEN_RE = /(?:^|\s)#([\p{L}\p{N}_-]{0,64})$/u;
const CHANNEL_LINKABLE_RE = /^[\p{L}\p{N}_-]{1,64}$/u;

function filterChannelMatches(query: string): Channel[] {
  const q = query.toLowerCase();
  const out: Channel[] = [];
  // Архивные тоже линкуются («доступен по прямой ссылке») — идут в конце.
  const ordered = [...state.channels].sort(
    (a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt) || a.name.localeCompare(b.name)
  );
  for (const ch of ordered) {
    if (!CHANNEL_LINKABLE_RE.test(ch.name)) continue;
    if (!ch.name.toLowerCase().startsWith(q)) continue;
    out.push(ch);
    if (out.length >= 8) break;
  }
  return out;
}

function updateChannelPopup(input: HTMLInputElement, popup: HTMLDivElement): void {
  const caret = input.selectionStart ?? input.value.length;
  const head = input.value.slice(0, caret);
  const m = head.match(CHANNEL_TOKEN_RE);
  if (!m) {
    hideChannelPopup(popup);
    return;
  }
  const query = m[1];
  const matches = filterChannelMatches(query);
  if (matches.length === 0) {
    hideChannelPopup(popup);
    return;
  }
  const prevIndex = state.channelAutocomplete?.selectIndex ?? 0;
  const selectIndex = Math.min(prevIndex, matches.length - 1);
  state.channelAutocomplete = { query, selectIndex };
  renderChannelPopupContent(popup, matches, selectIndex);
  popup.hidden = false;
}

function renderChannelPopupContent(popup: HTMLDivElement, matches: Channel[], selectIndex: number): void {
  popup.innerHTML = matches
    .map(
      (ch, i) => `<div class="mention-item${i === selectIndex ? " selected" : ""}" data-channel-pick="${escapeHtml(ch.name)}">
        <span class="mention-name">${channelPrefix(ch)}${escapeHtml(ch.name)}</span>
        ${ch.archivedAt ? `<span class="mention-sub">${t("sidebar.archive")}</span>` : ch.topic ? `<span class="mention-sub">${escapeHtml(ch.topic)}</span>` : ""}
      </div>`
    )
    .join("");
}

function hideChannelPopup(popup: HTMLDivElement): void {
  popup.hidden = true;
  popup.innerHTML = "";
  state.channelAutocomplete = null;
}

function applyChannelPick(input: HTMLInputElement, popup: HTMLDivElement, name: string): void {
  const caret = input.selectionStart ?? input.value.length;
  const head = input.value.slice(0, caret);
  const tail = input.value.slice(caret);
  const m = head.match(CHANNEL_TOKEN_RE);
  if (!m) return;
  const prefixLen = m[0].length - 1 - m[1].length;
  const startOfToken = head.length - m[0].length + prefixLen;
  const replacement = "#" + name + " ";
  input.value = input.value.slice(0, startOfToken) + replacement + tail;
  const newCaret = startOfToken + replacement.length;
  input.setSelectionRange(newCaret, newCaret);
  hideChannelPopup(popup);
  input.focus();
}

function describeError(err: unknown): string {
  const api = err as ApiError;
  if (api && typeof api === "object" && "code" in api && "message" in api) {
    // status 0: ответа не было (нет связи, таймаут). Код ошибки пользователю не нужен.
    if (api.status === 0) return api.message;
    return `${api.message} (${api.code})`;
  }
  if (err instanceof Error) return err.message;
  return "Неизвестная ошибка";
}

// Бэк-сигнал «body too long» (см. message/module.go) — единственная
// валидационная ошибка POST /messages, которую UX обрабатывает отдельно
// (предлагает отправить тело как .txt-вложение).
// J.3(b): slow-mode countdown. Когда message-create отдаёт 429 с Retry-After,
// записываем `Date.now() + retry*1000` в карту, композер показывает таймер
// и блокирует submit. Тикер обновляет UI раз в секунду пока есть активные
// каналы.
const _slowModeUntil = new Map<string, number>();
let _slowModeTickHandle: ReturnType<typeof setInterval> | null = null;

function slowModeRemainingSec(channelId: string): number {
  const until = _slowModeUntil.get(channelId);
  if (!until) return 0;
  const remaining = Math.ceil((until - Date.now()) / 1000);
  if (remaining <= 0) {
    _slowModeUntil.delete(channelId);
    return 0;
  }
  return remaining;
}

function setSlowMode(channelId: string, retryAfterSec: number): void {
  if (retryAfterSec <= 0) return;
  _slowModeUntil.set(channelId, Date.now() + retryAfterSec * 1000);
  ensureSlowModeTicker();
}

function ensureSlowModeTicker(): void {
  if (_slowModeTickHandle) return;
  _slowModeTickHandle = setInterval(() => {
    // Чистим истекшие, проверяем нужен ли ещё тикер.
    let active = false;
    for (const [chId, until] of _slowModeUntil) {
      if (until - Date.now() <= 0) _slowModeUntil.delete(chId);
      else active = true;
    }
    if (!active) {
      if (_slowModeTickHandle) clearInterval(_slowModeTickHandle);
      _slowModeTickHandle = null;
    }
    // Обновляем только composer-инпут (placeholder) и submit-кнопку без render() —
    // иначе сорвался бы фокус и каретка композера.
    const input = rootEl.querySelector<HTMLInputElement>('#send-form input[name="body"]');
    const submit = rootEl.querySelector<HTMLButtonElement>('#send-form button[type="submit"]');
    if (input && state.selectedChannelId) {
      const rem = slowModeRemainingSec(state.selectedChannelId);
      const ch = state.channels.find((c) => c.id === state.selectedChannelId);
      if (rem > 0) {
        input.placeholder = `Медленный режим: ${rem}с до следующего сообщения`;
        if (submit) submit.disabled = true;
      } else if (ch) {
        input.placeholder = `Сообщение в #${ch.name}`;
        if (submit) submit.disabled = false;
      }
    }
  }, 1000);
}

// J.3(b): slow-mode error от backend'а (429 + slow-mode reason). Backend
// ставит CodeRateLimited на конкретно slow-mode-422 (см. message.handleCreate).
function isSlowModeError(err: unknown): { retry: number } | null {
  const api = err as ApiError;
  if (!api || typeof api !== "object") return null;
  if (api.status !== 429) return null;
  if (api.code !== "rate_limited") return null;
  const msg = (api.message ?? "").toLowerCase();
  if (!msg.includes("slow mode")) return null;
  return { retry: api.retryAfter ?? 5 };
}

function isBodyTooLongError(err: unknown): boolean {
  const api = err as ApiError;
  if (!api || typeof api !== "object") return false;
  const msg = typeof api.message === "string" ? api.message.toLowerCase() : "";
  return msg.includes("body too long");
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(intlLocale(), { hour12: hour12Setting() });
}

// formatTimeSmartShort — «14:32». Используется как hover-метка в группе
// сообщений одного автора (Discord-pattern: первое сообщение группы
// показывает полную дату, последующие — только HH:MM при hover'е).
function formatTimeSmartShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit", hour12: hour12Setting() });
}

// formatTimeSmart — «Сегодня в 14:32» / «Вчера в 23:01» / «18.05.2026 в 14:32».
// Discord-pattern: timestamps в потоке сообщений и в notifications читаются
// глазом мгновенно, без перевода даты в голове.
//
// I.7: формат часов уважает getTimeFormat() (auto/h12/h24); локаль — intlLocale().
// Weekday и DMY также берут текущую локаль ru-RU/en-US. Сепаратор «в»/«at»
// — через t("time.today"/"time.yesterday") (для today/yesterday) и просто
// space-join для других дней (английский нативно говорит "Monday 14:32",
// без предлога).
function formatTimeSmart(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfMsgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfDay - startOfMsgDay) / 86400000);
  const locale = intlLocale();
  const h12 = hour12Setting();
  const hm = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: h12 });
  if (dayDiff === 0) return `${t("time.today")} ${hm}`;
  if (dayDiff === 1) return `${t("time.yesterday")} ${hm}`;
  if (dayDiff > 1 && dayDiff < 7) {
    const weekday = date.toLocaleDateString(locale, { weekday: "long" });
    return getLocale() === "en" ? `${weekday} ${hm}` : `${weekday} в ${hm}`;
  }
  const dmy = date.toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" });
  return getLocale() === "en" ? `${dmy} ${hm}` : `${dmy} в ${hm}`;
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
        ${numberField("storageQuotaBytes", "Квота хранилища, байт", "0 = безлимит")}
        ${numberField("messageRetentionDays", "Срок хранения сообщений, дни", "0 = бессрочно")}
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
      <button id="admin-ice-check" class="ghost" ${a.iceCheckRunning ? "disabled" : ""}>
        ${a.iceCheckRunning ? "Проверяю…" : "Проверить STUN/TURN"}
      </button>
    </div>
    ${a.retentionLast ? `
      <div class="admin-meta admin-retention-result">
        Удалено: ${a.retentionLast.messagesDeleted} сообщ., ${a.retentionLast.mediaDeleted} файлов
        (${formatBytesLarge(a.retentionLast.bytesFreed)})
      </div>
    ` : ""}
    ${renderIceCheckResult(a.iceCheckResult)}
  `;
}

// Wave 0: панель результата ICE/TURN-диагностики под метриками.
function renderIceCheckResult(r: IceCheckResult | null): string {
  if (!r) return "";
  const row = (ok: boolean, label: string, detail?: string) => `
    <div class="ice-check-row ${ok ? "ok" : "fail"}">
      <span class="ice-check-dot"></span>
      <span>${escapeHtml(label)}</span>
      ${detail ? `<span class="ice-check-detail">${escapeHtml(detail)}</span>` : ""}
    </div>
  `;
  if (r.error && r.serverUrls.length === 0) {
    return `<div class="ice-check-panel">${row(false, r.error)}</div>`;
  }
  const turnRow = !r.turnConfigured
    ? row(false, "TURN не сконфигурирован", "в /ice-servers нет turn:-URL — звонки между NAT не соединятся")
    : r.relayOk
      ? row(true, "TURN-релей работает", r.relayAddress ? `relay ${r.relayAddress}` : undefined)
      : row(false, "TURN не отвечает", "аллокация не прошла — проверь coturn, проброс портов (3478 + UDP relay-диапазон) и credentials");
  return `
    <div class="ice-check-panel">
      ${row(r.stunOk, r.stunOk ? "STUN работает (внешний адрес получен)" : "STUN не отвечает")}
      ${turnRow}
      ${r.error ? row(false, r.error) : ""}
      <div class="ice-check-meta">
        Серверы: ${escapeHtml(r.serverUrls.join(", ") || "—")} · ${(r.elapsedMs / 1000).toFixed(1)}с
      </div>
    </div>
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

  rootEl.querySelector<HTMLButtonElement>("#admin-retention-run")?.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Очистка по retention",
      body: "Старые сообщения и orphan-файлы будут удалены безвозвратно. Запустить сейчас?",
      confirmLabel: "Запустить",
      danger: true
    });
    if (!ok) return;
    void runRetentionSweep();
  });

  rootEl.querySelector<HTMLButtonElement>("#admin-ice-check")?.addEventListener("click", () => {
    void runAdminIceCheck();
  });
}

async function runAdminIceCheck(): Promise<void> {
  if (state.admin.iceCheckRunning) return;
  state.admin.iceCheckRunning = true;
  state.admin.iceCheckResult = null;
  render();
  try {
    state.admin.iceCheckResult = await runIceCheck(httpClient);
  } finally {
    state.admin.iceCheckRunning = false;
    render();
  }
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
      const reasonRaw = await promptDialog({
        title: "Бан пользователя",
        label: "Причина (необязательно)",
        placeholder: "будет показана в audit-логе",
        multiline: true
      });
      if (reasonRaw === null) return;
      const reason = reasonRaw.trim();
      await httpClient.post(`/api/v1/server/users/${userId}/ban`, reason ? { reason } : {});
    } else if (action === "unban") {
      await httpClient.post(`/api/v1/server/users/${userId}/unban`, {});
    } else if (action === "delete") {
      const ok = await confirmDialog({
        title: "Удалить пользователя",
        body: "Аккаунт, его сообщения и медиа исчезнут. Восстановить нельзя.",
        confirmLabel: "Удалить",
        danger: true
      });
      if (!ok) return;
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

// J.3: полноэкранная модалка настроек канала — 4 таба по образцу H.10.
// Tab «Обзор» — name/topic/slow-mode/NSFW (PATCH /channels/{id}).
// Tab «Права доступа» — старая permission-таблица.
// Tab «Приглашения» — placeholder.
// Tab «Удалить канал» — typed-confirm на имя.
const CHANNEL_SETTINGS_TABS: { id: ChannelSettingsTab; label: string; danger?: boolean }[] = [
  { id: "overview", label: "Обзор" },
  { id: "permissions", label: "Права доступа" },
  { id: "invites", label: "Приглашения" },
  { id: "delete", label: "Удалить канал", danger: true }
];

// Discord-парные значения slow-mode из спеки.
const SLOW_MODE_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Выключено" },
  { value: 5, label: "5 секунд" },
  { value: 10, label: "10 секунд" },
  { value: 15, label: "15 секунд" },
  { value: 30, label: "30 секунд" },
  { value: 60, label: "1 минута" },
  { value: 120, label: "2 минуты" },
  { value: 300, label: "5 минут" },
  { value: 600, label: "10 минут" },
  { value: 900, label: "15 минут" },
  { value: 1800, label: "30 минут" },
  { value: 3600, label: "1 час" }
];

function renderChannelSettingsModal(): string {
  const cs = state.channelSettings;
  const channel = state.channels.find((c) => c.id === cs.channelId);
  const title = channel
    ? `Настройки · ${channelPrefix(channel)} ${escapeHtml(channel.name)}`
    : "Настройки канала";
  const tabsHtml = CHANNEL_SETTINGS_TABS.map((t) => `
    <button class="ws-settings-tab ${cs.tab === t.id ? "active" : ""} ${t.danger ? "danger" : ""}"
            data-cs-tab="${t.id}">
      ${escapeHtml(t.label)}
    </button>
  `).join("");

  let body = "";
  if (cs.tab === "overview") body = renderChannelSettingsOverview();
  else if (cs.tab === "permissions") body = cs.loading
    ? `<div class="search-empty">Загрузка…</div>`
    : cs.data
      ? renderChannelPermissionsTable()
      : `<div class="search-empty">Нет данных</div>`;
  else if (cs.tab === "invites") body = renderChannelSettingsInvites();
  else if (cs.tab === "delete") body = renderChannelSettingsDelete();

  return `
    <div class="modal-backdrop" data-modal-close>
      <div class="modal modal-wide channel-settings-modal ws-settings" role="dialog">
        <div class="modal-header">
          <h3>${title}</h3>
          <div class="modal-header-actions">
            <button class="ghost modal-close-btn" data-modal-close>✕</button>
          </div>
        </div>
        ${cs.error ? `<div class="admin-error">${escapeHtml(cs.error)}</div>` : ""}
        <div class="ws-settings-shell">
          <aside class="ws-settings-tabs">${tabsHtml}</aside>
          <div class="ws-settings-body">${body}</div>
        </div>
      </div>
    </div>
  `;
}

function renderChannelSettingsOverview(): string {
  const cs = state.channelSettings;
  const draft = cs.overviewDraft;
  const channel = state.channels.find((c) => c.id === cs.channelId);
  if (!channel) return `<div class="search-empty">Канал не найден</div>`;
  const slowOpts = SLOW_MODE_OPTIONS
    .map((o) => `<option value="${o.value}" ${draft.slowMode === o.value ? "selected" : ""}>${escapeHtml(o.label)}</option>`)
    .join("");
  return `
    <div class="settings-section">
      <h3>Имя</h3>
      <input id="cs-name" type="text" maxlength="64" value="${escapeHtml(draft.name)}" placeholder="имя-канала" />
      <small class="settings-hint">1–64 символа. Изменение запостит system-сообщение в чат.</small>
    </div>
    <div class="settings-section">
      <h3>Тема канала</h3>
      <textarea id="cs-topic" maxlength="256" rows="2" placeholder="чем занимается канал…">${escapeHtml(draft.topic)}</textarea>
      <small class="settings-hint"><span id="cs-topic-counter">${draft.topic.length}</span>/256</small>
    </div>
    <div class="settings-section">
      <h3>Категория</h3>
      <select id="cs-category" class="settings-select">
        <option value="" ${draft.categoryId === "" ? "selected" : ""}>Без категории</option>
        ${[...state.categories]
          .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
          .map((c) => `<option value="${escapeHtml(c.id)}" ${draft.categoryId === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
          .join("")}
      </select>
      <small class="settings-hint">Группа в sidebar'е. Каналы без категории идут отдельным блоком сверху.</small>
    </div>
    <div class="settings-section">
      <h3>Цвет названия</h3>
      <div class="cs-color-row">
        <input id="cs-color" type="color" value="${escapeHtml(draft.nameColor || "#8e9297")}" />
        <button id="cs-color-reset" class="ghost" ${draft.nameColor ? "" : "disabled"}>Сбросить</button>
      </div>
      <small class="settings-hint">Цвет имени канала в списке слева. «Сбросить» вернёт цвет темы.</small>
    </div>
    <div class="settings-section">
      <h3>Медленный режим</h3>
      <select id="cs-slowmode" class="settings-select">${slowOpts}</select>
      <small class="settings-hint">
        Пауза между сообщениями одного автора. Модераторы (право «Удалять чужие сообщения») не затрагиваются.
      </small>
    </div>
    <div class="settings-section">
      <h3>18+ канал</h3>
      <label class="settings-check">
        <input type="checkbox" id="cs-nsfw" ${draft.isNsfw ? "checked" : ""} />
        <span>Контент 18+ — клиент покажет предупреждение при входе</span>
      </label>
      <small class="settings-hint">Per-channel подтверждение хранится локально в браузере участника.</small>
    </div>
    <div class="admin-actions">
      <button id="cs-overview-save" class="primary" ${cs.saving ? "disabled" : ""}>
        ${cs.saving ? "Сохраняю…" : "Сохранить"}
      </button>
    </div>
  `;
}

// J.3(a): таб «Приглашения» в channel-settings — отдельные инвайты,
// привязанные именно к этому каналу. accept приватного канала добавит
// юзера в channel_members; для публичного просто откроет канал.
function renderChannelSettingsInvites(): string {
  const cs = state.channelSettings;
  if (!cs.channelId) return `<div class="search-empty">Канал не найден</div>`;
  const channelInvites = state.invites.filter(
    (i) => i.channelId === cs.channelId && !i.revokedAt
  );
  const list = channelInvites.length === 0
    ? `<div class="invites-empty">Нет персональных инвайтов на этот канал.</div>`
    : `<ul class="invite-list">
        ${channelInvites.map((i) => `
          <li data-invite="${i.id}">
            <code class="invite-code">${escapeHtml(i.code)}</code>
            <span class="invite-meta">${i.usedCount}/${i.maxUses === 0 ? "∞" : i.maxUses}</span>
            <button class="ghost invite-copy" data-code="${escapeHtml(i.code)}" data-tooltip="Копировать код">⧉</button>
            <button class="ghost invite-revoke" data-invite="${i.id}" data-tooltip="Отозвать">✕</button>
          </li>
        `).join("")}
      </ul>`;
  return `
    <div class="settings-section">
      <h3>Инвайты на этот канал</h3>
      <small class="settings-hint">
        Код ведёт прямо в канал. Если канал приватный, приглашённый
        автоматически добавляется в channel_members.
      </small>
      <form id="cs-create-channel-invite" class="inline-form" style="margin-top:12px">
        <input name="maxUses" type="number" min="0" max="10000" placeholder="макс. использований (0 = ∞)" />
        <button type="submit" class="primary">Создать инвайт</button>
      </form>
      <div style="margin-top:12px">${list}</div>
    </div>
  `;
}

function renderChannelSettingsDelete(): string {
  const cs = state.channelSettings;
  const ch = state.channels.find((c) => c.id === cs.channelId);
  if (!ch) return `<div class="search-empty">Канал не найден</div>`;
  return `
    <div class="settings-section">
      <h3 style="color:#ed4245">Опасная зона</h3>
      <p class="settings-hint">
        История сообщений и вложений канала <strong>#${escapeHtml(ch.name)}</strong>
        удалится безвозвратно. Восстановить нельзя.
      </p>
      <div class="admin-actions">
        <button id="cs-delete-btn" class="danger">Удалить канал</button>
      </div>
    </div>
  `;
}

// Лейбл роли: системные — из словаря, кастомные — имя из wsRoles.
function roleLabel(code: string): string {
  return ROLE_LABELS_RU[code] ?? state.wsRoles.find((r) => r.code === code)?.name ?? code;
}

// Универсальная таблица «действия × колонки» с inherit/grant/deny селектами.
// selClass различает таблицы (роли канала / юзеры канала / роли категории)
// в обработчиках; data-key — roleCode либо userId.
function renderPermGrid(
  actions: string[],
  columns: Array<{ key: string; label: string }>,
  draft: PermDraft,
  selClass: string
): string {
  const head = `<tr>
    <th class="perm-action-col">Действие</th>
    ${columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("")}
  </tr>`;
  const body = actions.map((a) => {
    const cells = columns.map((c) => {
      const value = draft[c.key]?.[a] ?? "inherit";
      return `
        <td>
          <select class="${selClass}" data-key="${escapeHtml(c.key)}" data-action="${escapeHtml(a)}">
            <option value="inherit" ${value === "inherit" ? "selected" : ""}>Наследовать</option>
            <option value="grant" ${value === "grant" ? "selected" : ""}>Разрешить</option>
            <option value="deny" ${value === "deny" ? "selected" : ""}>Запретить</option>
          </select>
        </td>
      `;
    }).join("");
    return `<tr><td class="perm-action-col">${escapeHtml(ACTION_LABELS_RU[a] ?? a)}</td>${cells}</tr>`;
  }).join("");
  return `<table class="perm-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function renderChannelPermissionsTable(): string {
  const cs = state.channelSettings;
  if (!cs.data) return "";
  const { actions, roles } = cs.data;

  // Wave 5: секция точечных прав участников. Колонки — юзеры из userDraft
  // (существующие overrides + добавленные в этом сеансе).
  const overriddenIds = Object.keys(cs.userDraft);
  const userColumns = overriddenIds.map((uid) => ({ key: uid, label: describePeer(uid) }));
  const addable = state.members.filter((m) => !overriddenIds.includes(m.userId));
  const userSection = `
    <div class="perm-help" style="margin-top:18px">
      <strong>Права участников.</strong> Точечные правила для конкретного юзера —
      высший приоритет: его «Запретить» бьёт разрешения ролей, «Разрешить» —
      их запреты.
    </div>
    ${userColumns.length > 0 ? renderPermGrid(actions, userColumns, cs.userDraft, "perm-user-select") : `<div class="settings-hint" style="margin:8px 0">Пока нет точечных правил.</div>`}
    ${userColumns.length > 0 ? `<div class="admin-actions" style="margin-top:4px">${overriddenIds.map((uid) => `<button class="ghost" data-cs-user-remove="${uid}">✕ ${escapeHtml(describePeer(uid))}</button>`).join("")}</div>` : ""}
    ${addable.length > 0 ? `
      <select id="cs-user-add" class="perm-select" style="margin-top:8px">
        <option value="">+ Добавить участника…</option>
        ${addable.map((m) => `<option value="${m.userId}">${escapeHtml(m.displayName || m.username)}</option>`).join("")}
      </select>` : ""}
  `;

  return `
    <div class="perm-help">
      «Наследовать» оставляет право от workspace-роли (и прав категории,
      если заданы). «Разрешить» даёт право, даже если базовая роль его не
      имеет. «Запретить» отнимает. Owner не подчиняется overrides.
    </div>
    ${renderPermGrid(actions, roles.map((r) => ({ key: r, label: roleLabel(r) })), cs.draft, "perm-select")}
    ${userSection}
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
    // Wave 5: роль- и юзер-overrides тянем параллельно.
    const [data, userData] = await Promise.all([
      httpClient.get<ChannelPermissionsView>(`/api/v1/channels/${cs.channelId}/permissions`),
      httpClient.get<ChannelUserPermissionsView>(`/api/v1/channels/${cs.channelId}/user-permissions`)
    ]);
    state.channelSettings.data = data;
    state.channelSettings.draft = buildDraftFromOverrides(data);
    state.channelSettings.userData = userData;
    state.channelSettings.userDraft = buildUserDraft(userData);
    state.channelSettings.loading = false;
    state.channelSettings.error = null;
  } catch (err) {
    state.channelSettings.loading = false;
    state.channelSettings.error = describeError(err);
  }
  render();
}

// userDraft: ключи — только юзеры с override'ами (или добавленные в UI),
// в отличие от ролевого draft'а, где колонки фиксированы списком ролей.
function buildUserDraft(data: ChannelUserPermissionsView): PermDraft {
  const draft: PermDraft = {};
  for (const ov of data.overrides) {
    draft[ov.userId] = {};
    for (const action of data.actions) draft[ov.userId][action] = "inherit";
    for (const a of ov.granted) draft[ov.userId][a] = "grant";
    for (const a of ov.denied) draft[ov.userId][a] = "deny";
  }
  return draft;
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
  // J.3: переключение табов внутри модалки. Loading permissions — лениво,
  // при первом заходе на «Права доступа».
  rootEl.querySelectorAll<HTMLButtonElement>("[data-cs-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.csTab as ChannelSettingsTab | undefined;
      if (!tab) return;
      state.channelSettings.tab = tab;
      state.channelSettings.error = null;
      if (tab === "permissions" && !state.channelSettings.data && !state.channelSettings.loading) {
        state.channelSettings.loading = true;
        render();
        void loadChannelPermissions();
        return;
      }
      if (tab === "invites" && state.invites.length === 0 && !state.invitesLoading) {
        // J.3(a): ленивая подгрузка ws-инвайтов чтобы отфильтровать
        // канал-скоупные. Дёргаем тот же loadInvites — он наполняет
        // state.invites; рендер отфильтрует.
        void loadInvites();
      }
      render();
    });
  });

  // J.3(a): per-channel invite create form.
  rootEl.querySelector<HTMLFormElement>("#cs-create-channel-invite")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const wsId = state.selectedWorkspaceId;
    const chId = state.channelSettings.channelId;
    if (!wsId || !chId) return;
    const form = e.currentTarget as HTMLFormElement;
    const maxUsesRaw = (form.elements.namedItem("maxUses") as HTMLInputElement)?.value;
    const maxUses = Math.max(0, parseInt(maxUsesRaw ?? "0", 10) || 0);
    try {
      const created = await httpClient.post<Invite>(
        `/api/v1/workspaces/${wsId}/invites`,
        { maxUses, channelId: chId }
      );
      state.invites = [created, ...state.invites];
      form.reset();
      render();
    } catch (err) {
      state.channelSettings.error = describeError(err);
      render();
    }
  });

  // Permissions <select>'ы — write напрямую без render() для сохранения фокуса.
  rootEl.querySelectorAll<HTMLSelectElement>(".perm-select").forEach((sel) => {
    sel.addEventListener("change", () => {
      const key = sel.dataset.key;
      const action = sel.dataset.action;
      if (!key || !action) return;
      const value = sel.value as "inherit" | "grant" | "deny";
      if (!state.channelSettings.draft[key]) state.channelSettings.draft[key] = {};
      state.channelSettings.draft[key][action] = value;
    });
  });
  // Wave 5: селекты точечных прав участников.
  rootEl.querySelectorAll<HTMLSelectElement>(".perm-user-select").forEach((sel) => {
    sel.addEventListener("change", () => {
      const key = sel.dataset.key;
      const action = sel.dataset.action;
      if (!key || !action) return;
      const value = sel.value as "inherit" | "grant" | "deny";
      if (!state.channelSettings.userDraft[key]) state.channelSettings.userDraft[key] = {};
      state.channelSettings.userDraft[key][action] = value;
    });
  });
  rootEl.querySelector<HTMLSelectElement>("#cs-user-add")?.addEventListener("change", (e) => {
    const uid = (e.currentTarget as HTMLSelectElement).value;
    if (!uid) return;
    const actions = state.channelSettings.data?.actions ?? [];
    const row: Record<string, "inherit" | "grant" | "deny"> = {};
    for (const a of actions) row[a] = "inherit";
    state.channelSettings.userDraft[uid] = row;
    render();
  });
  rootEl.querySelectorAll<HTMLButtonElement>("[data-cs-user-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const uid = btn.dataset.csUserRemove;
      if (!uid) return;
      delete state.channelSettings.userDraft[uid];
      render();
    });
  });
  rootEl.querySelector<HTMLButtonElement>("#channel-perm-save")?.addEventListener("click", () => {
    void saveChannelPermissions();
  });

  // J.3: Overview tab handlers. Live-update draft без render() кроме save.
  const draft = state.channelSettings.overviewDraft;
  rootEl.querySelector<HTMLInputElement>("#cs-name")?.addEventListener("input", (e) => {
    draft.name = (e.currentTarget as HTMLInputElement).value;
  });
  const topicEl = rootEl.querySelector<HTMLTextAreaElement>("#cs-topic");
  topicEl?.addEventListener("input", () => {
    draft.topic = topicEl.value;
    const counter = rootEl.querySelector<HTMLSpanElement>("#cs-topic-counter");
    if (counter) counter.textContent = String(topicEl.value.length);
  });
  rootEl.querySelector<HTMLSelectElement>("#cs-slowmode")?.addEventListener("change", (e) => {
    draft.slowMode = Number((e.currentTarget as HTMLSelectElement).value);
  });
  // Wave 8: цвет имени. input — live в draft без render(); reset — draft=""
  // (DOM-mutate кнопки/пикера, чтобы не терять открытый picker).
  const colorEl = rootEl.querySelector<HTMLInputElement>("#cs-color");
  const colorResetEl = rootEl.querySelector<HTMLButtonElement>("#cs-color-reset");
  colorEl?.addEventListener("input", () => {
    draft.nameColor = colorEl.value;
    if (colorResetEl) colorResetEl.disabled = false;
  });
  colorResetEl?.addEventListener("click", () => {
    draft.nameColor = "";
    if (colorEl) colorEl.value = "#8e9297";
    colorResetEl.disabled = true;
  });
  rootEl.querySelector<HTMLSelectElement>("#cs-category")?.addEventListener("change", (e) => {
    draft.categoryId = (e.currentTarget as HTMLSelectElement).value;
  });
  rootEl.querySelector<HTMLInputElement>("#cs-nsfw")?.addEventListener("change", (e) => {
    draft.isNsfw = (e.currentTarget as HTMLInputElement).checked;
  });
  rootEl.querySelector<HTMLButtonElement>("#cs-overview-save")?.addEventListener("click", () => {
    void saveChannelOverview();
  });

  // J.3: delete tab — typed-confirm через dialogs.ts.
  rootEl.querySelector<HTMLButtonElement>("#cs-delete-btn")?.addEventListener("click", async () => {
    const cs = state.channelSettings;
    const ch = state.channels.find((c) => c.id === cs.channelId);
    if (!ch) return;
    const ok = await confirmDialog({
      title: "Удалить канал",
      body: `История сообщений и вложения канала #${ch.name} удалятся безвозвратно.`,
      confirmText: ch.name,
      confirmLabel: "Удалить",
      danger: true
    });
    if (!ok) return;
    try {
      await httpClient.del(`/api/v1/channels/${ch.id}`);
      state.channels = state.channels.filter((c) => c.id !== ch.id);
      if (state.selectedChannelId === ch.id) {
        state.selectedChannelId = null;
        state.messages = [];
      }
      state.modal = null;
    } catch (err) {
      state.channelSettings.error = describeError(err);
    }
    render();
  });
}

async function saveChannelOverview(): Promise<void> {
  const cs = state.channelSettings;
  if (!cs.channelId) return;
  const channel = state.channels.find((c) => c.id === cs.channelId);
  if (!channel) return;
  const draft = cs.overviewDraft;
  const trimName = draft.name.trim();
  if (!trimName) {
    state.channelSettings.error = "Имя канала не может быть пустым";
    render();
    return;
  }
  state.channelSettings.saving = true;
  state.channelSettings.error = null;
  render();
  // Patch только изменённые поля — иначе мы перетёрли бы concurrent-правки.
  const patch: Record<string, unknown> = {};
  if (trimName !== channel.name) patch.name = trimName;
  if ((draft.topic ?? "") !== (channel.topic ?? "")) patch.topic = draft.topic;
  if (draft.slowMode !== (channel.slowModeSeconds ?? 0)) patch.slowModeSeconds = draft.slowMode;
  if (draft.isNsfw !== !!channel.isNsfw) patch.isNsfw = draft.isNsfw;
  // J.5: categoryId: "" = снять привязку (backend получит "" → NULL); UUID = переместить.
  if ((draft.categoryId || "") !== (channel.categoryId ?? "")) patch.categoryId = draft.categoryId;
  // Wave 8: nameColor: "" = сброс на цвет темы (backend получит "" → NULL).
  if ((draft.nameColor || "") !== (channel.nameColor ?? "")) patch.nameColor = draft.nameColor;
  if (Object.keys(patch).length === 0) {
    state.channelSettings.saving = false;
    setTransientStatus("Без изменений");
    render();
    return;
  }
  try {
    const updated = await httpClient.patch<Channel>(`/api/v1/channels/${cs.channelId}`, patch);
    state.channels = state.channels.map((c) => (c.id === updated.id ? updated : c));
    state.channelSettings.saving = false;
    setTransientStatus("Сохранено");
  } catch (err) {
    state.channelSettings.saving = false;
    state.channelSettings.error = describeError(err);
  }
  render();
}

async function saveChannelPermissions(): Promise<void> {
  const cs = state.channelSettings;
  if (!cs.channelId) return;
  state.channelSettings.saving = true;
  state.channelSettings.error = null;
  render();
  try {
    // Wave 5: сохраняем оба слоя — роли и точечные права участников.
    const [data, userData] = await Promise.all([
      httpClient.put<ChannelPermissionsView>(
        `/api/v1/channels/${cs.channelId}/permissions`,
        { overrides: draftToOverrides() }
      ),
      httpClient.put<ChannelUserPermissionsView>(
        `/api/v1/channels/${cs.channelId}/user-permissions`,
        { overrides: permDraftToList(cs.userDraft).map(({ key, granted, denied }) => ({ userId: key, granted, denied })) }
      )
    ]);
    state.channelSettings.data = data;
    state.channelSettings.draft = buildDraftFromOverrides(data);
    state.channelSettings.userData = userData;
    state.channelSettings.userDraft = buildUserDraft(userData);
    setTransientStatus("Права канала сохранены");
  } catch (err) {
    state.channelSettings.error = describeError(err);
  } finally {
    state.channelSettings.saving = false;
    render();
  }
}

// Сворачивает PermDraft в список {key, granted, denied}, пропуская
// полностью «наследуемые» записи. key — roleCode либо userId.
function permDraftToList(draft: PermDraft): Array<{ key: string; granted: string[]; denied: string[] }> {
  const out: Array<{ key: string; granted: string[]; denied: string[] }> = [];
  for (const key of Object.keys(draft)) {
    const granted: string[] = [];
    const denied: string[] = [];
    for (const action of Object.keys(draft[key])) {
      const v = draft[key][action];
      if (v === "grant") granted.push(action);
      else if (v === "deny") denied.push(action);
    }
    if (granted.length === 0 && denied.length === 0) continue;
    out.push({ key, granted, denied });
  }
  return out;
}
