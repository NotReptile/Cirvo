import { describe, expect, it } from "vitest";
import { renderBody } from "../messageBody";
import { transformSlashCommand } from "./commands";
import { dayKeyOf } from "./dates";
import { escapeHtml } from "./html";
import { permDraftToList } from "./permissions";
import { formatTime, formatTimeSmart, formatTimeSmartShort } from "./format";

describe("extracted rendering helpers", () => {
  it("escapes all HTML delimiters and handles empty values", () => {
    expect(escapeHtml('<a x="&\'">')).toBe(
      "&lt;a x=&quot;&amp;&#39;&quot;&gt;",
    );
    expect(escapeHtml(null)).toBe("");
  });
  it("keeps ordinary text and interprets supported slash commands", () => {
    expect(transformSlashCommand("/nick Новое имя")).toEqual({
      kind: "nick",
      name: "Новое имя",
    });
    expect(transformSlashCommand("text")).toEqual({
      kind: "send",
      body: "text",
    });
  });
  it("rejects invalid dates and groups permission changes by subject", () => {
    expect(formatTime("bad")).toBe("bad");
    expect(formatTimeSmart("bad")).toBe("bad");
    expect(formatTimeSmartShort("bad")).toBe("bad");
    expect(dayKeyOf("bad")).toBeNull();
    expect(
      permDraftToList({
        user: {
          "message.write": "grant",
          "message.react": "deny",
          "channel.view": "inherit",
        },
      } as any),
    ).toEqual([
      { key: "user", granted: ["message.write"], denied: ["message.react"] },
    ]);
  });
  it("renders escaped markdown, only known mentions and safe links", () => {
    const context = {
      meUsername: "alice",
      membersByUsername: new Map([["alice", {}]]),
      channelsByName: new Map([["general", { id: "channel-id" }]]),
    };
    expect(
      renderBody(
        "**Hello** @alice #general <script> `x<y`",
        undefined,
        context,
      ),
    ).toBe(
      '<strong>Hello</strong> <span class="mention mention-self">@alice</span> <span class="channel-link" data-channel-link="channel-id">#general</span> &lt;script&gt; <code class="md-code">x&lt;y</code>',
    );
    expect(
      renderBody("javascript:alert(1) @unknown", undefined, context),
    ).not.toContain("<a");
  });
});
