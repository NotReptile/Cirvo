import { describe, expect, it } from "vitest";
import { resolveSfuWsUrl } from "./sfuUrl";

describe("resolveSfuWsUrl", () => {
  it("абсолютный wss:// остаётся как есть", () => {
    expect(resolveSfuWsUrl("wss://chat.example.com/sfu/ws", "https://other.example.com")).toBe(
      "wss://chat.example.com/sfu/ws"
    );
  });

  it("относительный путь строится от адреса сервера, а не страницы", () => {
    expect(resolveSfuWsUrl("/sfu/ws", "https://chat.example.com", "http://tauri.localhost")).toBe(
      "wss://chat.example.com/sfu/ws"
    );
  });

  it("http-сервер даёт ws://", () => {
    expect(resolveSfuWsUrl("/sfu/ws", "http://192.168.1.10:8080")).toBe("ws://192.168.1.10:8080/sfu/ws");
  });

  it("без адреса сервера (dev через прокси) берётся адрес страницы", () => {
    expect(resolveSfuWsUrl("/sfu/ws", "", "http://localhost:1420")).toBe("ws://localhost:1420/sfu/ws");
  });
});
