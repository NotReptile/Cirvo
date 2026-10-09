import { getVoiceSettings } from "../../call/voiceSettings";
import { confirmDialog } from "../dialogs";
import { bindEvent } from "../dom";
import { describeError } from "../errors";
import {
  dispatchKeyDown as dispatchHotkeyDown,
  dispatchKeyUp as dispatchHotkeyUp,
  getBinding as getHotkeyBinding,
  onBindingChange,
  registerHotkey,
  releaseAllHold,
} from "../hotkeys";
import { t } from "../i18n";
import {
  getNotificationSettings,
  playNotificationSound,
} from "../notificationSettings";
import { queueRender, requestRender as render } from "../runtime";
import { uiContext } from "../state";
import {
  setHandlers as setGlobalHandlers,
  setStatusChangeListener,
  syncGlobalShortcuts,
} from "../tauriHotkeys";
import { checkForUpdate, relaunchApp } from "../tauriUpdater";
import type {
  AuditEntry,
  Channel,
  ChannelCategory,
  DMItem,
  ForumPost,
  FriendItem,
  Invite,
  Member,
  Message,
  NotifLevel,
  NotificationItem,
  NotificationPayload,
  PresenceMode,
  SearchHit,
  VoicePeekParticipant,
} from "../types";
import { formatTimeSmart } from "../util/format";
import { escapeHtml } from "../util/html";
import { authorColorStyle, describePeer } from "./callView";
import { setTransientStatus } from "./helpers";
import { mergeHistory, resetHistory } from "./history";
import { jumpToMessage, updateMessageList } from "./messageList";
import { renderBody } from "./messageView";
import { loadAllVoicePeeks, loadWorkspaces, selectWorkspace } from "./session";
import { maybeCaptureKey } from "./settingsHotkeys";
import { loadWsRoles } from "./shell";

export async function selectChannel(id: string): Promise<void> {
  resetHistory();
  uiContext.state.selectedChannelId = id;
  uiContext.state.windowStart = null;
  uiContext.state.messages = [];
  uiContext.state.editingMessageId = null;
  uiContext.state.pickerForMessageId = null;
  uiContext.state.pinsPopupOpen = false;
  uiContext.state.voicePeek = null;
  uiContext.state.replyingTo = null;
  uiContext.state.messagesCursor = null;
  uiContext.state.messagesHasMore = false;
  uiContext.state.messagesLoadingOlder = false;
  uiContext.state.stickToBottom = true;
  uiContext.state.restoreScrollBottom = null;
  uiContext.state.selectedChannelLastReadAt = null;
  render();
  const ch = uiContext.state.channels.find((c) => c.id === id);
  if (ch?.kind === "voice") {
    try {
      const data = await uiContext.httpClient.get<{
        items: VoicePeekParticipant[];
      }>(`/api/v1/channels/${id}/voice/participants`);
      if (uiContext.state.selectedChannelId === id) {
        uiContext.state.voicePeek = {
          channelId: id,
          participants: data.items ?? [],
        };
        render();
      }
    } catch (err) {
      uiContext.state.status = describeError(err);
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
    uiContext.httpClient
      .get<{ lastReadAt?: string }>(`/api/v1/channels/${id}/read`)
      .catch(() => ({}) as { lastReadAt?: string }),
    uiContext.httpClient.get<{ items: Message[]; nextCursor?: string }>(
      `/api/v1/channels/${id}/messages?limit=50`,
    ),
  ]);
  if (uiContext.state.selectedChannelId !== id) return; // юзер уже сменил канал
  uiContext.state.messages = (data.items ?? []).slice().reverse();
  uiContext.state.messagesCursor = data.nextCursor || null;
  uiContext.state.messagesHasMore = !!data.nextCursor;
  uiContext.state.stickToBottom = true;
  uiContext.state.selectedChannelLastReadAt = readState.lastReadAt ?? null;
  uiContext.state.unread[id] = 0;
  // G.8: если это DM — обнулим unread на айтеме и пересчитаем total для badge.
  const dmIdx = uiContext.state.dms.findIndex((d) => d.channelId === id);
  if (dmIdx >= 0) {
    const next = uiContext.state.dms.slice();
    next[dmIdx] = { ...next[dmIdx], unreadCount: 0 };
    uiContext.state.dms = next;
    uiContext.state.dmUnreadTotal = uiContext.state.dms.reduce(
      (acc, d) => acc + (d.unreadCount ?? 0),
      0,
    );
  }
  render();
  // Авто-отметка прочитанным: последнее сообщение текущей выборки
  // (если оно не моё — иначе незачем). Не ждём ответа.
  const last = uiContext.state.messages[uiContext.state.messages.length - 1];
  if (last && last.authorId !== uiContext.state.me?.id) {
    void markChannelRead(id, last.id);
  }
}

// Wave 9: загрузка постов форума. Вызывается из selectChannel и из
// realtime-обработчиков (новый тред / новое сообщение в треде), когда
// открыт родительский форум.
// keepCurrent=true — refresh по realtime-событию: старые карточки остаются
// видимыми, пока грузится свежий список (без мигания). false (вход в
// канал) — чистим, чтобы не мелькали посты предыдущего форума.
export async function loadForumPosts(
  channelId: string,
  keepCurrent = false,
): Promise<void> {
  uiContext.state.forumPostsLoading = true;
  if (!keepCurrent) {
    uiContext.state.forumPosts = [];
  }
  render();
  try {
    const data = await uiContext.httpClient.get<{ items: ForumPost[] }>(
      `/api/v1/channels/${channelId}/forum/posts`,
    );
    if (uiContext.state.selectedChannelId !== channelId) return;
    uiContext.state.forumPosts = data.items ?? [];
  } catch (err) {
    if (uiContext.state.selectedChannelId !== channelId) return;
    uiContext.state.forumPosts = [];
    uiContext.state.status = describeError(err);
  } finally {
    if (uiContext.state.selectedChannelId === channelId) {
      uiContext.state.forumPostsLoading = false;
      render();
    }
  }
}

export async function loadUnread(
  workspaceId: string,
  generation?: number,
): Promise<void> {
  try {
    const data = await uiContext.httpClient.get<{
      items: { channelId: string; unreadCount: number }[];
    }>(`/api/v1/workspaces/${workspaceId}/unread`);
    if (
      uiContext.state.selectedWorkspaceId !== workspaceId ||
      (generation !== undefined && generation !== uiContext.syncGeneration)
    )
      return;
    const map: Record<string, number> = {};
    for (const it of data.items ?? []) {
      // Активный канал считается прочитанным, не надо мигать badge'м на нём.
      map[it.channelId] =
        it.channelId === uiContext.state.selectedChannelId ? 0 : it.unreadCount;
    }
    uiContext.state.unread = map;
    queueRender("all");
  } catch (err) {
    uiContext.state.status = describeError(err);
  }
}

