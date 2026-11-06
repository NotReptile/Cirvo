import type { ApiError } from "../../network/httpClient";
import { uiContext } from "../state";
import { describeError } from "../errors";
import { queueRender } from "../runtime";
import type { Channel, ChannelCategory, Workspace } from "../types";
import { loadMembers } from "./loaders";
import { loadWsRoles } from "./shell";

type Capabilities = { mode: "known" | "legacy" | "pending" | "error"; actions: string[]; inaccessible?: boolean };
export const workspaceCapabilities = new Map<string, Capabilities>();
export const channelCapabilities = new Map<string, Capabilities>();

export function unavailablePermissionsModal(): string {
  return `<div class="modal-backdrop" data-modal-close><div class="modal" role="dialog"><div class="modal-body">Действие недоступно. Проверьте права или дождитесь их загрузки.</div><footer class="modal-footer"><button class="ghost" data-modal-close>Закрыть</button></footer></div></div>`;
}
const member = ["channel.view", "message.write", "message.react", "message.attach", "message.mention"];
const moderator = [...member, "channel.create", "channel.update", "channel.delete", "channel.manage_members",
  "message.moderate", "invite.manage", "audit.read", "member.kick", "message.mention_everyone"];
const admin = [...moderator, "workspace.update", "member.manage_role"];

export function legacyAllows(role: string | undefined, action: string): boolean {
  return role === "owner" || (role === "admin" ? admin : role === "moderator" ? moderator : role === "member" ? member : []).includes(action);
}

export function canWorkspace(action: string, workspaceId = uiContext.state.selectedWorkspaceId): boolean {
  if (!workspaceId) return false;
  const caps = workspaceCapabilities.get(workspaceId);
  if (caps?.mode === "legacy") return legacyAllows(uiContext.state.workspaces.find((w) => w.id === workspaceId)?.role, action);
  return caps?.mode === "known" && caps.actions.includes(action);
}

export function canChannel(action: string, channelId = uiContext.state.selectedChannelId): boolean {
  if (!channelId) return false;
  const channel = uiContext.state.channels.find((c) => c.id === channelId);
  const caps = channelCapabilities.get(channelId);
  if (caps) {
    if (caps.mode === "known") return caps.actions.includes(action);
    if (caps.mode !== "legacy") return false;
  }
  if (Array.isArray(channel?.actions)) return channel.actions.includes(action);
  if (caps?.mode === "legacy" || workspaceCapabilities.get(channel?.workspaceId ?? "")?.mode === "legacy") {
    if (!channel && uiContext.state.dms.some((d) => d.channelId === channelId)) return member.includes(action);
    return legacyAllows(uiContext.state.workspaces.find((w) => w.id === channel?.workspaceId)?.role, action);
  }
  return false;
}

export function seedLegacyCapabilities(): void {
  workspaceCapabilities.clear(); channelCapabilities.clear();
  for (const ws of uiContext.state.workspaces) workspaceCapabilities.set(ws.id, { mode: "legacy", actions: [] });
  for (const ch of uiContext.state.channels) channelCapabilities.set(ch.id, { mode: "legacy", actions: [] });
}

function missingEndpoint(err: unknown): boolean {
  const error = err as ApiError;
  return error?.status === 404 && error.code === "http_error";
}

async function fetchCapabilities(path: string): Promise<Capabilities> {
  try {
    const data = await uiContext.httpClient.get<{ actions: string[] }>(path);
    if (!Array.isArray(data.actions) || !data.actions.every((action) => typeof action === "string")) throw new Error("Сервер вернул некорректный список прав");
    return { mode: "known", actions: data.actions };
  } catch (err) {
    if (missingEndpoint(err)) {
      uiContext.state.status = "Сервер не поддерживает проверку прав клиента. Используется совместимость с v0.2.0.";
      return { mode: "legacy", actions: [] };
    }
    uiContext.state.status = describeError(err);
    const status = (err as ApiError)?.status;
    return { mode: "error", actions: [], inaccessible: status === 403 || status === 404 };
  }
}

export async function loadWorkspaceCapabilities(id: string): Promise<void> {
  const pending: Capabilities = { mode: "pending", actions: [] };
  workspaceCapabilities.set(id, pending);
  const result = await fetchCapabilities(`/api/v1/workspaces/${id}/capabilities`);
  if (workspaceCapabilities.get(id) === pending) workspaceCapabilities.set(id, result);
  queueRender("all");
}

