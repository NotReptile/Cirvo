import { uiContext } from "./state";
import type { PresenceMode } from "./types";

export type PresenceFields = { presenceMode?: PresenceMode; online?: boolean; customStatus?: string };
export type ResolvedPresence = { mode: PresenceMode; online: boolean; customStatus: string };
const modes = new Set<PresenceMode>(["online", "idle", "dnd", "invisible", "offline"]);
const updates = new Map<string, { value: ResolvedPresence; revision: number; updatedAt?: string }>();
let revision = 0;

export function resolvePresence(fields: PresenceFields, self = false): ResolvedPresence {
  let mode = fields.presenceMode && modes.has(fields.presenceMode) ? fields.presenceMode : fields.online ? "online" : "offline";
  const invisible = mode === "invisible";
  if (invisible && !self) mode = "offline";
  return { mode, online: mode !== "offline" && mode !== "invisible", customStatus: invisible && !self ? "" : fields.customStatus ?? "" };
}

export function resolveUserPresence(userId: string, fallback: PresenceFields = {}): ResolvedPresence {
  if (userId === uiContext.state.me?.id) return resolvePresence({ presenceMode: uiContext.state.me.presenceMode ?? "online", customStatus: uiContext.state.me.customStatus }, true);
  return updates.get(userId)?.value ?? resolvePresence(fallback);
}

export function presenceRevision(): number { return revision; }
export function resetPresence(): void { updates.clear(); revision++; }

export function applyPresenceSnapshot<T extends PresenceFields>(userId: string, fields: T, startedAt: number): T {
  const cached = updates.get(userId);
  if (!cached || cached.revision <= startedAt) updates.set(userId, { value: resolvePresence(fields), revision });
  const current = resolveUserPresence(userId, fields);
  return { ...fields, presenceMode: current.mode, online: current.online, customStatus: current.customStatus };
}

export function applyPresenceEvent(userId: string, fields: PresenceFields, updatedAt?: string): void {
  const old = updates.get(userId)?.updatedAt;
  if (updatedAt && old && Date.parse(updatedAt) < Date.parse(old)) return;
  updates.set(userId, { value: resolvePresence(fields), revision: ++revision, updatedAt });
  syncPresenceSurfaces(userId);
}

export function syncPresenceSurfaces(userId: string): void {
  const apply = <T extends PresenceFields>(value: T): T => {
    const current = resolveUserPresence(userId, value);
    return { ...value, presenceMode: current.mode, online: current.online, customStatus: current.customStatus };
  };
  uiContext.state.members = uiContext.state.members.map((m) => m.userId === userId ? apply(m) : m);
  uiContext.state.dms = uiContext.state.dms.map((d) => d.peer.userId === userId ? { ...d, peer: apply(d.peer) } : d);
  uiContext.state.friends = uiContext.state.friends.map((f) => f.userId === userId ? apply(f) : f);
  if (uiContext.state.userProfileTarget === userId && uiContext.state.userProfileData) uiContext.state.userProfileData = apply(uiContext.state.userProfileData);
}