// F.8: проверка обновлений на старте сессии + раз в 6 часов. На web/mobile
// checkForUpdate() отдаёт null — баннер не появляется. Сначала показываем
// «Что нового», если прошлый запуск завершился установкой обновления.
export async function initUpdateCheck(): Promise<void> {
  if (uiContext.updateCheckStarted) return; // re-login не должен плодить интервалы
  uiContext.updateCheckStarted = true;
  try {
    const raw = localStorage.getItem("rucord:pending-changelog");
    if (raw) {
      localStorage.removeItem("rucord:pending-changelog");
      const data = JSON.parse(raw) as { version: string; notes?: string };
      void confirmDialog({
        title: `RuCord обновлён до v${data.version}`,
        body: data.notes?.trim() || "Обновление установлено.",
        confirmLabel: "Ок",
      });
    }
  } catch {
    /* битый JSON в localStorage — просто пропускаем */
  }
  const recheck = async () => {
    if (uiContext.updatePhase !== "idle") return; // уже нашли/качаем
    const upd = await checkForUpdate(
      uiContext.httpClient.baseUrl,
      uiContext.httpClient.getTokens()?.accessToken ?? null,
    );
    if (!upd || uiContext.updatePhase !== "idle") return;
    uiContext.updateHandle = upd;
    uiContext.updatePhase = "available";
    render();
  };
  void recheck();
  window.setInterval(() => void recheck(), 6 * 3600 * 1000);
}

export async function startUpdateInstall(): Promise<void> {
  if (
    !uiContext.updateHandle ||
    uiContext.updatePhase === "downloading" ||
    uiContext.updatePhase === "ready"
  )
    return;
  uiContext.updatePhase = "downloading";
  uiContext.updatePct = null;
  render();
  try {
    await uiContext.updateHandle.install((pct) => {
      // Прогресс — прямой DOM-mutate: render() на каждый chunk дёргал бы
      // фокус и пересоздавал message-list.
      uiContext.updatePct = pct;
      const el = uiContext.rootEl.querySelector<HTMLElement>(
        "#update-banner-text",
      );
      if (el)
        el.textContent =
          pct === null
            ? "Скачиваю обновление…"
            : `Скачиваю обновление… ${pct}%`;
    });
    // «Что нового» покажем после перезапуска уже новой версией.
    localStorage.setItem(
      "rucord:pending-changelog",
      JSON.stringify({
        version: uiContext.updateHandle.version,
        notes: uiContext.updateHandle.notes ?? "",
      }),
    );
    uiContext.updatePhase = "ready";
    render();
    await relaunchApp();
  } catch (err) {
    uiContext.updatePhase = "available";
    uiContext.state.status = describeError(err);
    render();
  }
}

export function renderUpdateBanner(): string {
  if (uiContext.updatePhase === "available" && uiContext.updateHandle) {
    return `
      <div class="update-banner" role="status">
        <span id="update-banner-text">Доступно обновление v${escapeHtml(uiContext.updateHandle.version)}</span>
        <button id="update-install">Установить</button>
      </div>
    `;
  }
  if (uiContext.updatePhase === "downloading") {
    return `
      <div class="update-banner" role="status">
        <span class="conn-banner-spinner update-banner-spinner"></span>
        <span id="update-banner-text">Скачиваю обновление…${uiContext.updatePct !== null ? ` ${uiContext.updatePct}%` : ""}</span>
      </div>
    `;
  }
  if (uiContext.updatePhase === "ready") {
    return `<div class="update-banner" role="status"><span>Обновление установлено — перезапуск…</span></div>`;
  }
  return "";
}

// Авторитетный resync. Generation token не даёт медленному ответу от старого
// reconnect перезаписать состояние, уже полученное более новым циклом.
export async function resyncAfterReconnect(
  cursorToAcknowledge?: number,
): Promise<void> {
  const generation = ++uiContext.syncGeneration;
  const previousWorkspace = uiContext.state.selectedWorkspaceId;
  try {
    await loadWorkspaces(generation);
    if (generation !== uiContext.syncGeneration) return;

    const workspaceId =
      uiContext.state.selectedWorkspaceId ?? previousWorkspace;
    if (
      workspaceId &&
      uiContext.state.workspaces.some((w) => w.id === workspaceId)
    ) {
      const [channelsResp, categoriesResp] = await Promise.all([
        uiContext.httpClient.get<{ items: Channel[] }>(
          `/api/v1/workspaces/${workspaceId}/channels`,
        ),
        uiContext.httpClient
          .get<{ items: ChannelCategory[] }>(
            `/api/v1/workspaces/${workspaceId}/categories`,
          )
          .catch(() => ({ items: [] })),
      ]);
      if (
        generation !== uiContext.syncGeneration ||
        uiContext.state.selectedWorkspaceId !== workspaceId
      )
        return;
      uiContext.state.channels = channelsResp.items ?? [];
      uiContext.state.categories = categoriesResp.items ?? [];
      if (
        uiContext.state.selectedChannelId &&
        !uiContext.state.channels.some(
          (c) => c.id === uiContext.state.selectedChannelId,
        ) &&
        !uiContext.state.dms.some(
          (d) => d.channelId === uiContext.state.selectedChannelId,
        )
      ) {
        uiContext.state.selectedChannelId = null;
        uiContext.state.messages = [];
      }
      await Promise.all([
        loadMembers(generation),
        loadUnread(workspaceId, generation),
        loadWsRoles(workspaceId, generation),
        loadAllVoicePeeks(workspaceId, generation),
      ]);
    }
    await Promise.all([
      loadNotifications(generation),
      loadDMs(generation),
      loadFriends(generation),
      backfillSelectedChannel(generation),
    ]);
    if (generation !== uiContext.syncGeneration) return;
    if (cursorToAcknowledge !== undefined)
      uiContext.realtimeClient.completeSnapshot(cursorToAcknowledge);
    render();
  } catch (err) {
    if (generation === uiContext.syncGeneration)
      uiContext.state.status = describeError(err);
  }
}

