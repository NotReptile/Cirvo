import type { CallSnapshot } from "../call/callManager";
import type { IceCheckResult } from "../call/iceCheck";
import type { VoiceSnapshot } from "../call/voiceChannelManager";

// H.8: presenceMode — выбранный юзером режим. "online"/"idle"/"dnd"/
// "invisible". Для других юзеров invisible маскируется на бэке как
// "offline" (см. effective_mode). У state.me хранится реальный режим.
export type PresenceMode = "online" | "idle" | "dnd" | "invisible" | "offline";

export interface Me {
  id: string;
  email: string;
  username: string;
  displayName?: string;
  isRoot?: boolean;
  // Выдан временный пароль: до смены API закрыт (403 password_change_required),
  // клиент показывает экран смены пароля.
  mustChangePassword?: boolean;
  avatarMediaId?: string;
  presenceMode?: PresenceMode;
  customStatus?: string;
  updatedAt?: string;
  // idle выставлен таймером неактивности (а не вручную): вернуть «В сети» при вводе.
  autoIdle?: boolean;
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
export interface UserProfileData {
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
export interface ProfileWidget {
  id?: string;
  kind: "link";
  label: string;
  url: string;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  ownerId: string;
  role?: string;
  avatarMediaId?: string;
  welcomeChannelId?: string;
  createdAt: string;
}

export interface Channel {
	// Present on servers exposing effective capabilities; absent on v0.2.0.
	actions?: string[];
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
export interface ForumPost {
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
export interface ChannelCategory {
  id: string;
  workspaceId: string;
  name: string;
  position: number;
  createdAt: string;
}

export interface ReactionAgg {
  count: number;
  mine: boolean;
  userIds?: string[];
}

export interface Attachment {
  id: string;
  contentType: string;
  sizeBytes: number;
  filename?: string;
  url: string;
}

// Меню громкости (ПКМ на участнике). key — sessionId, либо "call-remote" для
// 1-к-1 звонка. userId задан для участника voice-канала: голос и звук
// демонстрации хранятся по нему.
export interface VoiceVolumeMenuState {
  key: string;
  label: string;
  x: number;
  y: number;
  userId: string | null;
}

export interface PendingUpload {
  id: string;
  contentType: string;
  sizeBytes: number;
  filename?: string;
  url: string;
}

export interface ReplySnippet {
  messageId: string;
  authorId: string;
  body: string;
  deleted?: boolean;
}

// Wave 10: тред, растущий из сообщения (jsonb-агрегат с бэка в message
// list). threadId — id kind='thread' канала, открывается selectChannel().
export interface MessageThreadInfo {
  threadId: string;
  title: string;
  messageCount: number;
  lastActivityAt?: string;
}

// H.9: kind — 'user' (дефолт; обычное сообщение) или 'system_*' (плашки).
// Старые сервера до миграции 22 поле не возвращают; считаем тогда 'user'.
export type MessageKind =
  "user" | "system_join" | "system_call" | "system_channel_event";

// Wave 2: OG-превью ссылки (см. worker linkpreview.go).
export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  siteName?: string;
}

export interface Message {
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

export interface MentionAutocomplete {
  query: string;
  selectIndex: number;
}

export interface Invite {
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

export interface Member {
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

export interface AuditEntry {
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
export interface DMPeer {
  userId: string;
  username: string;
  displayName?: string;
  online: boolean;
  avatarMediaId?: string;
  presenceMode?: PresenceMode;
  customStatus?: string;
}

export interface DMItem {
  channelId: string;
  peer: DMPeer;
  createdAt: string;
  lastMessageAt?: string;
  unreadCount: number;
}

// Wave 3: друзья. status относительный к текущему юзеру:
// pending_in — ждёт моего ответа, pending_out — я отправил,
// blocked — я заблокировал (чужой блок против меня сервер не отдаёт).
export type FriendStatus =
  "accepted" | "pending_in" | "pending_out" | "blocked";

export interface FriendItem {
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

export type FriendsTab = "all" | "online" | "pending" | "blocked";

export type ModalKind =
  | "settings"
  | "members"
  | "audit"
  | "search"
  | "notifications"
  | "admin"
  | "channelSettings"
  | "workspaceRoles"
  | "welcomeChannel"
  | "createChannel"
  | "workspaceSettings"
  | "userProfile"
  | "invites"
  | "categoryPermissions"
  | "createForumPost"
  | null;

// I.1: полноэкранная settings-модалка по Discord-pattern. Левый sidebar
// с табами + контент справа. Tab «profile» = тело старой profile-card
// (G.10). Остальные табы — placeholder'ы под I.2-I.8/I.11.
export type SettingsTab =
  | "profile"
  | "privacy"
  | "voice"
  | "notifications"
  | "hotkeys"
  | "language"
  | "appearance"
  | "server";

export interface SettingsState {
  tab: SettingsTab;
  // Hook под I.11 (поиск настроек) — пока non-functional.
  search: string;
}

// H.10: workspaceSettings — модалка с табами Обзор/Welcome/Роли/Удалить.
// Для не-owner'а вкладка «Удалить» скрыта (permission.WorkspaceDelete
// выдаётся только owner-роли).
export type WorkspaceSettingsTab = "overview" | "welcome" | "roles" | "delete";

export interface WorkspaceSettingsState {
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
export interface CreateChannelState {
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

export interface WorkspaceRole {
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

export interface WorkspaceRoleDraft {
  name: string;
  color: string;
  position: number;
  hoisted: boolean;
  baseActionMask: string[];
}

export interface WorkspaceRolesState {
  workspaceId: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  roles: WorkspaceRole[];
  selectedRoleId: string | null;
  draft: WorkspaceRoleDraft | null;
}

// D.4 — per-channel permission overrides.
export interface RoleOverride {
  roleCode: string;
  granted: string[];
  denied: string[];
}

export interface ChannelPermissionsView {
  channelId: string;
  actions: string[];
  roles: string[];
  overrides: RoleOverride[];
}

// Wave 5: точечные override'ы конкретных участников канала.
export interface UserOverride {
  userId: string;
  granted: string[];
  denied: string[];
}

export interface ChannelUserPermissionsView {
  channelId: string;
  actions: string[];
  overrides: UserOverride[];
}

export type PermDraft = Record<
  string,
  Record<string, "inherit" | "grant" | "deny">
>;

export type ChannelSettingsTab =
  "overview" | "permissions" | "invites" | "delete";

export interface ChannelSettingsState {
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
  overviewDraft: {
    name: string;
    topic: string;
    slowMode: number;
    isNsfw: boolean;
    categoryId: string;
    nameColor: string;
  };
}

// Wave 5 (J.5b): права категории — отдельная модалка (ПКМ по заголовку
// категории → «Права категории…»). Зеркалит permissions-таб канала.
export interface CategoryPermsState {
  categoryId: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  data: {
    categoryId: string;
    actions: string[];
    roles: string[];
    overrides: RoleOverride[];
  } | null;
  draft: PermDraft;
}

// D.2 — Admin panel.
export type AdminTab = "settings" | "users" | "metrics";

export interface AdminUser {
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

export interface ServerSettings {
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

export interface ServerMetrics {
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

export interface RetentionStats {
  messagesDeleted: number;
  mediaDeleted: number;
  bytesFreed: number;
}

export interface AdminState {
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
export interface NotificationPayload {
  actorId?: string;
  workspaceId?: string;
  channelId?: string;
  messageId?: string;
  callId?: string;
  snippet?: string;
  // mention_everyone: 'everyone' | 'here'.
  mentionKind?: string;
}

export interface NotificationItem {
  id: string;
  kind:
    | "mention"
    | "mention_everyone"
    | "reply"
    | "call_incoming"
    | "friend_request"
    | "friend_accept";
  payload: NotificationPayload;
  createdAt: string;
  readAt?: string;
}

export interface SearchHit {
  id: string;
  channelId: string;
  channelName: string;
  authorId: string;
  body: string;
  highlight: string;
  createdAt: string;
}

export interface SearchState {
  query: string;
  loading: boolean;
  hits: SearchHit[];
  error: string | null;
}

export interface AppState {
  windowStart: number | null;
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
  // GET /api/v1/server/public-config: null = ещё не загружено. false прячет
  // вкладку «Регистрация» на экране входа.
  registrationOpen: boolean | null;
  status: string;
  editingMessageId: string | null;
  invitesOpen: boolean;
  invites: Invite[];
  invitesLoading: boolean;
  modal: ModalKind;
  members: Member[];
  membersLoading: boolean;
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
  messagesCursor: string | null; // следующий before= для подгрузки старых
  messagesHasMore: boolean;
  messagesLoadingOlder: boolean;
  stickToBottom: boolean; // юзер у нижней границы → autoscroll на новые
  restoreScrollBottom: number | null; // one-shot: после render() восстановить «расстояние до низа»
  // C.5: unread indicators
  unread: Record<string, number>; // channelId → count
  selectedChannelLastReadAt: string | null; // фриз lastReadAt на момент входа — для divider'а
  // Wave 9: форум. Посты выбранного форум-канала (грузятся в selectChannel)
  // + state модалки «Новый пост» (title/body/saving/error).
  forumPosts: ForumPost[];
  forumPostsLoading: boolean;
  createForumPost: {
    channelId: string | null;
    title: string;
    body: string;
    saving: boolean;
    error: string | null;
  };
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
  // Popup управления громкостью: ПКМ на чужом voice-tile. key — sessionId
  // (для "call-remote" — спец-ключ 1-к-1 звонка). userId задан для участника
  // voice-канала: громкости голоса и звука демонстрации хранятся по нему.
  voiceVolumeMenu: VoiceVolumeMenuState | null;
  // H.8: попап под avatar'ом в user-strip. Открывается на клик кнопки
  // статуса; содержит радиокнопки per-mode + поле customStatus.
  statusMenu: {
    x: number;
    y: number;
    draftMode: PresenceMode;
    draftCustom: string;
  } | null;
  // J.5: dropdown под заголовком воркспейса (Discord-pattern) — содержит
  // Пригласить / Настройки сервера / Создать канал / Создать категорию.
  workspaceMenuOpen: boolean;
  // I.12: from/to — ISO даты YYYY-MM-DD; пустые = без ограничения.
  auditFilter: {
    action: string;
    actor: string;
    from: string;
    to: string;
    targetType: string;
  };
  // Правая панель участников (Discord-style). На широких экранах открыта
  // по умолчанию, кнопка в channel-header сворачивает.
  memberSidebarOpen: boolean;
  userProfileTarget: string | null;
  userProfileAnchor: { x: number; y: number; width: number; height: number } | null;
  // I.6: лениво загруженные расширенные поля профиля для user-profile-popup.
  userProfileData: UserProfileData | null;
  // Wave 7 (I.13): виджеты открытого в попапе профиля (лениво, GET /widgets).
  userProfileWidgets: ProfileWidget[] | null;
  // Wave 4: персистентные уровни уведомлений (G.9.e). Явные значения с
  // бэка; эффективный уровень канала = канал ← воркспейс ← 'all'.
  // 'none' = бывший клиентский mute, теперь переживает refresh и девайсы.
  notifPrefs: {
    channels: Record<string, string>;
    workspaces: Record<string, string>;
  };
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

export interface ProfileEditState {
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

export type ScreenShareQualityKey =
  | "720p30"
  | "1080p30"
  | "1080p60"
  | "1440p30"
  | "1440p60"
  | "4k30";

export interface VoicePeekParticipant {
  userId: string;
  sessionId: string;
  username: string;
  displayName?: string;
  joinedAt: string;
  screenSharing?: boolean;
  cameraOn?: boolean;
}

export interface VoicePeek {
  channelId: string;
  participants: VoicePeekParticipant[];
}

// ---- Wave 4: уровни уведомлений ---------------------------------------------

export type NotifLevel = "all" | "mentions" | "none";

export type SlashAction =
  { kind: "send"; body: string } | { kind: "nick"; name: string };

export interface InputSnapshot {
  selector: string;
  value: string;
  selStart: number | null;
  selEnd: number | null;
  hadFocus: boolean;
  channelTag: string | null;
}

// H.1: универсальный рендер аватара. Если есть avatarMediaId — слот с
// data-avatar-media, который attachAvatarSlots() лениво наполняет blob-URL'ом
// после рендера (через тот же mediaBlobCache что и для attach-image). Пока
// blob не загружен — внутри буква-плейсхолдер, чтобы не было пустоты.
// fallbackText — первая буква имени; sizePx — диаметр круга.
export interface AvatarOpts {
  avatarMediaId?: string;
  fallbackText: string;
  sizePx: number;
  className?: string;
  online?: boolean | null;
  // Wave 7 (I.15): id пресета рамки (AVATAR_DECORATIONS).
  decoration?: string;
}

export interface AuditDescription {
  icon: string;
  actor: string;
  verb: string;
  target: string;
  raw: boolean;
}

// Speaking indicator: один общий AudioContext, по AnalyserNode на каждый
// audio-track. RAF-цикл считает RMS и переключает .speaking на .voice-tile,
// чтобы рамка тайла подсвечивалась во время речи (Discord-like). Volume
// контроль (per-remote slider) — отдельная задача в бэклоге.
export interface SpeakingNode {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buffer: Uint8Array<ArrayBuffer>;
  isSpeaking: boolean;
}

// G.10: профиль-модалка в Discord-стиле — карточка с акцентным баннером
// (там же кнопка change-avatar), крупным аватаром поверх границы баннера,
// именем+username под ним, и списком inline-edit полей. Только один field
// активен одновременно (state.profileEdit.field), остальные показывают
// статичное значение и кнопку «Изменить».
// I.1: SETTINGS_TABS — порядок и группировка табов в sidebar'е. Каждая
// группа отрисовывается своим заголовком. Содержимое табов кроме
// `profile` пока заглушки.
export interface SettingsTabDef {
  id: SettingsTab;
  label: string;
}

export interface SettingsTabGroup {
  title: string;
  tabs: SettingsTabDef[];
}

// I.11: индекс «что лежит в каждом табе». Используется для live-фильтра
// в #settings-search. Label — точное название H3-секции (для scrollIntoView
// после переключения таба ищем h3 с этим textContent'ом). Keywords —
// дополнительные синонимы, чтобы «микрофон» подсвечивал секцию «Голос».
export interface SettingsSearchEntry {
  tab: SettingsTab;
  label: string;
  keywords?: string[];
}

// Вкладка «Сервер»: адрес, проверка связи, смена. Результат проверки живёт в
// модуле (как список сеансов на вкладке «Конфиденциальность»), а не в AppState.
export type ServerCheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok" }
  | { status: "error"; message: string };

// I.10: privacy & sessions tab. Список активных сессий + кнопки revoke
// per-session + «Выйти со всех устройств». Cache в модуль-локалке, чтобы
// не дёргать API на каждый render().
export interface SessionView {
  id: string;
  deviceLabel: string;
  userAgent?: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

// Wave 7 (I.17–I.19): секция «Стиль профиля». Draft живёт в module-level
// profileStyleDraft (а не state) — input'ы пишут в него без render(),
// чтобы не терять фокус; сбрасывается при закрытии настроек и после save.
export interface ProfileStyleDraft {
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

export interface ProfileFieldOpts {
  label: string;
  value: string;
  field:
    "displayName" | "username" | "email" | "password" | "bio" | "bannerColor";
  editing: boolean;
  disabled?: boolean;
  disabledHint?: string;
  body: string;
}

// MentionOption — элемент попапа: реальный участник либо псевдо-пункт
// @everyone/@here (Wave 4). Псевдо-пункты не показываем в DM.
export interface MentionOption {
  username: string;
  displayName?: string;
}

// Создание пользователя админом (POST /api/v1/server/users). Состояние формы
// живёт в модуле, а не в AppState: оно нужно только админской вкладке.
export interface CreatedUserResult {
  username: string;
  mustChangePassword: boolean;
  // Только если пароль сгенерировал сервер. Показывается один раз.
  temporaryPassword?: string;
}

// Введённое в форму хранится здесь, а не только в DOM: любая перерисовка
// (ошибка создания, событие realtime) пересобирает форму из шаблона.
export interface AdminCreateDraft {
  email: string;
  username: string;
  displayName: string;
  password: string;
  // null = по умолчанию выбранный сейчас воркспейс.
  workspace: string | null;
  mustChange: boolean;
}

export interface AdminCreateState {
  open: boolean;
  busy: boolean;
  error: string | null;
  result: CreatedUserResult | null;
  draft: AdminCreateDraft;
}
