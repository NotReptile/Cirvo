import { describe, expect, it } from "vitest";
import { inviteExpiresAt, inviteExpiryLabel, isInviteExpired } from "./invites";

const NOW = Date.parse("2026-10-08T12:00:00Z");

describe("inviteExpiresAt", () => {
  it("0, пустое и мусор: без срока", () => {
    expect(inviteExpiresAt("0", NOW)).toBeUndefined();
    expect(inviteExpiresAt("", NOW)).toBeUndefined();
    expect(inviteExpiresAt("abc", NOW)).toBeUndefined();
    expect(inviteExpiresAt(-5, NOW)).toBeUndefined();
  });

  it("считает RFC3339 от текущего момента", () => {
    expect(inviteExpiresAt("3600", NOW)).toBe("2026-10-08T13:00:00.000Z");
    expect(inviteExpiresAt("604800", NOW)).toBe("2026-10-15T12:00:00.000Z");
  });
});

describe("isInviteExpired и inviteExpiryLabel", () => {
  it("без срока не истекает", () => {
    expect(isInviteExpired(undefined, NOW)).toBe(false);
    expect(inviteExpiryLabel(undefined, NOW)).toBe("");
  });

  it("прошедший срок: «истёк»", () => {
    expect(isInviteExpired("2026-10-08T11:59:59Z", NOW)).toBe(true);
    expect(inviteExpiryLabel("2026-10-08T11:59:59Z", NOW)).toBe("истёк");
  });

  it("будущий срок: «до …»", () => {
    expect(isInviteExpired("2026-10-09T12:00:00Z", NOW)).toBe(false);
    expect(inviteExpiryLabel("2026-10-09T12:00:00Z", NOW)).toMatch(/^до /);
  });
});
