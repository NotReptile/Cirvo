import type { RealtimeEvent } from "../../realtime/realtimeClient";
import { describeError } from "../errors";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import { removeHistoryMessage } from "./history";
import { invalidatePermissions } from "./capabilities";
import { applyPresenceEvent } from "../presence";
import { applySelfPresenceUpdate } from "./loaders";
import type {
  Channel,
  ChannelCategory,
  LinkPreview,
  Message,
  NotificationItem,
  NotificationPayload,
  PresenceMode,
  VoicePeekParticipant,
  Workspace,
} from "../types";
import {
  clearTyping,
  handleIncomingNotification,
  isChannelMuted,
  loadDMs,
  loadForumPosts,
  loadFriends,
  markChannelRead,
  noteTyping,
  resyncAfterReconnect,
} from "./loaders";

export function handleRealtimeEvent(event: RealtimeEvent): void {
  if (event.event === "presence.snapshot") {
    const users = (event.payload as { users?: Array<{ userId: string; mode: PresenceMode; customStatus?: string; updatedAt?: string }> } | null)?.users;
    if (Array.isArray(users)) {
      for (const p of users) if (p?.userId && ["online", "idle", "dnd", "offline", "invisible"].includes(p.mode)) applyPresenceEvent(p.userId, { presenceMode: p.mode, customStatus: p.customStatus }, p.updatedAt);
      render(new Set(["presence"]));
    }
    return;
  }
  if (event.event === "permissions.updated") {
    const id = event.workspaceId ?? (event.payload as { workspaceId?: string } | null)?.workspaceId;
    if (id) invalidatePermissions(id);
    return;
  }
  if (event.event === "sync.required") {
    const cursor = Number(
      (event.payload as { cursor?: unknown } | null)?.cursor,
    );
    void resyncAfterReconnect(
      Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined,
    );
    return;
  }
  if (event.event === "sync.ready") {
    const payload = event.payload as {
      cursor?: unknown;
      workspaces?: unknown;
    } | null;
    const remote = Array.isArray(payload?.workspaces)
      ? payload.workspaces
          .filter((id): id is string => typeof id === "string")
          .sort()
      : [];
    const local = uiContext.state.workspaces
      .map((workspace) => workspace.id)
      .sort();
    if (
      uiContext.state.me &&
      (remote.length !== local.length ||
        remote.some((id, index) => id !== local[index]))
    ) {
      const cursor = Number(payload?.cursor);
      uiContext.realtimeClient.beginSnapshot();
      void resyncAfterReconnect(
        Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined,
      );
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
  if (
    event.event === "friend.request" ||
    event.event === "friend.accepted" ||
    event.event === "friend.removed"
  ) {
    void loadFriends();
    return;
  }
  // C.8: уведомления приходят с UserID-routing (workspaceId/channelId не
  // обязательны), обрабатываем до проверки channelId ниже.
  if (event.event === "notification.created") {
    handleIncomingNotification(
      event.payload as {
        id: string;
        kind: NotificationItem["kind"];
        createdAt: string;
        payload: NotificationPayload;
      },
    );
    return;
  }
  // H.8: presence.updated приходит из profile-модуля при PUT /users/me/status.
  // Бэк рассылает по всем воркспейсам автора и его DM-собеседникам;
  // invisible режим маскируется как 'offline'. Обновляем state.members
  // (если автор в текущем ws) и dms (если есть DM с автором).
  if (event.event === "presence.updated" || event.event === "presence.self.updated") {
    const p = event.payload as {
      userId: string;
      mode: PresenceMode;
      customStatus?: string;
      sessionId?: string;
      updatedAt?: string;
    };
    if (!p?.userId || !["online", "idle", "dnd", "offline", "invisible"].includes(p.mode)) return;
    if (event.event === "presence.self.updated") applySelfPresenceUpdate(p);
    else applyPresenceEvent(p.userId, { presenceMode: p.mode, customStatus: p.customStatus }, p.updatedAt);
    render(new Set(["presence"]));
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
    uiContext.state.workspaces = uiContext.state.workspaces.map((w) => {
      if (w.id !== p.id) return w;
      return {
        ...w,
        name: p.name ?? w.name,
        avatarMediaId:
          p.avatarMediaId !== undefined ? p.avatarMediaId : w.avatarMediaId,
        welcomeChannelId:
          p.welcomeChannelId !== undefined
            ? p.welcomeChannelId
            : w.welcomeChannelId,
      };
    });
    render();
    return;
  }
  // User avatar / displayName changed. Обновляем state.members[*] и
  // state.dms[*].peer + state.me если это мы.
  if (event.event === "user.updated") {
    const p = event.payload as {
      userId: string;
      avatarMediaId?: string;
      displayName?: string;
    };
    if (uiContext.state.me && uiContext.state.me.id === p.userId) {
      uiContext.state.me = {
        ...uiContext.state.me,
        avatarMediaId: p.avatarMediaId || undefined,
        displayName: p.displayName || uiContext.state.me.displayName,
      };
    }
    uiContext.state.members = uiContext.state.members.map((m) =>
      m.userId === p.userId
        ? {
            ...m,
            avatarMediaId: p.avatarMediaId || undefined,
            displayName: p.displayName || m.displayName,
          }
        : m,
    );
    uiContext.state.dms = uiContext.state.dms.map((d) =>
      d.peer.userId === p.userId
        ? {
            ...d,
            peer: {
              ...d.peer,
              avatarMediaId: p.avatarMediaId || undefined,
              displayName: p.displayName || d.peer.displayName,
            },
          }
        : d,
    );
    render();
    return;
  }
  // voice.joined/voice.left — обновляем глобальный voicePeekAll для
  // ВСЕХ voice-каналов воркспейса, не только выбранного. Это и есть
  // данные для inline-списка участников под voice-каналом в sidebar.
  if (event.event === "voice.joined") {
    const p = event.payload as VoicePeekParticipant & { channelId: string };
    const list = uiContext.state.voicePeekAll[p.channelId] ?? [];
    if (!list.some((x) => x.sessionId === p.sessionId)) {
      uiContext.state.voicePeekAll = {
        ...uiContext.state.voicePeekAll,
        [p.channelId]: [...list, p],
      };
    }
    if (
      uiContext.state.voicePeek?.channelId === p.channelId &&
      !uiContext.state.voicePeek.participants.some(
        (x) => x.sessionId === p.sessionId,
      )
    ) {
      uiContext.state.voicePeek = {
        ...uiContext.state.voicePeek,
        participants: [...uiContext.state.voicePeek.participants, p],
      };
    }
    render();
    return;
  }
  if (event.event === "voice.left") {
    const p = event.payload as { channelId: string; sessionId: string };
    const list = uiContext.state.voicePeekAll[p.channelId] ?? [];
    const next = list.filter((x) => x.sessionId !== p.sessionId);
    const allCopy = { ...uiContext.state.voicePeekAll };
    if (next.length === 0) delete allCopy[p.channelId];
    else allCopy[p.channelId] = next;
    uiContext.state.voicePeekAll = allCopy;
    if (uiContext.state.voicePeek?.channelId === p.channelId) {
      uiContext.state.voicePeek = {
        ...uiContext.state.voicePeek,
        participants: uiContext.state.voicePeek.participants.filter(
          (x) => x.sessionId !== p.sessionId,
        ),
      };
    }
    render();
    return;
  }
  if (event.event === "channel.created") {
    const ch = event.payload as Channel;
    if (ch.workspaceId !== uiContext.state.selectedWorkspaceId) return;
    if (uiContext.state.channels.some((c) => c.id === ch.id)) return;
    uiContext.state.channels = [...uiContext.state.channels, ch];
    if (
      ch.kind === "thread" &&
      ch.parentChannelId &&
      ch.parentChannelId === uiContext.state.selectedChannelId
    ) {
      // Wave 10: тред на сообщении открытого text-канала — вешаем чип на
      // корневое сообщение сразу (агрегаты придут при следующем refetch'е).
      if (ch.rootMessageId) {
        const idx = uiContext.state.messages.findIndex(
          (m) => m.id === ch.rootMessageId,
        );
        if (idx >= 0 && !uiContext.state.messages[idx].thread) {
          const next = uiContext.state.messages.slice();
          next[idx] = {
            ...next[idx],
            thread: {
              threadId: ch.id,
              title: ch.name,
              messageCount: 0,
              lastActivityAt: ch.createdAt,
            },
          };
          uiContext.state.messages = next;
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
    if (ch.workspaceId !== uiContext.state.selectedWorkspaceId) return;
    uiContext.state.channels = uiContext.state.channels.map((c) =>
      c.id === ch.id ? ch : c,
    );
    render();
    return;
  }
  if (event.event === "channel.deleted") {
    const p = event.payload as { channelId: string; workspaceId: string };
    if (p.workspaceId !== uiContext.state.selectedWorkspaceId) return;
    uiContext.state.channels = uiContext.state.channels.filter(
      (c) => c.id !== p.channelId,
    );
    if (uiContext.state.selectedChannelId === p.channelId) {
      uiContext.state.selectedChannelId = null;
      uiContext.state.messages = [];
    }
    delete uiContext.state.unread[p.channelId];
    render();
    return;
  }
  // J.5: realtime category events.
  if (
    event.event === "category.created" ||
    event.event === "category.updated"
  ) {
    const cat = event.payload as ChannelCategory;
    if (cat.workspaceId !== uiContext.state.selectedWorkspaceId) return;
    if (
      event.event === "category.created" &&
      !uiContext.state.categories.some((c) => c.id === cat.id)
    ) {
      uiContext.state.categories = [...uiContext.state.categories, cat];
    } else {
      uiContext.state.categories = uiContext.state.categories.map((c) =>
        c.id === cat.id ? cat : c,
      );
    }
    render();
    return;
  }
  if (event.event === "category.deleted") {
    const p = event.payload as { categoryId: string; workspaceId: string };
    if (p.workspaceId !== uiContext.state.selectedWorkspaceId) return;
    uiContext.state.categories = uiContext.state.categories.filter(
      (c) => c.id !== p.categoryId,
    );
    uiContext.state.channels = uiContext.state.channels.map((ch) =>
      ch.categoryId === p.categoryId ? { ...ch, categoryId: null } : ch,
    );
    render();
    return;
  }
  // G.8: dm.opened — фан-аут обоим участникам при создании DM (см.
  // publishDMOpened на бэке). Если у нас в state.dms ещё нет канала —
  // тянем свежий список (с peer.username/displayName/avatarMediaId).
  if (event.event === "dm.opened") {
    const p = event.payload as { channelId: string };
    if (!uiContext.state.dms.some((d) => d.channelId === p.channelId)) {
      void loadDMs();
    }
    return;
  }
  // C.5: события для не-активных каналов обрабатываем отдельно (unread).
  if (
    event.channelId &&
    event.channelId !== uiContext.state.selectedChannelId
  ) {
    if (event.event === "message.created") {
      const msg = event.payload as Message;
      // Wave 9/10: сообщение в треде, чей родитель сейчас открыт. Для
      // форума перечитываем карточки, для text-канала — двигаем чип
      // «N ответов» на корневом сообщении (только user-сообщения, чтобы
      // system-плашка контекста не считалась ответом).
      const threadCh = uiContext.state.channels.find(
        (c) => c.id === event.channelId,
      );
      if (
        threadCh?.kind === "thread" &&
        threadCh.parentChannelId === uiContext.state.selectedChannelId
      ) {
        if (threadCh.rootMessageId) {
          if (!msg.kind || msg.kind === "user") {
            const idx = uiContext.state.messages.findIndex(
              (m) => m.id === threadCh.rootMessageId,
            );
            if (idx >= 0) {
              const next = uiContext.state.messages.slice();
              const prev = next[idx].thread;
              next[idx] = {
                ...next[idx],
                thread: {
                  threadId: threadCh.id,
                  title: prev?.title ?? threadCh.name,
                  messageCount: (prev?.messageCount ?? 0) + 1,
                  lastActivityAt: msg.createdAt,
                },
              };
              uiContext.state.messages = next;
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
      if (
        msg.authorId !== uiContext.state.me?.id &&
        !isChannelMuted(event.channelId)
      ) {
        uiContext.state.unread[event.channelId] =
          (uiContext.state.unread[event.channelId] ?? 0) + 1;
        // G.8: если канал — DM, синхронно обновим DMItem (unread + lastMessageAt)
        // и перечитаем суммарный counter для badge на DM-rail-иконке.
        const dmIdx = uiContext.state.dms.findIndex(
          (d) => d.channelId === event.channelId,
        );
        if (dmIdx >= 0) {
          const next = uiContext.state.dms.slice();
          next[dmIdx] = {
            ...next[dmIdx],
            unreadCount: (next[dmIdx].unreadCount ?? 0) + 1,
            lastMessageAt: msg.createdAt,
          };
          uiContext.state.dms = next;
          uiContext.state.dmUnreadTotal = uiContext.state.dms.reduce(
            (acc, d) => acc + (d.unreadCount ?? 0),
            0,
          );
        }
        render();
      } else if (msg.authorId === uiContext.state.me?.id) {
        // Своё сообщение в фоновом DM — обновляем только lastMessageAt
        // (для сортировки списка), unread не трогаем.
        const dmIdx = uiContext.state.dms.findIndex(
          (d) => d.channelId === event.channelId,
        );
        if (dmIdx >= 0) {
          const next = uiContext.state.dms.slice();
          next[dmIdx] = { ...next[dmIdx], lastMessageAt: msg.createdAt };
          uiContext.state.dms = next;
          render();
        }
      }
    } else if (event.event === "channel.read") {
      const p = event.payload as { userId: string; channelId: string };
      if (p.userId === uiContext.state.me?.id) {
        uiContext.state.unread[p.channelId] = 0;
        // G.8: синхронизация DM-айтема (мульти-клиент: прочитал на телефоне).
        const dmIdx = uiContext.state.dms.findIndex(
          (d) => d.channelId === p.channelId,
        );
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
      }
    }
    return;
  }
  if (event.channelId !== uiContext.state.selectedChannelId) return;
  switch (event.event) {
    case "message.created": {
      const msg = event.payload as Message;
      // Сообщение пришло — его автор очевидно допечатал.
      clearTyping(event.channelId!, msg.authorId);
      if (uiContext.state.messages.some((m) => m.id === msg.id)) return;
      uiContext.state.messages = [
        ...uiContext.state.messages,
        { ...msg, reactions: msg.reactions ?? {} },
      ];
      // Активный канал + юзер у низа → отмечаем прочитанным (своё сообщение
      // тоже двигает курсор, чтобы при возврате не висел divider от старого).
      if (uiContext.state.stickToBottom && uiContext.state.selectedChannelId) {
        void markChannelRead(uiContext.state.selectedChannelId, msg.id);
      }
      render(new Set(["messages"]));
      break;
    }
    case "message.deleted": {
      const payload = event.payload as { id: string };
      removeHistoryMessage(payload.id);
      render(new Set(["messages"]));
      break;
    }
    case "message.updated": {
      const msg = event.payload as Message;
      uiContext.state.messages = uiContext.state.messages.map((m) =>
        m.id === msg.id
          ? { ...msg, reactions: msg.reactions ?? m.reactions ?? {} }
          : m,
      );
      render(new Set(["messages"]));
      break;
    }
    // Wave 2: worker допилил OG-карточки — дописываем в сообщение.
    case "message.previews.updated": {
      const p = event.payload as {
        messageId: string;
        linkPreviews?: LinkPreview[];
      };
      uiContext.state.messages = uiContext.state.messages.map((m) =>
        m.id === p.messageId ? { ...m, linkPreviews: p.linkPreviews ?? [] } : m,
      );
      render(new Set(["messages"]));
      break;
    }
    case "message.reaction.added": {
      const p = event.payload as {
        messageId: string;
        userId: string;
        emoji: string;
      };
      applyReactionDelta(p.messageId, p.emoji, +1, p.userId);
      break;
    }
    case "message.reaction.removed": {
      const p = event.payload as {
        messageId: string;
        userId: string;
        emoji: string;
      };
      applyReactionDelta(p.messageId, p.emoji, -1, p.userId);
      break;
    }
    case "message.pinned": {
      const msg = event.payload as Message;
      uiContext.state.messages = uiContext.state.messages.map((m) =>
        m.id === msg.id ? { ...m, isPinned: true, pinnedAt: msg.pinnedAt } : m,
      );
      if (uiContext.state.channelPinsChannelId === msg.channelId) {
        // Кладём в начало (свежеприкреплённое выше). Если уже есть — replace.
        const without = uiContext.state.channelPins.filter(
          (p) => p.id !== msg.id,
        );
        uiContext.state.channelPins = [msg, ...without];
      }
      render(new Set(["messages", "pins"]));
      break;
    }
    case "message.unpinned": {
      const p = event.payload as { id: string; channelId: string };
      uiContext.state.messages = uiContext.state.messages.map((m) =>
        m.id === p.id ? { ...m, isPinned: false, pinnedAt: undefined } : m,
      );
      if (uiContext.state.channelPinsChannelId === p.channelId) {
        uiContext.state.channelPins = uiContext.state.channelPins.filter(
          (x) => x.id !== p.id,
        );
      }
      render(new Set(["messages", "pins"]));
      break;
    }
  }
}

export function applyReactionDelta(
  messageId: string,
  emoji: string,
  delta: number,
  userId: string,
): void {
  const idx = uiContext.state.messages.findIndex((m) => m.id === messageId);
  if (idx < 0) return;
  const msg = uiContext.state.messages[idx];
  const reactions = { ...(msg.reactions ?? {}) };
  const current = reactions[emoji] ?? { count: 0, mine: false };
  const isMe = userId === uiContext.state.me?.id;
  const nextCount = current.count + delta;
  if (nextCount <= 0) {
    delete reactions[emoji];
  } else {
    reactions[emoji] = {
      count: nextCount,
      mine: isMe ? delta > 0 : current.mine,
    };
  }
  uiContext.state.messages = uiContext.state.messages.map((m, i) =>
    i === idx ? { ...m, reactions } : m,
  );
  render(new Set(["messages"]));
}

export async function toggleReaction(
  messageId: string,
  emoji: string,
): Promise<void> {
  const msg = uiContext.state.messages.find((m) => m.id === messageId);
  if (!msg) return;
  const isMine = msg.reactions?.[emoji]?.mine ?? false;
  const path = `/api/v1/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`;
  try {
    if (isMine) {
      await uiContext.httpClient.del(path);
    } else {
      await uiContext.httpClient.put(path);
    }
  } catch (err) {
    uiContext.state.status = describeError(err);
    render();
  }
}
