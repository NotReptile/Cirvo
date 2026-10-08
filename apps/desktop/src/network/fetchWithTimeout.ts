// fetch с таймаутом. Без него зависший сервер подвешивал интерфейс навсегда:
// браузерный fetch сам по себе ждёт ответ минутами. Таймер действует до
// получения заголовков ответа; чтение тела (в том числе большой загрузки)
// им не ограничено.

export class FetchTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Запрос не завершился за ${Math.round(timeoutMs / 1000)} с`);
    this.name = "FetchTimeoutError";
  }
}

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const external = init.signal ?? undefined;
  const onExternalAbort = (): void => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) throw new FetchTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}
