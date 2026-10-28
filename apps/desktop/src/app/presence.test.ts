import { beforeEach, describe, expect, it } from "vitest";
import { applyPresenceEvent, applyPresenceSnapshot, decideAutomaticStatus, presenceRevision, resetPresence, resolvePresence, resolveUserPresence } from "./presence";
import { uiContext } from "./state";

beforeEach(() => { resetPresence(); uiContext.state.me = null; uiContext.state.members = []; uiContext.state.dms = []; uiContext.state.friends = []; });
describe("presence consistency", () => {
  it("manual mode wins a contradictory connectivity flag", () => {
    expect(resolvePresence({ presenceMode: "dnd", online: false }).mode).toBe("dnd");
    expect(resolvePresence({ presenceMode: "offline", online: true }).online).toBe(false);
  });
  it("self uses private profile truth even after its masked public event", () => {
    uiContext.state.me = { id: "self", username: "self", email: "self@test", presenceMode: "invisible", customStatus: "private" };
    applyPresenceEvent("self", { presenceMode: "offline", customStatus: "" });
    expect(resolveUserPresence("self")).toEqual({ mode: "invisible", online: false, customStatus: "private" });
    expect(resolvePresence({ presenceMode: "invisible", online: true, customStatus: "private" })).toEqual({ mode: "offline", online: false, customStatus: "" });
  });
  it("late API snapshot cannot overwrite a newer realtime status or revive cleared text", () => {
    const started = presenceRevision();
    applyPresenceEvent("peer", { presenceMode: "idle", customStatus: "" });
    expect(applyPresenceSnapshot("peer", { presenceMode: "online", customStatus: "stale" }, started)).toEqual({ presenceMode: "idle", online: true, customStatus: "" });
    expect(applyPresenceSnapshot("peer", { presenceMode: "dnd", customStatus: "new" }, presenceRevision())).toEqual({ presenceMode: "dnd", online: true, customStatus: "new" });
  });
  it("event without timestamp does not erase ordering, so a stale event cannot revert status", () => {
    applyPresenceEvent("peer", { presenceMode: "online" }, "2026-10-28T10:00:00.000Z");
    applyPresenceEvent("peer", { presenceMode: "dnd" });
    applyPresenceEvent("peer", { presenceMode: "idle" }, "2026-10-28T09:00:00.000Z");
    expect(resolveUserPresence("peer").mode).toBe("dnd");
  });
});

describe("automatic idle decision", () => {
  it("goes idle only from online after inactivity", () => {
    expect(decideAutomaticStatus({ presenceMode: "online", autoIdle: false, active: false })).toBe("idle");
    expect(decideAutomaticStatus({ presenceMode: "online", autoIdle: false, active: true })).toBe("none");
  });
  it("never overrides manual dnd, invisible or idle", () => {
    for (const presenceMode of ["dnd", "invisible", "idle", "offline"] as const) {
      expect(decideAutomaticStatus({ presenceMode, autoIdle: false, active: false })).toBe("none");
    }
  });
  it("returns to online on activity when idle was automatic", () => {
    expect(decideAutomaticStatus({ presenceMode: "idle", autoIdle: true, active: true })).toBe("online");
  });
  it("keeps automatic idle while the user is still away", () => {
    expect(decideAutomaticStatus({ presenceMode: "idle", autoIdle: true, active: false })).toBe("none");
  });
  it("retries a failed return to online on the next check while the user is active", () => {
    // Флаг после ошибки сети остаётся true, сервер всё ещё в idle.
    expect(decideAutomaticStatus({ presenceMode: "idle", autoIdle: true, active: true })).toBe("online");
  });
  it("does not touch manual idle even when the user is active", () => {
    expect(decideAutomaticStatus({ presenceMode: "idle", autoIdle: false, active: true })).toBe("none");
  });
});
