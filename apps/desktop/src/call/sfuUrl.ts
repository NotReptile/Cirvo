// Адрес SFU-сокета. Сервер обычно отдаёт абсолютный wss://, но относительный
// путь ("/sfu/ws") тоже допустим: тогда он строится от адреса сервера Cirvo.
// Хост страницы тут не подходит: в десктопном клиенте это tauri.localhost.
export function resolveSfuWsUrl(wsUrl: string, serverUrl: string, pageOrigin?: string): string {
  if (/^wss?:\/\//i.test(wsUrl)) return wsUrl;
  const origin = serverUrl || pageOrigin || (typeof window !== "undefined" ? window.location.origin : "");
  const url = new URL(wsUrl, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
