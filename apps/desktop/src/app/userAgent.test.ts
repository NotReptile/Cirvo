import { describe, expect, it } from "vitest";
import { describeDeviceLabel, describeUserAgent } from "./userAgent";

describe("describeUserAgent", () => {
  it("WebView2 в десктопном клиенте", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0";
    expect(describeUserAgent(ua)).toBe("Windows · Edge / WebView2");
  });

  it("Chrome и Firefox", () => {
    expect(describeUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36")).toBe("Linux · Chrome");
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0")).toBe("Windows · Firefox");
  });

  it("пусто и неизвестное", () => {
    expect(describeUserAgent("")).toBe("");
    expect(describeUserAgent(undefined)).toBe("");
    expect(describeUserAgent("curl/8.0")).toBe("");
  });
});

describe("describeDeviceLabel", () => {
  it("подменяет служебную метку клиента", () => {
    expect(describeDeviceLabel("cirvo-desktop")).toBe("Приложение Cirvo");
    expect(describeDeviceLabel("Мой ноутбук")).toBe("Мой ноутбук");
    expect(describeDeviceLabel(undefined)).toBe("");
  });
});
