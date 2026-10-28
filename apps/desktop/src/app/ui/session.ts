import type { CallManager } from "../../call/callManager";
import type { VoiceChannelManager } from "../../call/voiceChannelManager";
import type { ApiError, HttpClient } from "../../network/httpClient";
import { isSessionRejected, isTransientError } from "../../network/httpClient";
import type { RealtimeClient } from "../../realtime/realtimeClient";
import { applyAppearance, watchSystemTheme } from "../appearance";
import { describeError } from "../errors";
import { resetPresence } from "../presence";
import { installQaHarness } from "../qaHarness";
import { queueRender, setRenderer } from "../runtime";
import { uiContext } from "../state";
import { installTooltips } from "../tooltips";
import type {
  Channel,
  ChannelCategory,
  Me,
  VoicePeekParticipant,
  Workspace,
} from "../types";
import { escapeHtml } from "../util/html";
import { loadPublicConfig } from "./authentication";
import { handleRealtimeEvent } from "./events";
import { setTransientStatus } from "./helpers";
import {
  initUpdateCheck,
  installGlobalKeyboardShortcuts,
  loadDMs,
  loadFriends,
  loadMembers,
  loadNotifPrefs,
  loadNotifications,
  loadUnread,
  selectChannel,
  startIdleAutoDetect,
} from "./loaders";
import { render, syncConnectionBanner } from "./renderer";
import { createConnectionGate } from "../../realtime/connectionGrace";
import { installNativeGuards, loadWsRoles } from "./shell";
import { attachVoiceVideoStreams } from "./voiceView";
import { loadWorkspaceCapabilities, workspaceCapabilities, channelCapabilities } from "./capabilities";

export function saveCollapsedCategories(): void {
  try {
    localStorage.setItem(
      uiContext.COLLAPSED_CATEGORIES_KEY,
      JSON.stringify(Array.from(uiContext.state.collapsedCategories)),
    );
  } catch {
    /* quota / disabled */
  }
}

export function insertWsRailImg(
  slot: HTMLButtonElement,
  animatedUrl: string,
  staticUrl?: string,
): void {
  const def = staticUrl ?? animatedUrl;
  const escAnim = escapeHtml(animatedUrl);
  const escDef = escapeHtml(def);
  slot.insertAdjacentHTML(
    "afterbegin",
    `<img class="ws-rail-img" src="${escDef}" data-anim-src="${escAnim}" data-static-src="${escDef}" alt="" />`,
  );
}

export function extractFirstFrame(
  blob: Blob,
  blobUrl: string,
): Promise<string | null> {
  // I.14: APNG тоже анимированный — first frame снимается тем же canvas'ом
  // (drawImage на onload рисует первый кадр).
  if (blob.type !== "image/gif" && blob.type !== "image/apng")
    return Promise.resolve(null);
  return new Promise<string | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth || 64;
        c.height = img.naturalHeight || 64;
        const ctx = c.getContext("2d");
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        resolve(c.toDataURL("image/png"));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = blobUrl;
  });
}

export function renderApp(
  container: HTMLElement,
  http: HttpClient,
  realtime: RealtimeClient,
  callManager: CallManager,
  voiceManager: VoiceChannelManager,
): void {
  uiContext.rootEl = container;
  setRenderer(render);
  uiContext.httpClient = http;
  uiContext.realtimeClient = realtime;
  uiContext.callMgr = callManager;
  uiContext.voiceMgr = voiceManager;
  if (import.meta.env.DEV)
    installQaHarness({
      state: uiContext.state,
      render,
      event: handleRealtimeEvent,
      setTokens: (tokens) => uiContext.httpClient.setTokens(tokens),
    });

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
  // Плашка появляется только если обрыв длится дольше grace-периода, и
  // обновляется точечно: полный render() сбрасывал бы полноэкранный режим
  // стрима, открытые настройки и текст в поле ввода.
  const gate = createConnectionGate((visible) => {
    uiContext.connState = visible ? "reconnecting" : "connected";
    syncConnectionBanner();
  });
  realtime.onConnectionStateChange((s) => gate.push(s));
  const nudgeReconnect = () => {
    if (document.visibilityState !== "hidden") realtime.reconnectNow();
  };
  window.addEventListener("online", nudgeReconnect);
  document.addEventListener("visibilitychange", nudgeReconnect);
  callManager.subscribe((snap) => {
    const next = snap.state === "idle" ? null : snap;
    const changed =
      JSON.stringify(uiContext.state.callSnapshot) !== JSON.stringify(next);
    uiContext.state.callSnapshot = next;
    if (changed) queueRender("call");
    attachVoiceVideoStreams();
  });
  voiceManager.subscribe((snap) => {
    const next = snap.state === "idle" ? null : snap;
    const changed =
      JSON.stringify(uiContext.state.voiceSnapshot) !== JSON.stringify(next);
    uiContext.state.voiceSnapshot = next;
    if (changed) queueRender("voice", "channels");
    attachVoiceVideoStreams();
  });
  http.onTokensChanged((tokens) => {
    if (!tokens) {
      resetPresence();
      workspaceCapabilities.clear();
      channelCapabilities.clear();
      Object.assign(uiContext.state, {
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
        revealedBlocked: new Set<string>(),
      });
      render();
      void loadPublicConfig();
    }
  });

  void loadPublicConfig();
  if (http.getTokens()) {
    void bootstrapSession();
  } else {
    render();
  }
}

