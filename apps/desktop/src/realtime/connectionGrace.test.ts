import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConnectionGate } from "./connectionGrace";

describe("createConnectionGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("не показывает плашку при коротком обрыве", () => {
    const calls: boolean[] = [];
    const gate = createConnectionGate((v) => calls.push(v), 4000);
    gate.push("reconnecting");
    vi.advanceTimersByTime(1500);
    gate.push("connected");
    vi.advanceTimersByTime(10_000);
    expect(calls).toEqual([]);
  });

  it("показывает плашку после grace и скрывает при восстановлении", () => {
    const calls: boolean[] = [];
    const gate = createConnectionGate((v) => calls.push(v), 4000);
    gate.push("reconnecting");
    vi.advanceTimersByTime(3999);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([true]);
    gate.push("connected");
    expect(calls).toEqual([true, false]);
  });

  it("повторные reconnecting не сбрасывают отсчёт", () => {
    const calls: boolean[] = [];
    const gate = createConnectionGate((v) => calls.push(v), 4000);
    gate.push("reconnecting");
    vi.advanceTimersByTime(2000);
    gate.push("reconnecting");
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual([true]);
  });

  it("offline скрывает плашку и отменяет таймер", () => {
    const calls: boolean[] = [];
    const gate = createConnectionGate((v) => calls.push(v), 4000);
    gate.push("reconnecting");
    gate.push("offline");
    vi.advanceTimersByTime(10_000);
    expect(calls).toEqual([]);
  });
});