// Догружает сообщения активного канала, пришедшие пока сокет лежал.
// Если разрыв был коротким — дописываем хвост (по id-дедупу), скролл не
// дёргается. Если за время разрыва пришло >50 сообщений (нет пересечения
// с локальным списком) — заменяем окно целиком, как при входе в канал.
export async function backfillSelectedChannel(
  generation?: number,
): Promise<void> {
  const id = uiContext.state.selectedChannelId;
  if (!id) return;
  const ch = uiContext.state.channels.find((c) => c.id === id);
  if (ch?.kind === "voice") return;
  try {
    const data = await uiContext.httpClient.get<{
      items: Message[];
      nextCursor?: string;
    }>(`/api/v1/channels/${id}/messages?limit=50`);
    if (
      uiContext.state.selectedChannelId !== id ||
      (generation !== undefined && generation !== uiContext.syncGeneration)
    )
      return;
    const fresh = (data.items ?? []).slice().reverse();
    if (fresh.length === 0) return;
    const known = new Set(uiContext.state.messages.map((m) => m.id));
    const overlap = fresh.some((m) => known.has(m.id));
    if (!overlap && uiContext.state.messages.length > 0) {
      uiContext.state.messages = fresh;
      uiContext.state.messagesCursor = data.nextCursor || null;
      uiContext.state.messagesHasMore = !!data.nextCursor;
      uiContext.state.stickToBottom = true;
    } else {
      const lastTs =
        uiContext.state.messages.length > 0
          ? uiContext.state.messages[uiContext.state.messages.length - 1]
              .createdAt
          : "";
      const appended = fresh.filter(
        (m) => !known.has(m.id) && m.createdAt > lastTs,
      );
      if (appended.length === 0) return;
      uiContext.state.messages = [...uiContext.state.messages, ...appended];
    }
    render();
  } catch {
    /* тихо — следующий reconnect повторит */
  }
}

// G.8: загрузка DM-листа. Зовётся на bootstrap и при входе в DM-режим
// (чтобы освежить lastMessageAt/unread, если что-то пришло пока юзер был в ws).
export async function loadDMs(generation?: number): Promise<void> {
  uiContext.state.dmsLoading = true;
  try {
    const data = await uiContext.httpClient.get<{ items: DMItem[] }>(
      "/api/v1/dm",
    );
    if (generation !== undefined && generation !== uiContext.syncGeneration)
      return;
    uiContext.state.dms = (data.items ?? []).map((d) => ({
      ...d,
      unreadCount:
        d.channelId === uiContext.state.selectedChannelId ? 0 : d.unreadCount,
    }));
    uiContext.state.dmUnreadTotal = uiContext.state.dms.reduce(
      (acc, d) => acc + (d.unreadCount ?? 0),
      0,
    );
  } catch (err) {
    uiContext.state.status = describeError(err);
  } finally {
    uiContext.state.dmsLoading = false;
    queueRender("all");
  }
}

// Find-or-create DM с пиром (по userId или username). На успех — открыть
// канал. backend идемпотентен, повторный вызов вернёт существующий.
export async function openDMWith(req: {
  userId?: string;
  username?: string;
}): Promise<void> {
  if (uiContext.state.dmOpening) return;
  uiContext.state.dmOpening = true;
  uiContext.state.dmFindError = null;
  render();
  try {
    const dm = await uiContext.httpClient.post<DMItem>("/api/v1/dm", req);
    // upsert в state.dms
    const idx = uiContext.state.dms.findIndex(
      (d) => d.channelId === dm.channelId,
    );
    if (idx < 0) {
      uiContext.state.dms = [dm, ...uiContext.state.dms];
    } else {
      const next = uiContext.state.dms.slice();
      next[idx] = { ...dm, unreadCount: 0 };
      uiContext.state.dms = next;
    }
    uiContext.state.dmMode = true;
    uiContext.state.dmFindQuery = "";
    await selectChannel(dm.channelId);
  } catch (err) {
    uiContext.state.dmFindError = describeError(err);
    render();
  } finally {
    uiContext.state.dmOpening = false;
    render();
  }
}

// Переключение в DM-режим (клик на «домик» над ws-rail). Не сбрасываем
// selectedChannelId — он может указывать на DM-канал (тогда сразу его
// откроем). Иначе остаёмся на home-экране со списком DM.
export function enterDMMode(): void {
  uiContext.state.dmMode = true;
  uiContext.state.dmFindError = null;
  // Если selectedChannelId указывает на workspace-канал — сбросим выбор,
  // чтобы content показал home-экран DM (а не сообщения чужого канала).
  const isDmChannel = uiContext.state.dms.some(
    (d) => d.channelId === uiContext.state.selectedChannelId,
  );
  if (!isDmChannel) {
    uiContext.state.selectedChannelId = null;
    uiContext.state.messages = [];
  }
  render();
  void loadDMs();
  void loadFriends();
}

export function exitDMMode(workspaceId: string): void {
  uiContext.state.dmMode = false;
  uiContext.state.dmFindError = null;
  void selectWorkspace(workspaceId);
}

export function isNotifLevel(v: string | undefined): v is NotifLevel {
  return v === "all" || v === "mentions" || v === "none";
}

// Эффективный уровень: явный канальный ← workspace ← 'all'. DM-каналы
// workspace'а не имеют — для них работает только канальный уровень.
export function channelNotifLevel(channelId: string): NotifLevel {
  const explicit = uiContext.state.notifPrefs.channels[channelId];
  if (isNotifLevel(explicit)) return explicit;
  const ch = uiContext.state.channels.find((c) => c.id === channelId);
  const wsLevel = ch
    ? uiContext.state.notifPrefs.workspaces[ch.workspaceId]
    : undefined;
  if (isNotifLevel(wsLevel)) return wsLevel;
  return "all";
}

export function isChannelMuted(channelId: string): boolean {
  return channelNotifLevel(channelId) === "none";
}

export async function loadNotifPrefs(): Promise<void> {
  try {
    const data = await uiContext.httpClient.get<{
      channels: Record<string, string>;
      workspaces: Record<string, string>;
    }>("/api/v1/users/me/notification-prefs");
    uiContext.state.notifPrefs = {
      channels: data.channels ?? {},
      workspaces: data.workspaces ?? {},
    };
    queueRender("all");
  } catch {
    /* prefs не критичны — остаёмся на 'all' */
  }
}

export async function setChannelNotifLevel(
  channelId: string,
  level: NotifLevel | "",
): Promise<void> {
  try {
    await uiContext.httpClient.put(
      `/api/v1/channels/${channelId}/notification-pref`,
      { level },
    );
    if (level === "") delete uiContext.state.notifPrefs.channels[channelId];
    else uiContext.state.notifPrefs.channels[channelId] = level;
    render();
  } catch (err) {
    uiContext.state.status = describeError(err);
    render();
  }
}

export async function setWorkspaceNotifLevel(
  workspaceId: string,
  level: NotifLevel | "",
): Promise<void> {
  try {
    await uiContext.httpClient.put(
      `/api/v1/workspaces/${workspaceId}/notification-pref`,
      { level },
    );
    if (level === "") delete uiContext.state.notifPrefs.workspaces[workspaceId];
    else uiContext.state.notifPrefs.workspaces[workspaceId] = level;
    render();
  } catch (err) {
    uiContext.state.status = describeError(err);
    render();
  }
}