export async function loadChannelCapabilities(id: string): Promise<void> {
  const pending: Capabilities = { mode: "pending", actions: [] };
  channelCapabilities.set(id, pending);
  const result = await fetchCapabilities(`/api/v1/channels/${id}/capabilities`);
  if (channelCapabilities.get(id) === pending) {
    channelCapabilities.set(id, result);
    if (result.inaccessible && uiContext.state.selectedChannelId === id) clearSelectedChannel();
    if (result.inaccessible && uiContext.voiceMgr.getSnapshot().channelId === id) await uiContext.voiceMgr.leave();
  }
  queueRender("all");
}

let refreshing = false, queuedWorkspace: string | null = null;
export function invalidatePermissions(workspaceId: string): void {
  if (uiContext.state.selectedWorkspaceId !== workspaceId) {
    workspaceCapabilities.delete(workspaceId);
    return;
  }
  workspaceCapabilities.set(workspaceId, { mode: "pending", actions: [] });
  for (const channel of uiContext.state.channels) {
    channelCapabilities.set(channel.id, { mode: "pending", actions: [] });
    channel.actions = [];
  }
  queuedWorkspace = workspaceId;
  queueRender("all");
  if (!refreshing) void refreshInvalidatedPermissions();
}

async function refreshInvalidatedPermissions(): Promise<void> {
  refreshing = true;
  // Events arriving during a request produce one following refresh, never
  // a request storm. Selection checks isolate responses from another workspace.
  try {
    while (queuedWorkspace) {
      const id = queuedWorkspace;
      queuedWorkspace = null;
      const generation = uiContext.syncGeneration;
      const oldChannels = uiContext.state.channels.map((c) => c.id);
      const current = () => uiContext.state.selectedWorkspaceId === id && generation === uiContext.syncGeneration;
      try {
        const [ws, channels, categories, caps] = await Promise.all([
          uiContext.httpClient.get<Workspace>(`/api/v1/workspaces/${id}`),
          uiContext.httpClient.get<{ items: Channel[] }>(`/api/v1/workspaces/${id}/channels`),
          uiContext.httpClient.get<{ items: ChannelCategory[] }>(`/api/v1/workspaces/${id}/categories`),
          fetchCapabilities(`/api/v1/workspaces/${id}/capabilities`),
        ]);
        if (!current() || queuedWorkspace === id) continue;
        workspaceCapabilities.set(id, caps);
        uiContext.state.workspaces = uiContext.state.workspaces.map((w) => w.id === id ? ws : w);
        uiContext.state.channels = channels.items ?? [];
        uiContext.state.categories = categories.items ?? [];
        for (const ch of uiContext.state.channels) {
          channelCapabilities.delete(ch.id);
          if (Array.isArray(ch.actions)) channelCapabilities.set(ch.id, { mode: "known", actions: ch.actions });
          else if (caps.mode === "legacy") channelCapabilities.set(ch.id, { mode: "legacy", actions: [] });
        }
        const visible = new Set(uiContext.state.channels.map((c) => c.id));
        if (uiContext.state.selectedChannelId && oldChannels.includes(uiContext.state.selectedChannelId) && !visible.has(uiContext.state.selectedChannelId)) clearSelectedChannel();
        const voiceId = uiContext.voiceMgr.getSnapshot().channelId;
        if (voiceId && oldChannels.includes(voiceId) && !visible.has(voiceId)) await uiContext.voiceMgr.leave();
        await Promise.all([loadMembers(generation), loadWsRoles(id, generation)]);
        if (current() && uiContext.state.selectedChannelId && !channelCapabilities.has(uiContext.state.selectedChannelId)) await loadChannelCapabilities(uiContext.state.selectedChannelId);
      } catch (err) {
        if (!current()) continue;
        const status = (err as ApiError)?.status;
        if (status === 403 || status === 404) {
          uiContext.state.workspaces = uiContext.state.workspaces.filter((w) => w.id !== id);
          uiContext.state.selectedWorkspaceId = null;
          uiContext.state.channels = []; uiContext.state.categories = []; uiContext.state.members = []; uiContext.state.wsRoles = [];
          clearSelectedChannel();
          const voiceId = uiContext.voiceMgr.getSnapshot().channelId;
          if (voiceId && oldChannels.includes(voiceId)) await uiContext.voiceMgr.leave();
        }
        uiContext.state.status = describeError(err);
      }
      queueRender("all");
    }
  } finally { refreshing = false; }
}

function clearSelectedChannel(): void {
  uiContext.state.selectedChannelId = null; uiContext.state.messages = [];
  uiContext.state.editingMessageId = null; uiContext.state.replyingTo = null;
  uiContext.state.pendingUploads = [];
}
