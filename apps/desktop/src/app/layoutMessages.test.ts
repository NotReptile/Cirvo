import { describe, expect, it } from "vitest";
import { layoutMessages, messageWindow } from "./layoutMessages";

const m = (id: string, time: string, extra = {}) => ({
  id,
  authorId: "peer",
  createdAt: time,
  ...extra,
});
describe("message layout across DOM windows", () => {
  it("uses the preceding message outside the window for grouping", () => {
    const messages = [
      m("a", "2026-10-01T12:00:00Z"),
      m("b", "2026-10-01T12:01:00Z"),
    ];
    expect(
      layoutMessages(messages, { groupMessages: true, start: 1 })[0],
    ).toMatchObject({ id: "b", day: false, grouped: true });
  });
  it("breaks groups at the unread divider, day change, reply and system message", () => {
    const messages = [
      m("a", "2026-10-01T12:00:00Z"),
      m("b", "2026-10-01T12:01:00Z"),
      m("c", "2026-10-01T12:02:00Z", { replyTo: {} }),
      m("d", "2026-10-01T12:03:00Z", { kind: "system" }),
      m("e", "2026-10-02T12:03:00Z"),
    ];
    const rows = layoutMessages(messages, {
      groupMessages: true,
      lastReadAt: "2026-10-01T12:00:30Z",
    });
    expect(rows.every((row) => !row.grouped)).toBe(true);
    expect(rows.filter((row) => row.unread).map((row) => row.id)).toEqual([
      "b",
    ]);
    expect(rows.at(-1)?.day).toBe(true);
  });
  it("bounds both tail and history windows at 200 messages", () => {
    expect(messageWindow(3000, null)).toEqual({ start: 2800, end: 3000 });
    expect(messageWindow(3000, 50)).toEqual({ start: 50, end: 250 });
    expect(messageWindow(50, -10)).toEqual({ start: 0, end: 50 });
  });
});
