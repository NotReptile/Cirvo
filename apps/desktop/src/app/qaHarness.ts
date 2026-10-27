import type { AppState } from "./ui";
import type { AuthTokens } from "../network/httpClient";
import type { RealtimeEvent } from "../realtime/realtimeClient";
import { seedLegacyCapabilities, workspaceCapabilities, channelCapabilities, canWorkspace,
  loadWorkspaceCapabilities, loadChannelCapabilities } from "./ui/capabilities";
import { uiContext } from "./state";
import { loadChannelPermissions } from "./ui/channelSettings";
import { openCategoryPermissions } from "./ui/modals";
import { reloadWorkspaceRoles } from "./ui/workspaceRoles";
import { updateVoiceSettings } from "../call/voiceSettings";
import { wrapMicStream } from "../call/denoiser";
import { wrapCameraTrack } from "../call/videoEffects";
import { resetPresence, resolveUserPresence, applyPresenceSnapshot, presenceRevision } from "./presence";
import { saveStatus, startIdleAutoDetect } from "./ui/loaders";

// Installed exclusively by the Vite development build. The release has no QA entry point.
export function installQaHarness(ui: {
  state: AppState;
  render(): void;
  event(event: RealtimeEvent): void;
  setTokens(tokens: AuthTokens): void;
}): void {
  const api = {
    presence: { resolveUserPresence, applyPresenceSnapshot, presenceRevision, saveStatus, startIdleAutoDetect,
      setIdleAuto(value: boolean) { uiContext.idleAutoSet = value; },
      idleAuto() { return uiContext.idleAutoSet; } },
    media: { updateVoiceSettings, wrapMicStream, wrapCameraTrack },
    seed(count: number) {
      resetPresence();
      const createdAt = "2026-10-01T12:00:00Z";
      ui.setTokens({
        accessToken: "qa-access",
        refreshToken: "qa-refresh",
        accessExpiresAt: "2999-01-01T00:00:00Z",
        sessionId: "qa-session",
      });
      Object.assign(ui.state, {
        me: {
          id: "qa-me",
          username: "qa_me",
          email: "qa@example.test",
          displayName: "Тестировщик",
          isRoot: true,
        },
        bootError: null,
        modal: null,
        status: "",
        membersLoading: false,
        workspaces: [
          {
            id: "qa-ws",
            slug: "qa",
            name: "Проверка Cirvo",
            ownerId: "qa-me",
            role: "owner",
            createdAt,
          },
        ],
        selectedWorkspaceId: "qa-ws",
        channels: [
          {
            id: "qa-chat",
            workspaceId: "qa-ws",
            kind: "text",
            name: "общий",
            isPrivate: false,
            position: 0,
            createdAt,
          },
          {
            id: "qa-voice",
            workspaceId: "qa-ws",
            kind: "voice",
            name: "Голос",
            isPrivate: false,
            position: 1,
            createdAt,
          },
        ],
        selectedChannelId: "qa-chat",
        dmMode: false,
        selectedChannelLastReadAt: null,
        messagesCursor: null,
        messagesHasMore: false,
        stickToBottom: true,
        restoreScrollBottom: null,
        windowStart: null,
        messages: Array.from({ length: count }, (_, i) => ({
          id: `qa-message-${i}`,
          channelId: "qa-chat",
          authorId: `qa-user-${i % 20}`,
          body: `Сообщение ${i}: **текст** и @qa_user_1`,
          createdAt: new Date(Date.parse(createdAt) + i * 30_000).toISOString(),
          reactions: {},
        })),
        members: Array.from({ length: 20 }, (_, i) => ({
          userId: `qa-user-${i}`,
          username: `qa_user_${i}`,
          displayName: `Участник ${i}`,
          role: "member",
          joinedAt: createdAt,
          online: i % 2 === 0,
        })),
        memberSidebarOpen: true,
        callSnapshot: null,
        voiceSnapshot: null,
      });
      seedLegacyCapabilities();
      const start = performance.now();
      ui.render();
      return {
        renderMs: performance.now() - start,
        nodes: document.querySelectorAll("*").length,
      };
    },
    render: ui.render,
    event: ui.event,
    state: () => ui.state,
    capabilities: { workspaceCapabilities, channelCapabilities, canWorkspace,
      loadWorkspaceCapabilities, loadChannelCapabilities },
    permissions: { loadChannelPermissions, openCategoryPermissions, reloadWorkspaceRoles },
    replaceVoiceManager(manager: typeof uiContext.voiceMgr) {
      const previous = uiContext.voiceMgr;
      uiContext.voiceMgr = manager;
      return previous;
    },
    measure() {
      const start = performance.now();
      ui.render();
      return {
        renderMs: performance.now() - start,
        nodes: document.querySelectorAll("*").length,
        messages: document.querySelectorAll("#message-list .message").length,
      };
    },
  };
  (window as unknown as { __CIRVO_QA__: typeof api }).__CIRVO_QA__ = api;
}
