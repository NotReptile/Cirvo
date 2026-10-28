import { beforeEach, describe, expect, it } from "vitest";
import {
  planStreamLayout,
  pruneLayoutState,
  resetLayoutState,
  togglePinnedSession,
} from "./voiceLayout";

const p = (sessionId: string, sharing: boolean) => ({ sessionId, sharing });

describe("planStreamLayout", () => {
  beforeEach(() => resetLayoutState());

  it("без стримов — обычная сетка", () => {
    expect(planStreamLayout([p("a", false), p("b", false)])).toEqual({ mode: "grid" });
  });

  it("один стрим — крупно", () => {
    expect(planStreamLayout([p("a", false), p("b", true)])).toEqual({ mode: "single", primary: "b" });
  });

  it("несколько стримов — сетка равных плиток", () => {
    const plan = planStreamLayout([p("a", true), p("b", true), p("c", true), p("d", false)]);
    expect(plan).toEqual({ mode: "multi", streams: ["a", "b", "c"], columns: 2 });
  });

  it("закреплённый стрим выводится крупно", () => {
    togglePinnedSession("b");
    expect(planStreamLayout([p("a", true), p("b", true)])).toEqual({ mode: "pinned", primary: "b" });
    togglePinnedSession("b");
    expect(planStreamLayout([p("a", true), p("b", true)]).mode).toBe("multi");
  });

  it("закрепление сбрасывается, когда стрим закончился", () => {
    togglePinnedSession("b");
    pruneLayoutState(["a"], ["a", "b"]);
    expect(planStreamLayout([p("a", true), p("b", false)])).toEqual({ mode: "single", primary: "a" });
  });
});
