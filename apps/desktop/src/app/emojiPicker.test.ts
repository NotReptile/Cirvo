import { describe, expect, it } from "vitest";
import { CUSTOM_REACTION_MAX, checkCustomReaction } from "./emojiPicker";

describe("checkCustomReaction", () => {
  it("принимает короткий текст и обрезает пробелы", () => {
    expect(checkCustomReaction("  ок так  ")).toEqual({ value: "ок так", length: 6, ok: true });
  });

  it("пустая строка и пробелы не проходят", () => {
    expect(checkCustomReaction("").ok).toBe(false);
    expect(checkCustomReaction("   ").ok).toBe(false);
  });

  it("лимит считается в символах, а не в UTF-16 единицах", () => {
    const max = "я".repeat(CUSTOM_REACTION_MAX);
    expect(checkCustomReaction(max).ok).toBe(true);
    expect(checkCustomReaction("я".repeat(CUSTOM_REACTION_MAX + 1)).ok).toBe(false);
    // Эмодзи занимают 2 UTF-16 единицы, но один символ.
    expect(checkCustomReaction("🎉".repeat(CUSTOM_REACTION_MAX)).ok).toBe(true);
    expect(checkCustomReaction("🎉".repeat(CUSTOM_REACTION_MAX + 1)).length).toBe(CUSTOM_REACTION_MAX + 1);
  });

  it("управляющие символы и переводы строк запрещены", () => {
    expect(checkCustomReaction("строка\nвторая").ok).toBe(false);
    expect(checkCustomReaction("tab\there").ok).toBe(false);
  });
});
