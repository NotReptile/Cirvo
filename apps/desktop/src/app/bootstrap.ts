import { CallManager } from "../call/callManager";
import { HttpClient } from "../network/httpClient";
import { RealtimeClient } from "../realtime/realtimeClient";
import { renderApp } from "./ui";

function readApiBaseUrl(): string {
  return import.meta.env.VITE_API_BASE_URL ?? "";
}

function readRealtimeUrl(): string {
  if (import.meta.env.VITE_REALTIME_URL) {
    return import.meta.env.VITE_REALTIME_URL;
  }
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws`;
}

export function bootstrapDesktopApp(container: HTMLElement): void {
  const http = new HttpClient(readApiBaseUrl());
  const realtime = new RealtimeClient(readRealtimeUrl());

  const callManager = new CallManager(http, realtime);

  http.onTokensChanged((tokens) => {
    realtime.setAccessToken(tokens?.accessToken ?? null);
    if (!tokens) {
      callManager.hangup();
    }
  });

  renderApp(container, http, realtime, callManager);
}
