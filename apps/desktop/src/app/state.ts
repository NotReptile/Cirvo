import type { CallManager } from "../call/callManager";
import type {
ScreenShareQuality,
VoiceChannelManager,
} from "../call/voiceChannelManager";
import type { EnumeratedDevices } from "../call/voiceSettings";
import type { HttpClient } from "../network/httpClient";
import type {
ConnectionState,
RealtimeClient,
} from "../realtime/realtimeClient";
import type { ActionId } from "./hotkeys";
import type { UpdateHandle } from "./tauriUpdater";
import type {
AdminCreateState,
AppState,
ChannelSettingsTab,
PresenceMode,
ProfileStyleDraft,
ProfileWidget,
ScreenShareQualityKey,
ServerCheckState,
SessionView,
UserProfileData,
WorkspaceSettingsTab,
} from "./types";
import { newAdminCreate } from "./ui/admin";
import {
loadCollapsedCategories,
loadScreenShareQuality,
} from "./util/persist";

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

// Draft per-channel в localStorage. Незавершённый текст переживает
// переключение каналов и refresh. Чистится при успешной отправке.
const DRAFT_KEY_PREFIX = "cirvo:draft:";

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
  "workspace.update": "Изменять воркспейс",
};

const ROLE_LABELS_RU: Record<string, string> = {
  admin: "Админ",
  moderator: "Модератор",
  member: "Участник",
};

export const SCREEN_SHARE_PRESETS: Record<
  ScreenShareQualityKey,
  ScreenShareQuality
> = {
  "720p30": { width: 1280, height: 720, frameRate: 30, maxBitrate: 2_500_000 },
  "1080p30": {
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 5_000_000,
  },
  "1080p60": {
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrate: 8_000_000,
  },
  "1440p30": {
    width: 2560,
    height: 1440,
    frameRate: 30,
    maxBitrate: 10_000_000,
  },
};

const SCREEN_SHARE_QUALITY_LS = "cirvo:screenShareQuality";

const QUICK_EMOJIS = ["👍", "❤️", "😄", "🎉", "🔥", "🤔", "👀", "🙏"];

// J.6: persisting collapsed-categories state в localStorage. Per-категории
// идентификатор — workspace-scoped UUID; кросс-workspace утечки не страшны.
const COLLAPSED_CATEGORIES_KEY = "cirvo:collapsed-categories";

export function createInitialState(): AppState {
  return {
    windowStart: null,
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
    registrationOpen: null,
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
    createForumPost: {
      channelId: null,
      title: "",
      body: "",
      saving: false,
      error: null,
    },
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
      iceCheckResult: null,
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
      overviewDraft: {
        name: "",
        topic: "",
        slowMode: 0,
        isNsfw: false,
        categoryId: "",
        nameColor: "",
      },
    },
    workspaceRoles: {
      workspaceId: null,
      loading: false,
      saving: false,
      error: null,
      roles: [],
      selectedRoleId: null,
      draft: null,
    },
    wsRoles: [],
    channelMenu: null,
    workspaceMenu: null,
    memberMenu: null,
    categoryMenu: null,
    categoryPerms: {
      categoryId: null,
      loading: false,
      saving: false,
      error: null,
      data: null,
      draft: {},
    },
    voiceVolumes: {},
    voiceVolumeMenu: null,
    statusMenu: null,
    workspaceMenuOpen: false,
    auditFilter: { action: "", actor: "", from: "", to: "", targetType: "" },
    memberSidebarOpen: true,
    userProfileTarget: null,
    userProfileAnchor: null,
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
      categoryId: null,
    },
    workspaceSettings: {
      workspaceId: null,
      tab: "overview",
      draftName: "",
      saving: false,
      error: null,
      deleteTyped: "",
      welcomeSaving: false,
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
      okMessage: null,
    },
    settings: {
      tab: "profile",
      search: "",
    },
  };
}
const state = createInitialState();

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

// C.7: поиск. Запросы шлются с debounce'ом в attachShellHandlers, здесь —
// сам fetch. searchToken защищает от гонки: если за время запроса юзер
// дописал ещё букв, старый ответ выбросим.
let searchToken = 0;

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

