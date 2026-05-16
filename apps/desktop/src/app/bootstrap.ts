import { HttpClient } from "../network/httpClient";
import { RealtimeClient } from "../realtime/realtimeClient";
import { renderApp } from "./ui";

function readApiBaseUrl(): string {
  return import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8080";
}

function readRealtimeUrl(): string {
  return import.meta.env.VITE_REALTIME_URL ?? "ws://127.0.0.1:8090/ws";
}

export function bootstrapDesktopApp(container: HTMLElement): void {
  const http = new HttpClient(readApiBaseUrl());
  const realtime = new RealtimeClient(readRealtimeUrl());

  http.onTokensChanged((tokens) => {
    realtime.setAccessToken(tokens?.accessToken ?? null);
  });

  renderApp(container, http, realtime);
}