export async function bootstrapSession(): Promise<void> {
  try {
    uiContext.state.status = "Загрузка профиля…";
    render();
    uiContext.state.me = await uiContext.httpClient.get<Me>("/api/v1/users/me");
    if (uiContext.state.me.mustChangePassword) {
      // Временный пароль: остальной API закрыт, показываем экран смены пароля.
      uiContext.state.status = "";
      uiContext.state.bootError = null;
      render();
      return;
    }
    await loadWorkspaces();
    void loadNotifications();
    void loadDMs();
    void loadFriends();
    void loadNotifPrefs();
    startIdleAutoDetect();
    void initUpdateCheck();
    uiContext.state.status = "";
    uiContext.state.bootError = null;
    render();
  } catch (err) {
    uiContext.state.status = "";
    if (isSessionRejected(err)) {
      // Сервер отклонил сессию (401/403): токены просрочены, отозваны или аккаунт заблокирован.
      await uiContext.httpClient.logout();
      uiContext.state.authError = describeError(err);
    } else {
      // Нет связи, таймаут или сбой сервера: сессия жива, выходить нельзя.
      const transient = isTransientError(err);
      // Профиль мог уже загрузиться, а список воркспейсов нет: при временном
      // сбое сбрасываем его, иначе экран «Сервер недоступен» (он показывается
      // только без профиля) не появится, и «Повторить» останется недоступной.
      if (transient) uiContext.state.me = null;
      if (!uiContext.state.me) {
        const status = (err as ApiError | null)?.status ?? 0;
        uiContext.state.bootError =
          status >= 500
            ? `Сервер вернул ошибку ${status}. Возможно, он перезапускается.`
            : describeError(err);
      } else {
        // Профиль есть, а один из запросов загрузки вернул ошибку (не сбой
        // связи): оболочка остаётся доступной, причину показываем в статусе.
        setTransientStatus(describeError(err));
      }
    }
    render();
  }
}

export async function loadWorkspaces(generation?: number): Promise<void> {
  const data = await uiContext.httpClient.get<{ items: Workspace[] }>(
    "/api/v1/workspaces",
  );
  if (generation !== undefined && generation !== uiContext.syncGeneration)
    return;
  uiContext.state.workspaces = data.items ?? [];
  if (
    uiContext.state.selectedWorkspaceId &&
    !uiContext.state.workspaces.some(
      (w) => w.id === uiContext.state.selectedWorkspaceId,
    )
  ) {
    uiContext.state.selectedWorkspaceId = null;
  }
  if (
    !uiContext.state.selectedWorkspaceId &&
    uiContext.state.workspaces.length > 0
  ) {
    await selectWorkspace(
      uiContext.state.workspaces[0].id,
      generation !== undefined,
    );
  }
}

export async function selectWorkspace(
  id: string,
  preserveSyncGeneration = false,
): Promise<void> {
  if (!preserveSyncGeneration) uiContext.syncGeneration += 1;
  uiContext.state.selectedWorkspaceId = id;
  uiContext.state.selectedChannelId = null;
  uiContext.state.channels = [];
  uiContext.state.categories = [];
  uiContext.state.messages = [];
  uiContext.state.invitesOpen = false;
  uiContext.state.invites = [];
  uiContext.state.members = [];
  uiContext.state.unread = {};
  uiContext.state.wsRoles = [];
  uiContext.userColorCache = null;
  uiContext.state.voicePeekAll = {};
  render();
  // J.5: каналы и категории тянем параллельно — оба нужны для рендера sidebar.
  const [channelsResp, categoriesResp] = await Promise.all([
    uiContext.httpClient.get<{ items: Channel[] }>(
      `/api/v1/workspaces/${id}/channels`,
    ),
    uiContext.httpClient
      .get<{ items: ChannelCategory[] }>(`/api/v1/workspaces/${id}/categories`)
      .catch(() => ({ items: [] })),
    loadWorkspaceCapabilities(id),
  ]);
  uiContext.state.channels = channelsResp.items ?? [];
  uiContext.state.categories = categoriesResp.items ?? [];
  // Резолвинг authorId → имя в сообщениях. Не блокируем загрузку каналов.
  void loadMembers();
  void loadUnread(id);
  void loadWsRoles(id);
  void loadAllVoicePeeks(id);
  if (uiContext.state.channels.length > 0) {
    await selectChannel(uiContext.state.channels[0].id);
  } else {
    render();
  }
}

// Прелоад участников всех voice-каналов воркспейса — чтобы под voice-каналом
// в sidebar сразу был виден список «кто в канале», без необходимости туда
// заходить. Дальше поддерживается realtime'ом через voice.joined/voice.left.
export async function loadAllVoicePeeks(
  workspaceId: string,
  generation?: number,
): Promise<void> {
  const voiceChannels = uiContext.state.channels.filter(
    (c) => c.kind === "voice" && c.workspaceId === workspaceId,
  );
  if (voiceChannels.length === 0) return;
  const results = await Promise.allSettled(
    voiceChannels.map((c) =>
      uiContext.httpClient
        .get<{ items: VoicePeekParticipant[] }>(
          `/api/v1/channels/${c.id}/voice/participants`,
        )
        .then((d) => ({ channelId: c.id, items: d.items ?? [] })),
    ),
  );
  if (
    uiContext.state.selectedWorkspaceId !== workspaceId ||
    (generation !== undefined && generation !== uiContext.syncGeneration)
  )
    return;
  const next: Record<string, VoicePeekParticipant[]> = {};
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.items.length > 0) {
      next[r.value.channelId] = r.value.items;
    }
  }
  uiContext.state.voicePeekAll = next;
  queueRender("all");
}