// Wave 2: клиентские slash-команды (Discord-набор). Неизвестная /команда
// уходит обычным текстом — как в Discord. /nick — действие без отправки.
const SLASH_COMMANDS: { name: string; args: string; desc: string }[] = [
  { name: "shrug", args: "[текст]", desc: "¯\\_(ツ)_/¯ в конец сообщения" },
  { name: "tableflip", args: "[текст]", desc: "(╯°□°)╯︵ ┻━┻" },
  { name: "unflip", args: "[текст]", desc: "┬─┬ ノ( ゜-゜ノ)" },
  { name: "me", args: "текст", desc: "Курсивное сообщение-действие" },
  { name: "spoiler", args: "текст", desc: "Спрятать текст под спойлер" },
  { name: "nick", args: "имя", desc: "Сменить отображаемое имя" },
];

// Wave 2: typing-индикатор «X печатает…». Полностью transient: отправка с
// клиентским throttle 3с (сервер дополнительно троттлит 2с), приём — TTL 8с
// в module-map. Строка под композером обновляется прямым DOM-mutate, без
// render() — иначе каждое чужое нажатие дёргало бы фокус и message-list.
const TYPING_SEND_INTERVAL_MS = 3000;

const TYPING_TTL_MS = 8000;

let typingLastSentAt = 0;

const typingByChannel = new Map<string, Map<string, number>>();
// channelId → userId → expiresAt
let typingPruneTimer: ReturnType<typeof setInterval> | null = null;

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
  "#user-note-input",
];

// Артефакты WebView, живущие на window: нативное контекстное меню вне полей
// ввода и drag&drop-навигация (файл, брошенный мимо дроп-зоны чата,
// открывался самим WebView2 поверх приложения).
let nativeGuardsInstalled = false;

const PRESENCE_OPTIONS: { mode: PresenceMode; label: string; hint: string }[] =
  [
    { mode: "online", label: "В сети", hint: "Виден как онлайн" },
    {
      mode: "idle",
      label: "Неактивен",
      hint: "Жёлтая точка, виден как онлайн",
    },
    {
      mode: "dnd",
      label: "Не беспокоить",
      hint: "Системные уведомления подавляются",
    },
    { mode: "invisible", label: "Невидимый", hint: "Другие видят тебя офлайн" },
  ];

// H.7: цвета ролей. По умолчанию подтягиваем из workspace_roles
// (loadWsRoles при выборе ws); хардкод-палитра ниже — fallback пока
// данные не загружены либо для роли не задан color в БД (member-роль
// в seed'е — null). member-роль без цвета остаётся дефолтным --text.
const ROLE_COLORS_FALLBACK: Record<string, string> = {
  owner: "#ed4245",
  admin: "#5865f2",
  moderator: "#3ba55c",
};

// Wave 5: union-резолвер «высшей роли» (H.7 ограничение снято). Цвет юзера =
// цвет самой высокой (по position) роли с цветом среди ВСЕХ его ролей
// (workspace_role_members через wsRoles[].memberUserIds + primary role_code).
// Кеш сбрасывается при смене wsRoles/воркспейса (userColorCache = null).
let userColorCache: Map<string, string | undefined> | null = null;

// Wave 7 (I.15–I.16): CSS-пресеты рамок аватара и эффектов баннера.
// Без файлов-ассетов — всё рисуют keyframes в styles.css. Неизвестный id
// (например, из будущей версии) молча игнорируется.
const AVATAR_DECORATIONS: Array<{ id: string; label: string }> = [
  { id: "gold", label: "Золотое кольцо" },
  { id: "neon", label: "Неоновое свечение" },
  { id: "rainbow", label: "Радуга" },
  { id: "frost", label: "Иней" },
  { id: "ember", label: "Уголёк" },
];

const PROFILE_EFFECTS: Array<{ id: string; label: string }> = [
  { id: "sparkles", label: "Искры" },
  { id: "pulse", label: "Пульс" },
  { id: "rain", label: "Дождь" },
  { id: "aurora", label: "Северное сияние" },
];

// Wave 0: avatarMediaId собеседника для call-bar/call-card. members и dms —
// синхронные источники; если юзера нет ни там, ни там (например, звонок
// пришёл, пока state.members ещё не загружен) — лениво тянем /users/{id},
// кешируем и перерисовываемся по приезду. null в кеше = «fetch уже в полёте
// или упал» (защита от повторных запросов на каждый render).
const peerProfileCache = new Map<string, UserProfileData | null>();

