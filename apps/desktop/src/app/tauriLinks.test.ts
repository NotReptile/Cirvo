import { describe, expect, it } from "vitest";
import { externalHttpUrl } from "./tauriLinks";

describe("external link boundary", () => {
  it("allows HTTP(S) and refuses executable, file and credential URLs", () => {
    expect(externalHttpUrl("https://example.com/path")).toBe("https://example.com/path");
    for (const value of ["javascript:alert(1)", "file:///C:/Windows", "data:text/html,x", "https://user:pass@example.com", "/relative"]) {
      expect(externalHttpUrl(value)).toBeNull();
    }
  });
});
