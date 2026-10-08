import { describe, expect, it } from "vitest";
import { bytesToMb, mbToBytes } from "./units";

describe("bytesToMb", () => {
  it("целые мегабайты без дробной части", () => {
    expect(bytesToMb(26_214_400)).toBe("25");
    expect(bytesToMb(1_048_576)).toBe("1");
  });

  it("дробные значения до двух знаков", () => {
    expect(bytesToMb(1_572_864)).toBe("1.5");
    expect(bytesToMb(1_000_000)).toBe("0.95");
  });

  it("ноль, отрицательные и мусор дают 0", () => {
    expect(bytesToMb(0)).toBe("0");
    expect(bytesToMb(-5)).toBe("0");
    expect(bytesToMb(Number.NaN)).toBe("0");
  });
});

describe("mbToBytes", () => {
  it("переводит мегабайты в байты", () => {
    expect(mbToBytes("25")).toBe(26_214_400);
    expect(mbToBytes("1.5")).toBe(1_572_864);
    expect(mbToBytes("0")).toBe(0);
  });

  it("принимает запятую как десятичный разделитель", () => {
    expect(mbToBytes("1,5")).toBe(1_572_864);
  });

  it("пустое, отрицательное и нечисловое значение даёт null", () => {
    expect(mbToBytes("")).toBeNull();
    expect(mbToBytes("  ")).toBeNull();
    expect(mbToBytes("-1")).toBeNull();
    expect(mbToBytes("abc")).toBeNull();
  });

  it("обратимо для круглых значений", () => {
    expect(mbToBytes(bytesToMb(26_214_400))).toBe(26_214_400);
  });
});