// ---- Wave 3: друзья ---------------------------------------------------------

export async function loadFriends(generation?: number): Promise<void> {
  uiContext.state.friendsLoading = true;
  try {
    const data = await uiContext.httpClient.get<{ items: FriendItem[] }>(
      "/api/v1/friends",
    );
    if (generation !== undefined && generation !== uiContext.syncGeneration)
      return;
    uiContext.state.friends = data.items ?? [];
    uiContext.state.blockedIds = new Set(
      uiContext.state.friends
        .filter((f) => f.status === "blocked")
        .map((f) => f.userId),
    );
  } catch (err) {
    uiContext.state.status = describeError(err);
  } finally {
    uiContext.state.friendsLoading = false;
    queueRender("all");
  }
}

export async function sendFriendRequest(username: string): Promise<void> {
  uiContext.state.friendAddError = null;
  uiContext.state.friendAddOk = null;
  try {
    const res = await uiContext.httpClient.post<{ status: string }>(
      "/api/v1/friends/requests",
      { username },
    );
    uiContext.state.friendAddOk =
      res.status === "accepted"
        ? `Вы теперь друзья с @${username}`
        : `Заявка отправлена @${username}`;
    await loadFriends();
  } catch (err) {
    uiContext.state.friendAddError = describeError(err);
    render();
  }
}

export async function friendAction(
  userId: string,
  action: "accept" | "remove" | "block" | "unblock",
): Promise<void> {
  try {
    if (action === "accept") {
      await uiContext.httpClient.post(`/api/v1/friends/${userId}/accept`, {});
    } else if (action === "remove") {
      await uiContext.httpClient.del(`/api/v1/friends/${userId}`);
    } else if (action === "block") {
      await uiContext.httpClient.put(`/api/v1/friends/${userId}/block`, {});
    } else {
      await uiContext.httpClient.del(`/api/v1/friends/${userId}/block`);
    }
    await loadFriends();
  } catch (err) {
    uiContext.state.status = describeError(err);
    render();
  }
}

export async function markChannelRead(
  channelId: string,
  messageId: string,
): Promise<void> {
  try {
    await uiContext.httpClient.post(`/api/v1/channels/${channelId}/read`, {
      messageId,
    });
  } catch {
    // молча — read-receipt не критичен
  }
}

export async function loadOlderMessages(
  channelId: string,
  list: HTMLDivElement,
): Promise<void> {
  if (uiContext.state.messagesLoadingOlder || !uiContext.state.messagesCursor)
    return;
  const cursor = uiContext.state.messagesCursor;
  // Сохраняем расстояние от низа списка ДО prepend — после ре-рендера
  // выставим scrollTop так, чтобы видимая «нижняя граница» осталась той же.
  const savedBottomOffset =
    list.scrollHeight - list.scrollTop - list.clientHeight;
  uiContext.state.messagesLoadingOlder = true;
  try {
    const data = await uiContext.httpClient.get<{
      items: Message[];
      nextCursor?: string;
    }>(
      `/api/v1/channels/${channelId}/messages?limit=50&before=${encodeURIComponent(cursor)}`,
    );
    if (uiContext.state.selectedChannelId !== channelId) return;
    const older = (data.items ?? []).slice().reverse();
    if (older.length === 0) {
      uiContext.state.messagesHasMore = false;
      uiContext.state.messagesCursor = null;
      return;
    }
    const anchor = uiContext.state.messages[0];
    mergeHistory(anchor ? [...older, anchor] : older);
    uiContext.state.windowStart = 0;
    uiContext.state.messagesCursor = data.nextCursor || null;
    uiContext.state.messagesHasMore = !!data.nextCursor;
    uiContext.state.restoreScrollBottom = null;
    uiContext.state.stickToBottom = false;
    updateMessageList();
  } catch (err) {
    uiContext.state.status = describeError(err);
  } finally {
    uiContext.state.messagesLoadingOlder = false;
  }
}

export async function runSearch(query: string): Promise<void> {
  const wsId = uiContext.state.selectedWorkspaceId;
  const q = query.trim();
  uiContext.state.search.query = q;
  if (!wsId || q.length < 2) {
    uiContext.state.search.loading = false;
    uiContext.state.search.hits = [];
    uiContext.state.search.error = null;
    render();
    return;
  }
  const myToken = ++uiContext.searchToken;
  uiContext.state.search.loading = true;
  uiContext.state.search.error = null;
  render();
  try {
    const data = await uiContext.httpClient.get<{ items: SearchHit[] }>(
      `/api/v1/workspaces/${wsId}/search?q=${encodeURIComponent(q)}&limit=25`,
    );
    if (myToken !== uiContext.searchToken) return;
    uiContext.state.search.hits = data.items ?? [];
    uiContext.state.search.loading = false;
    render();
  } catch (err) {
    if (myToken !== uiContext.searchToken) return;
    uiContext.state.search.loading = false;
    uiContext.state.search.error = describeError(err);
    uiContext.state.search.hits = [];
    render();
  }
}

// Прыжок к сообщению из результатов: переключиться на канал, дождаться
// загрузки списка, попытаться найти DOM-узел и подсветить. Если
// сообщение вне первой страницы — просто переключаем канал (lazy
// pagination C.4 подгрузит при скролле вверх).
export async function jumpToSearchHit(hit: SearchHit): Promise<void> {
  uiContext.state.modal = null;
  if (hit.channelId !== uiContext.state.selectedChannelId)
    await selectChannel(hit.channelId);
  render();
  await jumpToMessage(hit.id);
}

// C.8 — in-app уведомления.

export async function loadNotifications(generation?: number): Promise<void> {
  uiContext.state.notificationsLoading = true;
  try {
    const [list, count] = await Promise.all([
      uiContext.httpClient.get<{ items: NotificationItem[] }>(
        "/api/v1/notifications?limit=30",
      ),
      uiContext.httpClient.get<{ unread: number }>(
        "/api/v1/notifications/count",
      ),
    ]);
    if (generation !== undefined && generation !== uiContext.syncGeneration)
      return;
    uiContext.state.notifications = list.items ?? [];
    uiContext.state.notificationsUnread = count.unread ?? 0;
  } catch (err) {
    uiContext.state.status = describeError(err);
  } finally {
    uiContext.state.notificationsLoading = false;
    queueRender("all");
  }
}

