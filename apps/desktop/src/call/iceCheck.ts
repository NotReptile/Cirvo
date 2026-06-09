import type { HttpClient } from "../network/httpClient";

// Wave 0: диагностика ICE/TURN из админ-панели. Два клиента за NAT не соединятся
// без работающего TURN-релея, а его сбой (порты не проброшены, coturn лежит,
// credentials протухли) — тихий: звонок просто «не слышно». Этот чек собирает
// RTCPeerConnection против выданных /ice-servers и смотрит, какие типы
// кандидатов реально пришли.

export interface IceCheckResult {
  /** Бэкенд вообще выдал turn:/turns: URL в /ice-servers. */
  turnConfigured: boolean;
  /** Получен srflx-кандидат — STUN отвечает, свой внешний адрес узнали. */
  stunOk: boolean;
  /** Получен relay-кандидат — TURN-аллокация прошла, релей рабочий. */
  relayOk: boolean;
  /** Адрес релея (ip:port) из relay-кандидата — видно, через что пойдёт медиа. */
  relayAddress: string | null;
  /** Список URL, которые выдал бэкенд (для показа в админке). */
  serverUrls: string[];
  elapsedMs: number;
  error: string | null;
}

interface IceServersResponse {
  iceServers: RTCIceServer[];
}

function flattenUrls(servers: RTCIceServer[]): string[] {
  const out: string[] = [];
  for (const s of servers) {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    for (const u of urls) if (u) out.push(u);
  }
  return out;
}

// ICE gathering может «зависнуть» если TURN не отвечает — ждём кандидатов
// ограниченное время, а не gatheringstatechange=complete.
const GATHER_TIMEOUT_MS = 8000;

export async function runIceCheck(http: HttpClient): Promise<IceCheckResult> {
  const startedAt = Date.now();
  const result: IceCheckResult = {
    turnConfigured: false,
    stunOk: false,
    relayOk: false,
    relayAddress: null,
    serverUrls: [],
    elapsedMs: 0,
    error: null
  };

  let servers: RTCIceServer[];
  try {
    const resp = await http.get<IceServersResponse>("/api/v1/ice-servers");
    servers = resp.iceServers ?? [];
  } catch (err) {
    result.error = `Не удалось получить /ice-servers: ${err instanceof Error ? err.message : String(err)}`;
    result.elapsedMs = Date.now() - startedAt;
    return result;
  }

  result.serverUrls = flattenUrls(servers);
  result.turnConfigured = result.serverUrls.some((u) => /^turns?:/i.test(u));

  // Политика "all": один PC даёт и srflx (STUN), и relay (TURN) кандидатов.
  const pc = new RTCPeerConnection({ iceServers: servers });
  try {
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => resolve(), GATHER_TIMEOUT_MS);
      const maybeFinish = () => {
        // Как только увидели relay — дальше ждать нечего (srflx приходит раньше).
        if (result.relayOk || pc.iceGatheringState === "complete") {
          window.clearTimeout(timer);
          resolve();
        }
      };
      pc.onicecandidate = (ev) => {
        const c = ev.candidate;
        if (!c) {
          // null-кандидат = gathering завершён.
          window.clearTimeout(timer);
          resolve();
          return;
        }
        // c.type есть в Chromium/WebView2; fallback — парсинг SDP-строки.
        const type = c.type ?? (/ typ (\w+)/.exec(c.candidate)?.[1] ?? "");
        if (type === "srflx") result.stunOk = true;
        if (type === "relay") {
          result.relayOk = true;
          const addr = c.address ?? null;
          const port = c.port ?? null;
          result.relayAddress = addr ? (port ? `${addr}:${port}` : addr) : null;
        }
        maybeFinish();
      };
      pc.createDataChannel("ice-check");
      void pc
        .createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch((err) => {
          result.error = err instanceof Error ? err.message : String(err);
          window.clearTimeout(timer);
          resolve();
        });
    });
  } finally {
    pc.close();
  }

  result.elapsedMs = Date.now() - startedAt;
  return result;
}
