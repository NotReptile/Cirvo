import type { DesktopBootstrapConfig } from "@rucord/shared-ts";
import { AppController } from "../application/appController";
import { SettingsStore } from "../local-cache/settingsStore";
import { MediaManager } from "../media/mediaManager";
import { HttpClient } from "../network/httpClient";
import { RealtimeClient } from "../realtime/realtimeClient";
import { renderShell } from "./shell";

function readConfig(): DesktopBootstrapConfig {
  return {
    environment: "local",
    stage: (import.meta.env.VITE_RUCORD_STAGE ?? "dev") as DesktopBootstrapConfig["stage"],
    endpoints: {
      httpBaseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8080",
      realtimeUrl: import.meta.env.VITE_REALTIME_URL ?? "ws://127.0.0.1:8090/ws"
    }
  };
}

export function bootstrapDesktopApp(container: HTMLElement): void {
  const config = readConfig();
  const settingsStore = new SettingsStore();
  const httpClient = new HttpClient(config.endpoints.httpBaseUrl);
  const realtimeClient = new RealtimeClient(config.endpoints.realtimeUrl);
  const mediaManager = new MediaManager();
  const controller = new AppController({
    config,
    settingsStore,
    httpClient,
    realtimeClient,
    mediaManager
  });

  renderShell(container, controller.getViewModel());
}