export function handleIncomingNotification(p: {
  id: string;
  kind: NotificationItem["kind"];
  createdAt: string;
  payload: NotificationPayload;
}): void {
  // Дедуп: если уже видели (мульти-сессия одного юзера) — игнорируем.
  if (uiContext.state.notifications.some((n) => n.id === p.id)) return;
  const item: NotificationItem = {
    id: p.id,
    kind: p.kind,
    payload: p.payload,
    createdAt: p.createdAt,
  };
  // Если сообщение пришло в активный канал — юзер уже его видит,
  // не надо вешать badge и держать notification «unread». Звонкам
  // (call_incoming) приходит без channelId — их не глушим.
  const inActiveChannel =
    !!item.payload.channelId &&
    item.payload.channelId === uiContext.state.selectedChannelId &&
    item.kind !== "call_incoming";
  if (inActiveChannel) {
    item.readAt = new Date().toISOString();
    void uiContext.httpClient
      .post(`/api/v1/notifications/${item.id}/read`)
      .catch(() => {
        /* idempotent */
      });
  }
  uiContext.state.notifications = [
    item,
    ...uiContext.state.notifications,
  ].slice(0, 50);
  if (!item.readAt) {
    uiContext.state.notificationsUnread += 1;
  }
  render();
  if (!inActiveChannel) {
    maybeShowBrowserNotification(item);
  }
}

// Браузерное уведомление показываем ТОЛЬКО когда окно неактивно
// (document.hidden). Когда юзер активен — обновится badge + dropdown,
// дёргать системный popup незачем.
export function maybeShowBrowserNotification(item: NotificationItem): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && document.visibilityState !== "hidden")
    return;
  // H.8: DnD — пользователь явно попросил не беспокоить. Подавляем
  // системные popup'ы. Badge + dropdown в UI всё равно обновятся.
  if (uiContext.state.me?.presenceMode === "dnd") return;
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

