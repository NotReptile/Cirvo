// Текст ошибки для пользователя. Вынесено из ui.ts, чтобы покрыть тестами.

function describeDeviceError(err: DOMException): string {
  switch (err.name) {
    case "NotAllowedError":
      return "Нет доступа к микрофону или камере. Разреши доступ в настройках Windows (Конфиденциальность и защита).";
    case "NotFoundError":
      return "Устройство не найдено. Подключи микрофон или камеру либо выбери другое в настройках.";
    case "OverconstrainedError":
      return "Выбранное устройство или режим недоступны. Выбери другой микрофон, камеру или разрешение в настройках.";
    case "NotReadableError":
      return "Устройство занято другим приложением или недоступно.";
    default:
      return err.message || err.name;
  }
}

export function describeError(err: unknown): string {
  // DOMException тоже имеет поля code и message, но code у него числовой
  // (NotAllowedError даёт 0), поэтому проверять его нужно раньше ответа сервера.
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return describeDeviceError(err);
  }
  if (typeof err === "object" && err !== null) {
    const e = err as { status?: unknown; code?: unknown; message?: unknown };
    if (typeof e.code === "string" && typeof e.message === "string") {
      // status 0: ответа не было (нет связи, таймаут). Код ошибки пользователю не нужен.
      if (e.status === 0) return e.message;
      return `${e.message} (${e.code})`;
    }
  }
  if (err instanceof Error) return err.message;
  return "Неизвестная ошибка";
}
