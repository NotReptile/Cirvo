import { CallManager } from "../call/callManager";
import { VoiceChannelManager } from "../call/voiceChannelManager";
import { HttpClient } from "../network/httpClient";
import { RealtimeClient } from "../realtime/realtimeClient";
import { renderOnboarding } from "./onboarding";
import { deriveRealtimeUrl, getStoredServerUrl, isProductionShell } from "./serverConfig";
import { renderApp } from "./ui";
import { createTokenStore } from "./tauriTokenStore";
import { prepareMessageDateFormats } from "./util/dateFormat";

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
  if (isProductionShell()) {
    const stored = getStoredServerUrl();
    if (!stored) {
      renderOnboarding(container, (url) => {
        startApp(container, url, deriveRealtimeUrl(url));
      });
      return;
    }
    startApp(container, stored, deriveRealtimeUrl(stored));
    return;
  }
  startApp(container, readApiBaseUrl(), readRealtimeUrl());
}

function startApp(container: HTMLElement, apiBaseUrl: string, realtimeUrl: string): void {
  void startAppAsync(container, apiBaseUrl, realtimeUrl).catch(() => {
    container.replaceChildren();
    const message = document.createElement("p");
    message.textContent = "Не удалось открыть хранилище сессии. Перезапустите Cirvo.";
    container.append(message);
  });
}

async function startAppAsync(container: HTMLElement, apiBaseUrl: string, realtimeUrl: string): Promise<void> {
  const store = await createTokenStore(apiBaseUrl || window.location.origin);
  // Initialize ICU once while bootstrapping, before a channel response needs rendering.
  prepareMessageDateFormats();
  const http = new HttpClient(apiBaseUrl, store);
  const realtime = new RealtimeClient(realtimeUrl, async () => {
    const result = await http.post<{ ticket: string }>("/api/v1/realtime/ticket", {});
    return result.ticket || null;
  });

  const callManager = new CallManager(http, realtime);
  const voiceManager = new VoiceChannelManager(http, realtime);

  http.onTokensChanged((tokens) => {
    realtime.setAccessToken(tokens?.accessToken ?? null);
    if (!tokens) {
      callManager.hangup();
      void voiceManager.leave();
    }
  });

  renderApp(container, http, realtime, callManager, voiceManager);
}