export function notificationTitle(item: NotificationItem): string {
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

export function notificationBody(item: NotificationItem): string {
  if (item.kind === "call_incoming") return "Нажмите, чтобы открыть RuCord";
  if (item.kind === "friend_request")
    return "Откройте вкладку «Друзья», чтобы ответить";
  if (item.kind === "friend_accept") return "";
  return item.payload.snippet ?? "";
}

// H.8: PUT /users/me/status. mode="online" + custom="" → сброс к дефолту.
export async function saveStatus(
  mode: PresenceMode,
  customStatus: string,
): Promise<void> {
  try {
    const updated = await uiContext.httpClient.put<{
      presenceMode?: PresenceMode;
      customStatus?: string;
    }>("/api/v1/users/me/status", { mode, customStatus });
    if (uiContext.state.me) {
      uiContext.state.me.presenceMode =
        (updated.presenceMode as PresenceMode | undefined) ?? mode;
      uiContext.state.me.customStatus = updated.customStatus ?? "";
    }
    // H.8.i: сбрасываем флаг автоматически выставленного idle когда юзер
    // (или мы сами) уводит mode прочь от idle. Иначе idleAutoSet может
    // протечь через ручные переключения, и activity-handler ложно сочтёт
    // следующий manual-idle нашим.
    if (mode !== "idle") {
      uiContext.idleAutoSet = false;
    }
    uiContext.state.statusMenu = null;
    render();
  } catch (err) {
    uiContext.state.status = describeError(err);
    render();
  }
}

// I.9(b): ручной toggleMute должен отменить отложенный PTT-mute. Иначе
// сценарий «отпустил клавишу → manual unmute → через N мс PTT delay
// сработает и снова замьютит» оставляет UI и реальное состояние
// рассинхронизированными. Вызывается из всех точек toggleMute (hotkey,
// strip-кнопка, call-bar-кнопка, Tauri-global).
export function manualToggleMute(): void {
  if (uiContext._pttReleaseTimer) {
    clearTimeout(uiContext._pttReleaseTimer);
    uiContext._pttReleaseTimer = null;
    uiContext._pttHeld = false;
    updatePttIndicator();
  }
  if (uiContext.voiceMgr.isActive()) uiContext.voiceMgr.toggleMute();
  if (uiContext.callMgr.isActive()) uiContext.callMgr.toggleMute();
}

// K.4: deafen-toggle вынесен из hotkeys-handler в named-функцию,
// чтобы тот же handler можно было дёрнуть из кнопки в voice-strip /
// call-bar. Глушит все remote-стримы (`<video>` с поток-attribute'ами)
// и сам микрофон, чтобы «глухой» юзер физически не говорил.
export function toggleDeafen(): void {
  uiContext._deafened = !uiContext._deafened;
  for (const el of uiContext.rootEl.querySelectorAll<HTMLVideoElement>(
    "video[data-voice-peer], video[data-call-remote]",
  )) {
    el.muted = uiContext._deafened;
  }
  if (uiContext._deafened) {
    if (uiContext.voiceMgr.isActive()) uiContext.voiceMgr.setMute(true);
    if (uiContext.callMgr.isActive()) uiContext.callMgr.setMute(true);
  }
  setTransientStatus(uiContext._deafened ? "Заглушено" : "Звук включён");
  render();
}

export function isDeafened(): boolean {
  return uiContext._deafened;
}

export function updatePttIndicator(): void {
  // Прямой DOM-mutate, без render() — иначе сорвался бы фокус композера
  // при каждом keydown PTT. CSS-класс на strip управляет цветом mic-иконки.
  const isPtt = getVoiceSettings().pushToTalk;
  for (const el of uiContext.rootEl.querySelectorAll<HTMLElement>(
    ".voice-strip, .call-bar",
  )) {
    el.classList.toggle("ptt-mode", isPtt);
    el.classList.toggle("ptt-active", isPtt && uiContext._pttHeld);
  }
}

// I.9: применить PTT-mode к активным сессиям. Вызывается из join/leave-flow'ов
// (selectChannel для voice, placeCall, acceptCall) и из voice-settings, когда
// юзер переключил флаг. PTT гейтит передачу звука через setPttGate, НЕ трогая
// видимый mute — микрофон в PTT-режиме остаётся «включённым» (Discord-стиль).
export function applyPttModeToActiveSessions(): void {
  const pt = getVoiceSettings().pushToTalk;
  if (!pt) {
    // PTT выключили — гейт открываем (звук течёт по обычному mute-флагу).
    if (uiContext.voiceMgr.isActive()) uiContext.voiceMgr.setPttGate(true);
    if (uiContext.callMgr.isActive()) uiContext.callMgr.setPttGate(true);
    updatePttIndicator();
    return;
  }
  // PTT включён: пока клавиша не зажата — гейт закрыт.
  const open = uiContext._pttHeld;
  if (uiContext.voiceMgr.isActive()) uiContext.voiceMgr.setPttGate(open);
  if (uiContext.callMgr.isActive()) uiContext.callMgr.setPttGate(open);
  updatePttIndicator();
}

// PTT keydown: открываем гейт (звук пошёл). Общая функция для window- и
// global-хендлеров — раньше код дублировался дважды.
export function pttDown(): void {
  if (uiContext._pttReleaseTimer) {
    clearTimeout(uiContext._pttReleaseTimer);
    uiContext._pttReleaseTimer = null;
  }
  uiContext._pttHeld = true;
  if (uiContext._deafened) return; // deafen перебивает PTT — глухой не говорит
  if (uiContext.voiceMgr.isActive()) uiContext.voiceMgr.setPttGate(true);
  if (uiContext.callMgr.isActive()) uiContext.callMgr.setPttGate(true);
  updatePttIndicator();
}

// PTT keyup: закрываем гейт (с опциональным release-delay, чтобы хвост фразы
// не обрезался). Видимый mute не трогаем.
export function pttUp(): void {
  const delay = Math.max(0, getVoiceSettings().pttReleaseDelay | 0);
  const finish = (): void => {
    uiContext._pttHeld = false;
    uiContext._pttReleaseTimer = null;
    if (uiContext.voiceMgr.isActive()) uiContext.voiceMgr.setPttGate(false);
    if (uiContext.callMgr.isActive()) uiContext.callMgr.setPttGate(false);
    updatePttIndicator();
  };
  if (delay > 0) {
    uiContext._pttReleaseTimer = setTimeout(finish, delay);
  } else {
    finish();
  }
}

export function installGlobalKeyboardShortcuts(): void {
  if (uiContext.globalShortcutsInstalled) return;
  uiContext.globalShortcutsInstalled = true;
  registerHotkeyActions();
  bindEvent(
    window,
    "keydown",
    (ev) => {
      // I.4: capture-режим в hotkeys-табе перехватывает всё первым,
      // иначе нажатие Ctrl+K сразу бы открыло Quick Switcher.
      if (maybeCaptureKey(ev)) return;
      if (ev.key === "Escape") {
        if (uiContext.state.statusMenu) {
          uiContext.state.statusMenu = null;
          render();
          return;
        }
        if (uiContext.state.workspaceMenuOpen) {
          uiContext.state.workspaceMenuOpen = false;
          render();
          return;
        }
        if (uiContext.state.channelMenu) {
          uiContext.state.channelMenu = null;
          render();
          return;
        }
        if (uiContext.state.workspaceMenu) {
          uiContext.state.workspaceMenu = null;
          render();
          return;
        }
        if (uiContext.state.pinsPopupOpen) {
          uiContext.state.pinsPopupOpen = false;
          render();
          return;
        }
        if (uiContext.state.modal) {
          uiContext.state.modal = null;
          uiContext.state.userProfileTarget = null;
          uiContext.state.userProfileData = null;
          render();
          return;
        }
      }
      if (!uiContext.state.me) return;
      dispatchHotkeyDown(ev);
    },
    "bind-75902",
  );
  bindEvent(
    window,
    "keyup",
    (ev) => {
      dispatchHotkeyUp(ev);
    },
    "bind-76940",
  );
  // Alt+Tab / window blur — отпускаем все hold'ы (PTT), иначе микрофон
  // мог бы залипнуть «включённым» когда юзер ушёл в другое окно.
  bindEvent(
    window,
    "blur",
    () => {
      releaseAllHold();
    },
    "bind-77155",
  );
}

export function registerHotkeyActions(): void {
  registerHotkey("toggle-mute", () => manualToggleMute());
  registerHotkey("toggle-deafen", () => toggleDeafen());
  registerHotkey("toggle-camera", async () => {
    if (uiContext.voiceMgr.isActive()) await uiContext.voiceMgr.toggleCamera();
    else if (uiContext.callMgr.isActive())
      await uiContext.callMgr.toggleCamera();
  });
  registerHotkey("toggle-screen-share", async () => {
    if (uiContext.voiceMgr.isActive())
      await uiContext.voiceMgr.toggleScreenShare();
    else if (uiContext.callMgr.isActive())
      await uiContext.callMgr.toggleScreenShare();
  });
  registerHotkey("voice-disconnect", async () => {
    if (uiContext.voiceMgr.isActive()) await uiContext.voiceMgr.leave();
  });
  registerHotkey("push-to-talk", {
    down: () => pttDown(),
    up: () => pttUp(),
  });
  registerHotkey("quick-switcher", () => {
    if (!uiContext.state.selectedWorkspaceId) return;
    uiContext.state.modal = "search";
    render();
    setTimeout(() => {
      uiContext.rootEl
        .querySelector<HTMLInputElement>("#search-input")
        ?.focus();
    }, 0);
  });
  registerHotkey("search", () => {
    if (!uiContext.state.selectedWorkspaceId) return;
    uiContext.state.modal = "search";
    render();
    setTimeout(() => {
      uiContext.rootEl
        .querySelector<HTMLInputElement>("#search-input")
        ?.focus();
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
  setGlobalHandlers("toggle-camera", {
    tap: async () => {
      if (uiContext.voiceMgr.isActive())
        await uiContext.voiceMgr.toggleCamera();
      else if (uiContext.callMgr.isActive())
        await uiContext.callMgr.toggleCamera();
    },
  });
  setGlobalHandlers("toggle-screen-share", {
    tap: async () => {
      if (uiContext.voiceMgr.isActive())
        await uiContext.voiceMgr.toggleScreenShare();
      else if (uiContext.callMgr.isActive())
        await uiContext.callMgr.toggleScreenShare();
    },
  });
  setGlobalHandlers("voice-disconnect", {
    tap: async () => {
      if (uiContext.voiceMgr.isActive()) await uiContext.voiceMgr.leave();
    },
  });
  setGlobalHandlers("push-to-talk", {
    down: () => pttDown(),
    up: () => pttUp(),
  });

  // Первичная синхронизация + подписка на rebind-события.
  void syncGlobalShortcuts(getHotkeyBinding);
  onBindingChange(() => {
    void syncGlobalShortcuts(getHotkeyBinding);
  });
  // #5c: после async-регистрации перерисовываем hotkeys-таб, чтобы индикатор
  // «глобально» показал актуальный статус (registered/failed/unsupported).
  setStatusChangeListener(() => {
    if (
      uiContext.state.modal === "settings" &&
      uiContext.state.settings.tab === "hotkeys"
    )
      render();
  });
}

// I.4(3): edit-last-message helper. Возвращает true если нашли своё последнее
// сообщение и переключили в edit-mode. Не зовёт ev.preventDefault — это
// делает caller (в композере / global-dispatcher).
export function tryEditLastOwnMessage(): boolean {
  const myId = uiContext.state.me?.id;
  if (!myId) return false;
  for (let i = uiContext.state.messages.length - 1; i >= 0; i--) {
    const m = uiContext.state.messages[i];
    if (m.authorId !== myId) continue;
    if (m.kind && m.kind !== "user") continue;
    if (m.deletedAt) continue;
    uiContext.state.editingMessageId = m.id;
    uiContext.state.pickerForMessageId = null;
    render();
    return true;
  }
  return false;
}

export function focusComposer(): void {
  setTimeout(() => {
    uiContext.rootEl
      .querySelector<HTMLInputElement>(".send-form input[name=body]")
      ?.focus();
  }, 0);
}

export function navigateUnreadChannel(direction: 1 | -1): void {
  const channels = uiContext.state.channels.filter((c) => c.kind === "text");
  if (channels.length === 0) return;
  const unread = channels.filter(
    (c) => (uiContext.state.unread[c.id] ?? 0) > 0,
  );
  if (unread.length === 0) {
    setTransientStatus("Нет непрочитанных каналов");
    return;
  }
  const curIdx = uiContext.state.selectedChannelId
    ? unread.findIndex((c) => c.id === uiContext.state.selectedChannelId)
    : -1;
  const next =
    unread[(curIdx + direction + unread.length) % unread.length] ?? unread[0];
  void selectChannel(next.id);
}

export function markServerRead(): void {
  const channels = uiContext.state.channels.filter(
    (c) => (uiContext.state.unread[c.id] ?? 0) > 0,
  );
  if (channels.length === 0) {
    setTransientStatus("Нет непрочитанных");
    return;
  }
  for (const c of channels) {
    const last = uiContext.state.messages
      .filter((m) => m.channelId === c.id)
      .slice(-1)[0];
    void uiContext.httpClient
      .post(
        `/api/v1/channels/${c.id}/read`,
        last ? { lastMessageId: last.id } : {},
      )
      .catch(() => {
        /* idempotent */
      });
    uiContext.state.unread[c.id] = 0;
  }
  render();
  setTransientStatus(`Отмечено прочитанным: ${channels.length}`);
}

export function startIdleAutoDetect(): void {
  if (uiContext.idleListenersAttached) return;
  uiContext.idleListenersAttached = true;
  const onActivity = () => {
    uiContext.idleLastActivity = Date.now();
    // Если мы сами выставили idle ранее — возвращаем online на любой ввод.
    if (uiContext.idleAutoSet && uiContext.state.me?.presenceMode === "idle") {
      uiContext.idleAutoSet = false;
      void saveStatus("online", uiContext.state.me.customStatus ?? "");
    }
  };
  bindEvent(window, "mousemove", onActivity, "bind-82894", { passive: true });
  bindEvent(window, "mousedown", onActivity, "bind-82965", { passive: true });
  bindEvent(window, "keydown", onActivity, "bind-83036", { passive: true });
  bindEvent(window, "touchstart", onActivity, "bind-83105", { passive: true });
  bindEvent(window, "focus", onActivity, "bind-83177");

  if (uiContext.idleTimer) clearInterval(uiContext.idleTimer);
  uiContext.idleTimer = setInterval(() => {
    const me = uiContext.state.me;
    if (!me) return;
    // Только переход online → idle. dnd/invisible/idle (выставлен вручную)
    // не трогаем, чтобы не перетереть осознанный выбор.
    if (me.presenceMode !== "online") return;
    if (Date.now() - uiContext.idleLastActivity < uiContext.IDLE_THRESHOLD_MS)
      return;
    uiContext.idleAutoSet = true;
    void saveStatus("idle", me.customStatus ?? "");
  }, uiContext.IDLE_CHECK_INTERVAL_MS);
}

export async function requestBrowserNotificationPermission(): Promise<void> {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "default") return;
  try {
    await Notification.requestPermission();
  } catch {
    /* пользователь отказался или браузер не поддерживает Promise-вариант */
  }
}

export async function openNotification(item: NotificationItem): Promise<void> {
  uiContext.state.modal = null;
  // Mark as read локально и на сервере (fire-and-forget).
  if (!item.readAt) {
    item.readAt = new Date().toISOString();
    uiContext.state.notificationsUnread = Math.max(
      0,
      uiContext.state.notificationsUnread - 1,
    );
    void uiContext.httpClient
      .post(`/api/v1/notifications/${item.id}/read`)
      .catch(() => {
        /* idempotent */
      });
  }
  // Wave 3: заявки в друзья ведут на экран «Друзья» (DM-home, таб pending).
  if (item.kind === "friend_request" || item.kind === "friend_accept") {
    uiContext.state.friendsTab =
      item.kind === "friend_request" ? "pending" : "all";
    uiContext.state.dmMode = true;
    uiContext.state.selectedChannelId = null;
    uiContext.state.messages = [];
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
    uiContext.state.dmMode = true;
    if (uiContext.state.dms.length === 0) await loadDMs();
  } else if (
    targetWorkspace &&
    targetWorkspace !== uiContext.state.selectedWorkspaceId
  ) {
    uiContext.state.dmMode = false;
    await selectWorkspace(targetWorkspace);
  }
  if (targetChannel && targetChannel !== uiContext.state.selectedChannelId) {
    await selectChannel(targetChannel);
  } else {
    render();
  }
  const messageID = item.payload.messageId;
  if (messageID) await jumpToMessage(messageID);
}

export async function markAllNotificationsRead(): Promise<void> {
  try {
    await uiContext.httpClient.post("/api/v1/notifications/read");
    uiContext.state.notifications = uiContext.state.notifications.map((n) =>
      n.readAt ? n : { ...n, readAt: new Date().toISOString() },
    );
    uiContext.state.notificationsUnread = 0;
    render();
  } catch (err) {
    uiContext.state.status = describeError(err);
    render();
  }
}

export async function loadInvites(): Promise<void> {
  if (!uiContext.state.selectedWorkspaceId) return;
  uiContext.state.invitesLoading = true;
  render();
  try {
    const data = await uiContext.httpClient.get<{ items: Invite[] }>(
      `/api/v1/workspaces/${uiContext.state.selectedWorkspaceId}/invites`,
    );
    uiContext.state.invites = data.items ?? [];
  } catch (err) {
    uiContext.state.status = describeError(err);
  } finally {
    uiContext.state.invitesLoading = false;
    render();
  }
}

export async function loadAudit(): Promise<void> {
  if (!uiContext.state.selectedWorkspaceId) return;
  uiContext.state.auditLoading = true;
  uiContext.state.auditEntries = [];
  render();
  try {
    const data = await uiContext.httpClient.get<{ items: AuditEntry[] }>(
      `/api/v1/workspaces/${uiContext.state.selectedWorkspaceId}/audit?limit=100`,
    );
    uiContext.state.auditEntries = data.items ?? [];
  } catch (err) {
    uiContext.state.status = describeError(err);
  } finally {
    uiContext.state.auditLoading = false;
    render();
  }
}

// Pinned messages: лениво грузим список при открытии popup'а. Realtime
// `message.pinned`/`unpinned` обновляет state.channelPins на месте,
// перезагружать не нужно.
export async function loadChannelPins(channelId: string): Promise<void> {
  uiContext.state.channelPinsLoading = true;
  uiContext.state.channelPinsChannelId = channelId;
  uiContext.state.channelPins = [];
  render();
  try {
    const data = await uiContext.httpClient.get<{ items: Message[] }>(
      `/api/v1/channels/${channelId}/pins`,
    );
    if (uiContext.state.channelPinsChannelId !== channelId) return; // race-guard
    uiContext.state.channelPins = data.items ?? [];
  } catch (err) {
    uiContext.state.status = describeError(err);
  } finally {
    uiContext.state.channelPinsLoading = false;
    render();
  }
}

export function togglePinsPopup(channelId: string): void {
  if (uiContext.state.pinsPopupOpen) {
    uiContext.state.pinsPopupOpen = false;
    render();
    return;
  }
  uiContext.state.pinsPopupOpen = true;
  if (uiContext.state.channelPinsChannelId !== channelId) {
    void loadChannelPins(channelId);
  } else {
    render();
  }
}

export function renderPinsPopup(): string {
  if (uiContext.state.channelPinsLoading) {
    return `<div class="pins-popup"><div class="pins-empty">Загрузка…</div></div>`;
  }
  if (uiContext.state.channelPins.length === 0) {
    return `<div class="pins-popup">
      <div class="pins-popup-header">${t("header.pins")}</div>
      <div class="pins-empty">${t("pins.empty")}</div>
    </div>`;
  }
  const items = uiContext.state.channelPins
    .map((m) => {
      const author = describePeer(m.authorId);
      const when = formatTimeSmart(m.pinnedAt ?? m.createdAt);
      const preview = m.body
        ? renderBody(
            m.body.length > 180 ? m.body.slice(0, 180) + "…" : m.body,
            m.mentionEveryone,
          )
        : m.attachments && m.attachments.length > 0
          ? `<em>Файл (${m.attachments.length})</em>`
          : "<em>пусто</em>";
      return `
      <div class="pin-row" data-pin-jump="${m.id}">
        <div class="pin-row-head">
          <span class="pin-row-author"${authorColorStyle(m.authorId)}>${escapeHtml(author)}</span>
          <span class="pin-row-time">${when}</span>
        </div>
        <div class="pin-row-body">${preview}</div>
      </div>
    `;
    })
    .join("");
  return `
    <div class="pins-popup">
      <div class="pins-popup-header">${t("header.pins")} · ${uiContext.state.channelPins.length}</div>
      <div class="pins-popup-list">${items}</div>
    </div>
  `;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export async function loadMembers(generation?: number): Promise<void> {
  if (!uiContext.state.selectedWorkspaceId) return;
  uiContext.state.membersLoading = true;
  uiContext.state.members = [];
  queueRender("all");
  try {
    const data = await uiContext.httpClient.get<{ items: Member[] }>(
      `/api/v1/workspaces/${uiContext.state.selectedWorkspaceId}/members`,
    );
    if (generation !== undefined && generation !== uiContext.syncGeneration)
      return;
    uiContext.state.members = data.items ?? [];
  } catch (err) {
    uiContext.state.status = describeError(err);
  } finally {
    uiContext.state.membersLoading = false;
    queueRender("all");
  }
}

// Popup-подсказка по «/» в начале композера. Переиспользует CSS mention-popup.
export function updateSlashPopup(input: HTMLInputElement): void {
  const popup = uiContext.rootEl.querySelector<HTMLDivElement>("#slash-popup");
  if (!popup) return;
  const m = /^\/([a-z]*)$/i.exec(input.value);
  if (!m) {
    popup.hidden = true;
    return;
  }
  const q = m[1].toLowerCase();
  const hits = uiContext.SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
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
    </button>`,
    )
    .join("");
  popup.hidden = false;
  popup.querySelectorAll<HTMLButtonElement>("[data-slash]").forEach((b) => {
    bindEvent(
      b,
      "click",
      () => {
        input.value = `/${b.dataset.slash} `;
        popup.hidden = true;
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      },
      "bind-93011",
    );
  });
}

export function maybeSendTyping(): void {
  const chId = uiContext.state.selectedChannelId;
  if (!chId) return;
  const ch = uiContext.state.channels.find((c) => c.id === chId);
  // Wave 9: в тредах typing работает как в тексте. DM-каналов нет в
  // state.channels — для них ch=undefined, шлём.
  if (ch && ch.kind !== "text" && ch.kind !== "thread") return;
  const now = Date.now();
  if (now - uiContext.typingLastSentAt < uiContext.TYPING_SEND_INTERVAL_MS)
    return;
  uiContext.typingLastSentAt = now;
  uiContext.realtimeClient.send("typing.start", { channel_id: chId });
}

export function noteTyping(channelId: string, userId: string): void {
  if (uiContext.state.me && userId === uiContext.state.me.id) return;
  let perUser = uiContext.typingByChannel.get(channelId);
  if (!perUser) {
    perUser = new Map();
    uiContext.typingByChannel.set(channelId, perUser);
  }
  perUser.set(userId, Date.now() + uiContext.TYPING_TTL_MS);
  ensureTypingPrune();
  if (channelId === uiContext.state.selectedChannelId) updateTypingLine();
}

export function clearTyping(
  channelId: string | undefined,
  userId: string,
): void {
  if (!channelId) return;
  const perUser = uiContext.typingByChannel.get(channelId);
  if (!perUser) return;
  perUser.delete(userId);
  if (perUser.size === 0) uiContext.typingByChannel.delete(channelId);
  if (channelId === uiContext.state.selectedChannelId) updateTypingLine();
}

export function ensureTypingPrune(): void {
  if (uiContext.typingPruneTimer) return;
  uiContext.typingPruneTimer = setInterval(() => {
    const now = Date.now();
    let activeDirty = false;
    for (const [chId, perUser] of uiContext.typingByChannel) {
      for (const [uid, exp] of perUser) {
        if (exp <= now) {
          perUser.delete(uid);
          if (chId === uiContext.state.selectedChannelId) activeDirty = true;
        }
      }
      if (perUser.size === 0) uiContext.typingByChannel.delete(chId);
    }
    if (uiContext.typingByChannel.size === 0 && uiContext.typingPruneTimer) {
      clearInterval(uiContext.typingPruneTimer);
      uiContext.typingPruneTimer = null;
    }
    if (activeDirty) updateTypingLine();
  }, 2000);
}

export function updateTypingLine(): void {
  const el = uiContext.rootEl.querySelector<HTMLElement>("#typing-line");
  if (!el) return;
  const perUser = uiContext.state.selectedChannelId
    ? uiContext.typingByChannel.get(uiContext.state.selectedChannelId)
    : undefined;
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