// Wave 3: кеш приватных заметок (userId → note) — анти-рефетч при re-render'ах попапа.
const userNoteCache = new Map<string, string>();

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
  "server.retention.sweep": { ru: "запустил очистку", icon: "🧹" },
};

// Wave 8: блок «Архив» — отдельная секция в самом низу. По умолчанию
// свёрнута (persist в localStorage); свёрнутая показывает только активный
// канал, как и обычные категории (J.6).
const ARCHIVE_COLLAPSED_KEY = "cirvo:archive-collapsed";

const SPEAKING_THRESHOLD = 12;

const WS_TABS: { id: WorkspaceSettingsTab; label: string }[] = [
  { id: "overview", label: "Обзор" },
  { id: "welcome", label: "Канал приветствия" },
  { id: "roles", label: "Роли" },
  { id: "delete", label: "Удалить" },
];

// Полный список action-кодов для cherry-pick checkboxes. Должен совпадать
// с permission.AllActions в бэке (порядок важен только для UI).
const ALL_PERMISSION_ACTIONS = [
  "channel.create",
  "channel.update",
  "channel.delete",
  "channel.manage_members",
  "message.moderate",
  "invite.manage",
  "audit.read",
  "member.manage_role",
  "member.kick",
  "message.write",
  "message.react",
  "message.attach",
  "message.mention",
  "message.mention_everyone",
  "workspace.update",
];

// Wave 5: drag-reorder ролей. Перемещаем роль в списке (отсортирован по
// position desc) и пересчитываем позиции всем сверху вниз с шагом 10 —
// PATCH'им только те, у кого позиция реально изменилась.
let _roleDragId: string | null = null;

let _serverCheck: ServerCheckState = { status: "idle" };

// I.4: state для capture-режима. Когда юзер кликнул на binding-кнопку,
// модуль ждёт первый keydown с не-модификаторной клавишей и записывает
// chord. Esc отменяет capture.
let _capturingActionId: ActionId | null = null;

let _sessions: SessionView[] | null = null;

let _sessionsLoading = false;

let _sessionsError: string | null = null;

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

// Wave 7 (I.13): редактор виджетов профиля. Draft — module-level (как
// profileStyleDraft): инпуты пишут без render(), кнопки порядка/удаления —
// с render(). Сохранение — полная замена через PUT /users/me/widgets.
let widgetsDraft: ProfileWidget[] | null = null;

let widgetsLoading = false;

let widgetsSaving = false;

let profileStyleDraft: ProfileStyleDraft | null = null;

let profileStyleSaving = false;

// I.11: live-filter настроек. Прямой DOM-mutate без render() — иначе
// каждый ввод сорвал бы фокус и каретку из инпута. На клик по результату
// переключаем таб через render() и скроллим к h3 по textContent'у.
let _pendingSearchScroll: string | null = null;

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

// Wave 2: плавающая date-пилюля при скролле (Discord-style). Показывает
// день верхней видимой границы, исчезает через 1.2с после остановки.
let stickyDateHideTimer: ReturnType<typeof setTimeout> | null = null;

// ---- mention popup ---------------------------------------------------------

const MENTION_TOKEN_RE = /(?:^|[^A-Za-z0-9_])@([a-z0-9_]{0,32})$/;

// ---- channel popup (Wave 8) ------------------------------------------------
// `#<prefix>` перед кареткой → попап каналов текущего воркспейса, зеркалит
// mention-попап. Предлагаем только «линкуемые» имена (без пробелов) — иначе
// вставленный токен не превратился бы в ссылку в renderBody.

const CHANNEL_TOKEN_RE = /(?:^|\s)#([\p{L}\p{N}_-]{0,64})$/u;

const CHANNEL_LINKABLE_RE = /^[\p{L}\p{N}_-]{1,64}$/u;

// Бэк-сигнал «body too long» (см. message/module.go) — единственная
// валидационная ошибка POST /messages, которую UX обрабатывает отдельно
// (предлагает отправить тело как .txt-вложение).
// J.3(b): slow-mode countdown. Когда message-create отдаёт 429 с Retry-After,
// записываем `Date.now() + retry*1000` в карту, композер показывает таймер
// и блокирует submit. Тикер обновляет UI раз в секунду пока есть активные
// каналы.
const _slowModeUntil = new Map<string, number>();

