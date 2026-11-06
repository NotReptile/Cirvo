import { describe, expect, it } from "vitest";
import { describeError } from "./errors";

describe("describeError", () => {
  it("объясняет недоступное и ненастроенное хранилище файлов", () => {
    expect(describeError({ status: 503, code: "service_unavailable", message: "x" })).toBe(
      "Хранилище файлов временно недоступно. Повтори через минуту.",
    );
    expect(describeError({ status: 503, code: "internal_error", message: "object storage is not configured" })).toBe(
      "Загрузка файлов не настроена на сервере. Сообщи администратору.",
    );
  });

  it("ошибка сервера: сообщение и код", () => {
    expect(describeError({ status: 409, code: "conflict", message: "email or username already taken" })).toBe(
      "email or username already taken (conflict)"
    );
  });

  it("нет ответа (status 0): без кода", () => {
    expect(describeError({ status: 0, code: "network", message: "Нет связи с сервером" })).toBe("Нет связи с сервером");
  });

  it("запрет микрофона не превращается в «Permission denied (0)»", () => {
    const text = describeError(new DOMException("Permission denied", "NotAllowedError"));
    expect(text).toContain("Нет доступа к микрофону");
    expect(text).not.toContain("(0)");
    expect(text).not.toContain("Permission denied");
  });

  it("устройство не найдено", () => {
    expect(describeError(new DOMException("Requested device not found", "NotFoundError"))).toContain("Устройство не найдено");
  });

  it("устройство занято", () => {
    expect(describeError(new DOMException("Could not start audio source", "NotReadableError"))).toContain("занято");
  });

  it("сохранённое устройство или режим недоступны", () => {
    expect(describeError(new DOMException("", "OverconstrainedError")))
      .toContain("Выбранное устройство или режим недоступны");
  });

  it("прочие DOMException: их сообщение", () => {
    expect(describeError(new DOMException("Something odd", "AbortError"))).toBe("Something odd");
  });

  it("обычная ошибка и неизвестное значение", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError(null)).toBe("Неизвестная ошибка");
  });
});
