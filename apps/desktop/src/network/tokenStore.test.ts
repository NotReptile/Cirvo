import { describe, expect, it } from "vitest";
import { HttpClient } from "./httpClient";
import { parseTokens } from "./tokenStore";

const tokens = { accessToken: "access", accessExpiresAt: "2999-01-01", refreshToken: "refresh", sessionId: "session" };

describe("token persistence", () => {
  it("rejects damaged stored credentials", () => {
    for (const raw of [null, "broken", "null", "{}", '{"accessToken":1}']) expect(parseTokens(raw)).toBeNull();
    expect(parseTokens(JSON.stringify(tokens))).toEqual(tokens);
  });

  it("serializes saves and deletion so a delayed save cannot undo logout", async () => {
    let release!: () => void;
    const writes: unknown[] = [];
    const client = new HttpClient("https://example.com", {
      read: () => null,
      async write(value) {
        if (value) await new Promise<void>(resolve => { release = resolve; });
        writes.push(value);
      }
    });
    client.setTokens(tokens);
    await Promise.resolve(); await Promise.resolve();
    client.setTokens(null);
    release();
    await client.flushTokens();
    expect(writes).toEqual([tokens, null]);
    expect(client.getTokens()).toBeNull();
  });
});