let _slowModeTickHandle: ReturnType<typeof setInterval> | null = null;

let _adminCreate: AdminCreateState = newAdminCreate();

// ============================================================
// D.4 — Channel permission overrides
// ============================================================

// J.3: полноэкранная модалка настроек канала — 4 таба по образцу H.10.
// Tab «Обзор» — name/topic/slow-mode/NSFW (PATCH /channels/{id}).
// Tab «Права доступа» — старая permission-таблица.
// Tab «Приглашения» — placeholder.
// Tab «Удалить канал» — typed-confirm на имя.
const CHANNEL_SETTINGS_TABS: {
  id: ChannelSettingsTab;
  label: string;
  danger?: boolean;
}[] = [
  { id: "overview", label: "Обзор" },
  { id: "permissions", label: "Права доступа" },
  { id: "invites", label: "Приглашения" },
  { id: "delete", label: "Удалить канал", danger: true },
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
  { value: 3600, label: "1 час" },
];
// Shared mutable values stay behind accessors; feature modules do not export live let bindings.
export const uiContext = {
  get MAX_ATTACHMENTS() {
    return MAX_ATTACHMENTS;
  },
  get STATUS_AUTO_CLEAR_MS() {
    return STATUS_AUTO_CLEAR_MS;
  },
  get _statusTimer() {
    return _statusTimer;
  },
  set _statusTimer(value: typeof _statusTimer) {
    _statusTimer = value;
  },
  get _lastTimedStatus() {
    return _lastTimedStatus;
  },
  set _lastTimedStatus(value: typeof _lastTimedStatus) {
    _lastTimedStatus = value;
  },
  get DRAFT_KEY_PREFIX() {
    return DRAFT_KEY_PREFIX;
  },
  get ACTION_LABELS_RU() {
    return ACTION_LABELS_RU;
  },
  get ROLE_LABELS_RU() {
    return ROLE_LABELS_RU;
  },
  get SCREEN_SHARE_PRESETS() {
    return SCREEN_SHARE_PRESETS;
  },
  get SCREEN_SHARE_QUALITY_LS() {
    return SCREEN_SHARE_QUALITY_LS;
  },
  get QUICK_EMOJIS() {
    return QUICK_EMOJIS;
  },
  get COLLAPSED_CATEGORIES_KEY() {
    return COLLAPSED_CATEGORIES_KEY;
  },
  get state() {
    return state;
  },
  get rootEl() {
    return rootEl;
  },
  set rootEl(value: typeof rootEl) {
    rootEl = value;
  },
  get httpClient() {
    return httpClient;
  },
  set httpClient(value: typeof httpClient) {
    httpClient = value;
  },
  get realtimeClient() {
    return realtimeClient;
  },
  set realtimeClient(value: typeof realtimeClient) {
    realtimeClient = value;
  },
  get callMgr() {
    return callMgr;
  },
  set callMgr(value: typeof callMgr) {
    callMgr = value;
  },
  get voiceMgr() {
    return voiceMgr;
  },
  set voiceMgr(value: typeof voiceMgr) {
    voiceMgr = value;
  },
  get callTimerInterval() {
    return callTimerInterval;
  },
  set callTimerInterval(value: typeof callTimerInterval) {
    callTimerInterval = value;
  },
  get connState() {
    return connState;
  },
  set connState(value: typeof connState) {
    connState = value;
  },
  get syncGeneration() {
    return syncGeneration;
  },
  set syncGeneration(value: typeof syncGeneration) {
    syncGeneration = value;
  },
  get updateHandle() {
    return updateHandle;
  },
  set updateHandle(value: typeof updateHandle) {
    updateHandle = value;
  },
  get updatePhase() {
    return updatePhase;
  },
  set updatePhase(value: typeof updatePhase) {
    updatePhase = value;
  },
  get updatePct() {
    return updatePct;
  },
  set updatePct(value: typeof updatePct) {
    updatePct = value;
  },
  get updateCheckStarted() {
    return updateCheckStarted;
  },
  set updateCheckStarted(value: typeof updateCheckStarted) {
    updateCheckStarted = value;
  },
  get searchToken() {
    return searchToken;
  },
  set searchToken(value: typeof searchToken) {
    searchToken = value;
  },
  get IDLE_THRESHOLD_MS() {
    return IDLE_THRESHOLD_MS;
  },
  get IDLE_CHECK_INTERVAL_MS() {
    return IDLE_CHECK_INTERVAL_MS;
  },
  get idleLastActivity() {
    return idleLastActivity;
  },
  set idleLastActivity(value: typeof idleLastActivity) {
    idleLastActivity = value;
  },
  get idleAutoSet() {
    return idleAutoSet;
  },
  set idleAutoSet(value: typeof idleAutoSet) {
    idleAutoSet = value;
  },
  get idleTimer() {
    return idleTimer;
  },
  set idleTimer(value: typeof idleTimer) {
    idleTimer = value;
  },
  get idleListenersAttached() {
    return idleListenersAttached;
  },
  set idleListenersAttached(value: typeof idleListenersAttached) {
    idleListenersAttached = value;
  },
  get globalShortcutsInstalled() {
    return globalShortcutsInstalled;
  },
  set globalShortcutsInstalled(value: typeof globalShortcutsInstalled) {
    globalShortcutsInstalled = value;
  },
  get _deafened() {
    return _deafened;
  },
  set _deafened(value: typeof _deafened) {
    _deafened = value;
  },
  get _pttHeld() {
    return _pttHeld;
  },
  set _pttHeld(value: typeof _pttHeld) {
    _pttHeld = value;
  },
  get _pttReleaseTimer() {
    return _pttReleaseTimer;
  },
  set _pttReleaseTimer(value: typeof _pttReleaseTimer) {
    _pttReleaseTimer = value;
  },
  get SLASH_COMMANDS() {
    return SLASH_COMMANDS;
  },
  get TYPING_SEND_INTERVAL_MS() {
    return TYPING_SEND_INTERVAL_MS;
  },
  get TYPING_TTL_MS() {
    return TYPING_TTL_MS;
  },
  get typingLastSentAt() {
    return typingLastSentAt;
  },
  set typingLastSentAt(value: typeof typingLastSentAt) {
    typingLastSentAt = value;
  },
  get typingByChannel() {
    return typingByChannel;
  },
  get typingPruneTimer() {
    return typingPruneTimer;
  },
  set typingPruneTimer(value: typeof typingPruneTimer) {
    typingPruneTimer = value;
  },
  get PRESERVED_INPUT_SELECTORS() {
    return PRESERVED_INPUT_SELECTORS;
  },
  get nativeGuardsInstalled() {
    return nativeGuardsInstalled;
  },
  set nativeGuardsInstalled(value: typeof nativeGuardsInstalled) {
    nativeGuardsInstalled = value;
  },
  get PRESENCE_OPTIONS() {
    return PRESENCE_OPTIONS;
  },
  get ROLE_COLORS_FALLBACK() {
    return ROLE_COLORS_FALLBACK;
  },
  get userColorCache() {
    return userColorCache;
  },
  set userColorCache(value: typeof userColorCache) {
    userColorCache = value;
  },
  get AVATAR_DECORATIONS() {
    return AVATAR_DECORATIONS;
  },
  get PROFILE_EFFECTS() {
    return PROFILE_EFFECTS;
  },
  get peerProfileCache() {
    return peerProfileCache;
  },
  get userNoteCache() {
    return userNoteCache;
  },
  get AUDIT_ACTION_INFO() {
    return AUDIT_ACTION_INFO;
  },
  get ARCHIVE_COLLAPSED_KEY() {
    return ARCHIVE_COLLAPSED_KEY;
  },
  get SPEAKING_THRESHOLD() {
    return SPEAKING_THRESHOLD;
  },
  get WS_TABS() {
    return WS_TABS;
  },
  get ALL_PERMISSION_ACTIONS() {
    return ALL_PERMISSION_ACTIONS;
  },
  get _roleDragId() {
    return _roleDragId;
  },
  set _roleDragId(value: typeof _roleDragId) {
    _roleDragId = value;
  },
  get _serverCheck() {
    return _serverCheck;
  },
  set _serverCheck(value: typeof _serverCheck) {
    _serverCheck = value;
  },
  get _capturingActionId() {
    return _capturingActionId;
  },
  set _capturingActionId(value: typeof _capturingActionId) {
    _capturingActionId = value;
  },
  get _sessions() {
    return _sessions;
  },
  set _sessions(value: typeof _sessions) {
    _sessions = value;
  },
  get _sessionsLoading() {
    return _sessionsLoading;
  },
  set _sessionsLoading(value: typeof _sessionsLoading) {
    _sessionsLoading = value;
  },
  get _sessionsError() {
    return _sessionsError;
  },
  set _sessionsError(value: typeof _sessionsError) {
    _sessionsError = value;
  },
  get _settingsDevices() {
    return _settingsDevices;
  },
  set _settingsDevices(value: typeof _settingsDevices) {
    _settingsDevices = value;
  },
  get _settingsDevicesLoading() {
    return _settingsDevicesLoading;
  },
  set _settingsDevicesLoading(value: typeof _settingsDevicesLoading) {
    _settingsDevicesLoading = value;
  },
  get _micTestStream() {
    return _micTestStream;
  },
  set _micTestStream(value: typeof _micTestStream) {
    _micTestStream = value;
  },
  get _micTestAudioCtx() {
    return _micTestAudioCtx;
  },
  set _micTestAudioCtx(value: typeof _micTestAudioCtx) {
    _micTestAudioCtx = value;
  },
  get _micTestAnalyser() {
    return _micTestAnalyser;
  },
  set _micTestAnalyser(value: typeof _micTestAnalyser) {
    _micTestAnalyser = value;
  },
  get _micTestRaf() {
    return _micTestRaf;
  },
  set _micTestRaf(value: typeof _micTestRaf) {
    _micTestRaf = value;
  },
  get _camTestStream() {
    return _camTestStream;
  },
  set _camTestStream(value: typeof _camTestStream) {
    _camTestStream = value;
  },
  get _settingsVoiceSubscribed() {
    return _settingsVoiceSubscribed;
  },
  set _settingsVoiceSubscribed(value: typeof _settingsVoiceSubscribed) {
    _settingsVoiceSubscribed = value;
  },
  get widgetsDraft() {
    return widgetsDraft;
  },
  set widgetsDraft(value: typeof widgetsDraft) {
    widgetsDraft = value;
  },
  get widgetsLoading() {
    return widgetsLoading;
  },
  set widgetsLoading(value: typeof widgetsLoading) {
    widgetsLoading = value;
  },
  get widgetsSaving() {
    return widgetsSaving;
  },
  set widgetsSaving(value: typeof widgetsSaving) {
    widgetsSaving = value;
  },
  get profileStyleDraft() {
    return profileStyleDraft;
  },
  set profileStyleDraft(value: typeof profileStyleDraft) {
    profileStyleDraft = value;
  },
  get profileStyleSaving() {
    return profileStyleSaving;
  },
  set profileStyleSaving(value: typeof profileStyleSaving) {
    profileStyleSaving = value;
  },
  get _pendingSearchScroll() {
    return _pendingSearchScroll;
  },
  set _pendingSearchScroll(value: typeof _pendingSearchScroll) {
    _pendingSearchScroll = value;
  },
  get _dragKind() {
    return _dragKind;
  },
  set _dragKind(value: typeof _dragKind) {
    _dragKind = value;
  },
  get _dragId() {
    return _dragId;
  },
  set _dragId(value: typeof _dragId) {
    _dragId = value;
  },
  get stickyDateHideTimer() {
    return stickyDateHideTimer;
  },
  set stickyDateHideTimer(value: typeof stickyDateHideTimer) {
    stickyDateHideTimer = value;
  },
  get MENTION_TOKEN_RE() {
    return MENTION_TOKEN_RE;
  },
  get CHANNEL_TOKEN_RE() {
    return CHANNEL_TOKEN_RE;
  },
  get CHANNEL_LINKABLE_RE() {
    return CHANNEL_LINKABLE_RE;
  },
  get _slowModeUntil() {
    return _slowModeUntil;
  },
  get _slowModeTickHandle() {
    return _slowModeTickHandle;
  },
  set _slowModeTickHandle(value: typeof _slowModeTickHandle) {
    _slowModeTickHandle = value;
  },
  get _adminCreate() {
    return _adminCreate;
  },
  set _adminCreate(value: typeof _adminCreate) {
    _adminCreate = value;
  },
  get CHANNEL_SETTINGS_TABS() {
    return CHANNEL_SETTINGS_TABS;
  },
  get SLOW_MODE_OPTIONS() {
    return SLOW_MODE_OPTIONS;
  },
};
