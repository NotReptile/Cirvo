// I.7: язык и формат времени.
//
// Минимальная инфраструктура для i18n + time-format. Локаль и time-format
// персистятся в localStorage и читаются на старте. t("key") — функция
// перевода с fallback на ключ если строки нет в словаре (Wesensgleich:
// видишь `settings.language.title` в UI = забыли добавить перевод).
//
// Coverage migration — инкрементальный: новые/часто-видимые строки сразу
// идут через t(), миграция остальных по мере касания. Это нормальный
// подход для постепенной локализации без big-bang переписывания
// 9000-строчного ui.ts за один присест.
//
// Backend strings (audit-actions, system messages, server errors) НЕ
// локализуем — они приходят на русском от сервера и остаются как есть.

export type Locale = "ru" | "en";
export type TimeFormat = "auto" | "h12" | "h24";

const LOCALE_KEY = "rucord:locale";
const TIME_FORMAT_KEY = "rucord:time-format";
const DEFAULT_LOCALE: Locale = "ru";
const DEFAULT_TIME_FORMAT: TimeFormat = "auto";

let currentLocale: Locale = readStoredLocale();
let currentTimeFormat: TimeFormat = readStoredTimeFormat();

const listeners = new Set<() => void>();

function readStoredLocale(): Locale {
  try {
    const raw = localStorage.getItem(LOCALE_KEY);
    if (raw === "ru" || raw === "en") return raw;
  } catch { /* ignore */ }
  return DEFAULT_LOCALE;
}

function readStoredTimeFormat(): TimeFormat {
  try {
    const raw = localStorage.getItem(TIME_FORMAT_KEY);
    if (raw === "auto" || raw === "h12" || raw === "h24") return raw;
  } catch { /* ignore */ }
  return DEFAULT_TIME_FORMAT;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (currentLocale === locale) return;
  currentLocale = locale;
  try { localStorage.setItem(LOCALE_KEY, locale); } catch { /* ignore */ }
  notify();
}

export function getTimeFormat(): TimeFormat {
  return currentTimeFormat;
}

export function setTimeFormat(fmt: TimeFormat): void {
  if (currentTimeFormat === fmt) return;
  currentTimeFormat = fmt;
  try { localStorage.setItem(TIME_FORMAT_KEY, fmt); } catch { /* ignore */ }
  notify();
}

// hour12 mapping для Intl.DateTimeFormat. undefined = пусть Intl выберет
// по локали; true/false override.
export function hour12Setting(): boolean | undefined {
  if (currentTimeFormat === "h12") return true;
  if (currentTimeFormat === "h24") return false;
  return undefined;
}

// BCP-47 locale tag для Intl. У браузера локаль может быть `ru-RU`/`en-US`/etc;
// для format'а нам нужно chevet просто `ru` или `en`.
export function intlLocale(): string {
  return currentLocale === "ru" ? "ru-RU" : "en-US";
}

export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const l of Array.from(listeners)) {
    try { l(); } catch { /* ignore */ }
  }
}

// ---- словарь ---------------------------------------------------------------

type Dict = Record<string, string>;
type DictMap = Record<Locale, Dict>;

