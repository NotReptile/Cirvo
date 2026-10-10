import { beforeEach, describe, expect, it } from "vitest";
import { applyPresenceEvent, applyPresenceSnapshot, presenceRevision, resetPresence, resolvePresence, resolveUserPresence } from "./presence";
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
});