const DICT: DictMap = {
  ru: {
    "common.save": "Сохранить",
    "common.cancel": "Отмена",
    "common.close": "Закрыть",
    "common.delete": "Удалить",
    "common.loading": "Загрузка…",
    "settings.group.account": "Аккаунт",
    "settings.group.interact": "Взаимодействие",
    "settings.group.appearance": "Внешний вид",
    "settings.group.advanced": "Расширенные",
    "settings.tab.profile": "Профиль",
    "settings.tab.privacy": "Конфиденциальность",
    "settings.tab.voice": "Голос и видео",
    "settings.tab.notifications": "Уведомления",
    "settings.tab.hotkeys": "Горячие клавиши",
    "settings.tab.language": "Язык и время",
    "settings.tab.appearance": "Внешний вид",
    "settings.tab.advanced": "Расширенные",
    "settings.search": "Поиск настроек",
    "settings.logout": "Выйти из аккаунта",
    "settings.user.edit": "Редактировать профиль…",
    "settings.language.title": "Язык интерфейса",
    "settings.language.hint": "Перезагрузка не требуется — UI обновится сразу. Серверные сообщения (журнал событий, системные плашки) остаются на русском.",
    "settings.language.option.ru": "Русский",
    "settings.language.option.en": "English",
    "settings.timeformat.title": "Формат времени",
    "settings.timeformat.hint": "Автоматически — как настроена операционная система. Иначе принудительно 12/24-часовой формат.",
    "settings.timeformat.option.auto": "Автоматически",
    "settings.timeformat.option.h12": "12-часовой (AM/PM)",
    "settings.timeformat.option.h24": "24-часовой",
    "time.today": "Сегодня в",
    "time.yesterday": "Вчера в",
    "date.today": "Сегодня",
    "date.yesterday": "Вчера",
    "conn.reconnecting": "Соединение потеряно — переподключаюсь…",
    "chat.composer.message_in": "Сообщение в #{name}",
    "chat.composer.slowmode": "Медленный режим: {sec}с до следующего сообщения",
    "chat.composer.readonly": "Этот канал не принимает сообщения",
    "chat.composer.attach": "Прикрепить файлы (до {max})",
    "chat.composer.emoji": "Эмодзи",
    "chat.dropzone": "📎 Отпусти, чтобы прикрепить файлы",
    "chat.typing.one": "{a} печатает…",
    "chat.typing.two": "{a} и {b} печатают…",
    "chat.typing.many": "Несколько человек печатают…",
    "msg.react": "Реакция",
    "msg.reply": "Ответить",
    "msg.edit": "Редактировать",
    "msg.pin": "Закрепить",
    "msg.unpin": "Открепить",
    "msg.edited": " · изменено",
    "msg.you": "· вы",
    "header.pins": "Закреплённые сообщения",
    "header.search": "Поиск по сообщениям",
    "header.audit": "Журнал событий",
    "header.members.show": "Показать участников",
    "header.members.hide": "Скрыть участников",
    "pins.empty": "Пока ничего не закреплено.",
    "members.owner": "Владелец",
    "members.admins": "Администраторы",
    "members.mods": "Модераторы",
    "members.online": "В сети",
    "members.offline": "Не в сети",
    "members.none": "Никого нет",
    "voice.unmute": "Включить микрофон",
    "voice.mute": "Заглушить",
    "voice.undeafen": "Включить звук",
    "voice.deafen": "Заглушить всё",
    "voice.cam.on": "Включить камеру",
    "voice.cam.off": "Выключить камеру",
    "voice.screen.start": "Поделиться экраном",
    "voice.screen.stop": "Прекратить демо",
    "voice.leave": "Выйти",
    "voice.leaving": "Выхожу…",
    "modal.notifications": "Уведомления",
    "modal.search": "Поиск",
    "modal.audit": "Журнал событий",
    "modal.members": "Участники",
    "modal.roles": "Роли",
    "modal.invites": "Приглашения",
    "modal.wssettings": "Настройки",
    "modal.category_perms": "Права категории",
    "menu.markread": "Пометить как прочитанное",
    "menu.invite": "Пригласить",
    "menu.notif_inherit": "Как на сервере ({lvl})",
    "notif.all": "Все сообщения",
    "notif.mentions": "Только @упоминания",
    "notif.none": "Ничего (mute)",
    "notif.short.all": "все",
    "notif.short.mentions": "@упоминания",
    "notif.short.none": "ничего",
    "menu.rename": "Переименовать",
    "menu.clone": "Клонировать канал",
    "menu.copyid": "Скопировать ID",
    "menu.delete_channel": "Удалить канал",
    "menu.icon.change": "Сменить иконку",
    "menu.icon.upload": "Загрузить иконку",
    "menu.icon.remove": "Удалить иконку",
    "menu.manage_roles": "Настроить роли…",
    "menu.welcome_channel": "Канал приветствия…",
    "menu.ws_notifications": "Уведомления сервера",
    "menu.profile": "Профиль",
    "menu.dm": "Написать сообщение",
    "menu.call": "Позвонить",
    "menu.primary_role_hint": "Основная роль — меняется в списке участников",
    "menu.cat_perms": "Права категории…",
    "friends.add_placeholder": "Добавить друга по username",
    "friends.send_request": "Отправить заявку",
    "friends.tab.all": "Все",
    "friends.tab.pending": "Ожидание",
    "friends.tab.blocked": "Заблокированные",
    "friends.empty.pending": "Нет заявок",
    "friends.empty.blocked": "Никто не заблокирован",
    "friends.empty.online": "Никого нет в сети",
    "friends.empty.all": "Пока нет друзей — добавь по username выше",
    "friends.sub.pending_in": "Входящая заявка",
    "friends.sub.pending_out": "Исходящая заявка",
    "friends.sub.blocked": "Заблокирован",
    "friends.accept": "Принять",
    "friends.decline": "Отклонить",
    "friends.cancel_request": "Отменить заявку",
    "friends.unblock": "Разблокировать",
    "friends.message": "Написать",
    "friends.remove": "Удалить из друзей",
    "dm.home.title": "Личные сообщения",
    "dm.home.find_placeholder": "Найти или начать беседу — введи username",
    "dm.home.open": "Открыть",
    "dm.home.empty": "Нет начатых бесед. Введи username сверху, чтобы начать первую.",
    "dm.home.conversations": "Беседы",
    "dm.composer.message_for": "Сообщение для {name}",
    "search.placeholder": "Поиск по сообщениям…",
    "search.searching": "Ищу…",
    "search.minchars": "Введите минимум 2 символа",
    "search.none": "Ничего не найдено",
    "notifmodal.empty": "Нет уведомлений",
    "notifmodal.markall": "Прочитано всё",
    "ap.theme.title": "Тема",
    "ap.theme.dark": "Тёмная",
    "ap.theme.dark.sub": "Стандартная RuCord-тема.",
    "ap.theme.light": "Светлая",
    "ap.theme.light.sub": "Светлый интерфейс для дневного света.",
    "ap.theme.auto": "Авто",
    "ap.theme.auto.sub": "По системной настройке (prefers-color-scheme).",
    "ap.accent.title": "Акцентный цвет",
    "ap.accent.label": "Цвет",
    "ap.accent.default": "по умолчанию",
    "ap.accent.reset": "Сбросить на дефолт",
    "ap.accent.hint": "Применяется к кнопкам, выделению, ссылкам. Hover-цвет выводится автоматически.",
    "ap.density.title": "Плотность",
    "ap.density.cozy": "Уютный",
    "ap.density.cozy.sub": "Дефолтные отступы и аватары 40px.",
    "ap.density.compact": "Компактный",
    "ap.density.compact.sub": "Тоньше: меньше отступы, аватары 32px, шрифт 13px.",
    "ap.messages.title": "Сообщения",
    "ap.messages.group": "Склеивать подряд идущие сообщения одного автора",
    "ap.messages.rolecolors": "Подсвечивать имя автора цветом роли",
    "ap.gif.title": "Анимированные аватары",
    "ap.gif.always": "Проигрывать всегда",
    "ap.gif.hover": "Только при наведении",
    "ap.gif.never": "Никогда (статичный кадр)",
    "ap.gif.hint": "Анимированные баннеры профиля проигрываются всегда.",
    "nt.desktop.title": "Уведомления на рабочем столе",
    "nt.desktop.toggle": "Показывать всплывающие уведомления, когда RuCord свёрнут",
    "nt.desktop.hint": "Когда окно активно, появляется только бейдж и счётчик — система не отвлекает.",
    "nt.perm.granted": "Разрешение выдано.",
    "nt.perm.denied": "Заблокировано в браузере. Разрешите вручную в настройках сайта.",
    "nt.perm.request": "Запросить разрешение",
    "nt.sound.title": "Звук",
    "nt.sound.toggle": "Проигрывать звук при упоминании, ответе и входящем звонке",
    "nt.sound.test": "Прослушать",
    "nt.sound.hint": "Все звуки синтезируются на лету — без аудиофайлов.",
    "nt.suppress.title": "Подавление",
    "nt.suppress.everyone": "Не уведомлять про @everyone и @here",
    "nt.suppress.hint": "Сами упоминания в чате всё равно подсветятся; глушится только всплывающее уведомление и звук.",
    "sound.beep": "Бип (классика)",
    "sound.ding": "Динь",
    "sound.pop": "Поп",
    "sound.chime": "Перезвон",
    "pv.sessions.title": "Активные сеансы",
    "pv.sessions.hint": "Все устройства, на которых ты сейчас залогинен. Завершить текущий сеанс — через «Выйти из аккаунта».",
    "pv.sessions.loading": "Загрузка сессий…",
    "pv.sessions.none": "Активных сессий нет.",
    "pv.sessions.device": "Устройство",
    "pv.sessions.current": "текущая",
    "pv.sessions.meta": "Создана {created} · последний вход {seen}",
    "pv.sessions.revoke": "Завершить",
    "pv.logoutall.title": "Выйти со всех устройств",
    "pv.logoutall.hint": "Отзовёт refresh-токены всех сессий кроме текущей. Полезно если ты потерял девайс или сменил пароль.",
    "pv.export.title": "Экспорт данных",
    "pv.export.hint": "Загрузка JSON со своим профилем, сообщениями и аватарами. Скоро."
  },
  en: {
    "common.save": "Save",
    "common.cancel": "Cancel",
    "common.close": "Close",
    "common.delete": "Delete",
    "common.loading": "Loading…",
    "settings.group.account": "Account",
    "settings.group.interact": "Interaction",
    "settings.group.appearance": "Appearance",
    "settings.group.advanced": "Advanced",
    "settings.tab.profile": "Profile",
    "settings.tab.privacy": "Privacy",
    "settings.tab.voice": "Voice & video",
    "settings.tab.notifications": "Notifications",
    "settings.tab.hotkeys": "Keyboard shortcuts",
    "settings.tab.language": "Language & time",
    "settings.tab.appearance": "Appearance",
    "settings.tab.advanced": "Advanced",
    "settings.search": "Search settings",
    "settings.logout": "Log out",
    "settings.user.edit": "Edit profile…",
    "settings.language.title": "Interface language",
    "settings.language.hint": "No reload needed — the UI refreshes immediately. Server messages (audit log, system notices) remain in Russian.",
    "settings.language.option.ru": "Russian",
    "settings.language.option.en": "English",
    "settings.timeformat.title": "Time format",
    "settings.timeformat.hint": "Automatic — follows the operating system. Otherwise force 12- or 24-hour clock.",
    "settings.timeformat.option.auto": "Automatic",
    "settings.timeformat.option.h12": "12-hour (AM/PM)",
    "settings.timeformat.option.h24": "24-hour",
    "time.today": "Today at",
    "time.yesterday": "Yesterday at",
    "date.today": "Today",
    "date.yesterday": "Yesterday",
    "conn.reconnecting": "Connection lost — reconnecting…",
    "chat.composer.message_in": "Message #{name}",
    "chat.composer.slowmode": "Slow mode: {sec}s until your next message",
    "chat.composer.readonly": "This channel doesn't accept messages",
    "chat.composer.attach": "Attach files (up to {max})",
    "chat.composer.emoji": "Emoji",
    "chat.dropzone": "📎 Drop to attach files",
    "chat.typing.one": "{a} is typing…",
    "chat.typing.two": "{a} and {b} are typing…",
    "chat.typing.many": "Several people are typing…",
    "msg.react": "React",
    "msg.reply": "Reply",
    "msg.edit": "Edit",
    "msg.pin": "Pin",
    "msg.unpin": "Unpin",
    "msg.edited": " · edited",
    "msg.you": "· you",
    "header.pins": "Pinned messages",
    "header.search": "Search messages",
    "header.audit": "Audit log",
    "header.members.show": "Show members",
    "header.members.hide": "Hide members",
    "pins.empty": "Nothing pinned yet.",
    "members.owner": "Owner",
    "members.admins": "Admins",
    "members.mods": "Moderators",
    "members.online": "Online",
    "members.offline": "Offline",
    "members.none": "Nobody here",
    "voice.unmute": "Unmute",
    "voice.mute": "Mute",
    "voice.undeafen": "Undeafen",
    "voice.deafen": "Deafen",
    "voice.cam.on": "Turn on camera",
    "voice.cam.off": "Turn off camera",
    "voice.screen.start": "Share screen",
    "voice.screen.stop": "Stop sharing",
    "voice.leave": "Leave",
    "voice.leaving": "Leaving…",
    "modal.notifications": "Notifications",
    "modal.search": "Search",
    "modal.audit": "Audit log",
    "modal.members": "Members",
    "modal.roles": "Roles",
    "modal.invites": "Invites",
    "modal.wssettings": "Settings",
    "modal.category_perms": "Category permissions",
    "menu.markread": "Mark as read",
    "menu.invite": "Invite",
    "menu.notif_inherit": "Same as server ({lvl})",
    "notif.all": "All messages",
    "notif.mentions": "Only @mentions",
    "notif.none": "Nothing (mute)",
    "notif.short.all": "all",
    "notif.short.mentions": "@mentions",
    "notif.short.none": "nothing",
    "menu.rename": "Rename",
    "menu.clone": "Clone channel",
    "menu.copyid": "Copy ID",
    "menu.delete_channel": "Delete channel",
    "menu.icon.change": "Change icon",
    "menu.icon.upload": "Upload icon",
    "menu.icon.remove": "Remove icon",
    "menu.manage_roles": "Manage roles…",
    "menu.welcome_channel": "Welcome channel…",
    "menu.ws_notifications": "Server notifications",
    "menu.profile": "Profile",
    "menu.dm": "Send message",
    "menu.call": "Call",
    "menu.primary_role_hint": "Primary role — change it in the members list",
    "menu.cat_perms": "Category permissions…",
    "friends.add_placeholder": "Add a friend by username",
    "friends.send_request": "Send request",
    "friends.tab.all": "All",
    "friends.tab.pending": "Pending",
    "friends.tab.blocked": "Blocked",
    "friends.empty.pending": "No requests",
    "friends.empty.blocked": "No one is blocked",
    "friends.empty.online": "No one online",
    "friends.empty.all": "No friends yet — add one by username above",
    "friends.sub.pending_in": "Incoming request",
    "friends.sub.pending_out": "Outgoing request",
    "friends.sub.blocked": "Blocked",
    "friends.accept": "Accept",
    "friends.decline": "Decline",
    "friends.cancel_request": "Cancel request",
    "friends.unblock": "Unblock",
    "friends.message": "Message",
    "friends.remove": "Remove friend",
    "dm.home.title": "Direct messages",
    "dm.home.find_placeholder": "Find or start a conversation — enter a username",
    "dm.home.open": "Open",
    "dm.home.empty": "No conversations yet. Enter a username above to start one.",
    "dm.home.conversations": "Conversations",
    "dm.composer.message_for": "Message {name}",
    "search.placeholder": "Search messages…",
    "search.searching": "Searching…",
    "search.minchars": "Type at least 2 characters",
    "search.none": "No results",
    "notifmodal.empty": "No notifications",
    "notifmodal.markall": "Mark all read",
    "ap.theme.title": "Theme",
    "ap.theme.dark": "Dark",
    "ap.theme.dark.sub": "The default RuCord theme.",
    "ap.theme.light": "Light",
    "ap.theme.light.sub": "A light interface for daytime.",
    "ap.theme.auto": "Auto",
    "ap.theme.auto.sub": "Follows the system setting (prefers-color-scheme).",
    "ap.accent.title": "Accent color",
    "ap.accent.label": "Color",
    "ap.accent.default": "default",
    "ap.accent.reset": "Reset to default",
    "ap.accent.hint": "Applies to buttons, selection and links. The hover color is derived automatically.",
    "ap.density.title": "Density",
    "ap.density.cozy": "Cozy",
    "ap.density.cozy.sub": "Default spacing with 40px avatars.",
    "ap.density.compact": "Compact",
    "ap.density.compact.sub": "Tighter: smaller spacing, 32px avatars, 13px font.",
    "ap.messages.title": "Messages",
    "ap.messages.group": "Group consecutive messages from the same author",
    "ap.messages.rolecolors": "Color author names by their role",
    "ap.gif.title": "Animated avatars",
    "ap.gif.always": "Always play",
    "ap.gif.hover": "Only on hover",
    "ap.gif.never": "Never (static frame)",
    "ap.gif.hint": "Animated profile banners always play.",
    "nt.desktop.title": "Desktop notifications",
    "nt.desktop.toggle": "Show popup notifications while RuCord is minimized",
    "nt.desktop.hint": "While the window is active you only get the badge and counter — no system popups.",
    "nt.perm.granted": "Permission granted.",
    "nt.perm.denied": "Blocked by the browser. Allow it manually in the site settings.",
    "nt.perm.request": "Request permission",
    "nt.sound.title": "Sound",
    "nt.sound.toggle": "Play a sound on mentions, replies and incoming calls",
    "nt.sound.test": "Preview",
    "nt.sound.hint": "All sounds are synthesized on the fly — no audio files.",
    "nt.suppress.title": "Suppression",
    "nt.suppress.everyone": "Don't notify for @everyone and @here",
    "nt.suppress.hint": "Mentions are still highlighted in chat; only the popup and sound are muted.",
    "sound.beep": "Beep (classic)",
    "sound.ding": "Ding",
    "sound.pop": "Pop",
    "sound.chime": "Chime",
    "pv.sessions.title": "Active sessions",
    "pv.sessions.hint": "Every device you're signed in on. To end the current session, use “Log out”.",
    "pv.sessions.loading": "Loading sessions…",
    "pv.sessions.none": "No active sessions.",
    "pv.sessions.device": "Device",
    "pv.sessions.current": "current",
    "pv.sessions.meta": "Created {created} · last active {seen}",
    "pv.sessions.revoke": "End session",
    "pv.logoutall.title": "Log out everywhere",
    "pv.logoutall.hint": "Revokes refresh tokens of all sessions except this one. Useful if you lost a device or changed your password.",
    "pv.export.title": "Data export",
    "pv.export.hint": "Download a JSON with your profile, messages and avatars. Coming soon."
  }
};

// t("chat.typing.one", { a: "Вася" }) — плейсхолдеры вида {a} в строке
// словаря заменяются значениями vars. Без vars — как раньше.
export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = DICT[currentLocale];
  let s = dict[key] ?? DICT[DEFAULT_LOCALE][key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}
