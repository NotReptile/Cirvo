import type { DesktopBootstrapConfig } from "@rucord/shared-ts";
import type { SettingsStore } from "../local-cache/settingsStore";
import type { MediaManager } from "../media/mediaManager";
import type { HttpClient } from "../network/httpClient";
import type { RealtimeClient } from "../realtime/realtimeClient";

interface Dependencies {
  config: DesktopBootstrapConfig;
  settingsStore: SettingsStore;
  httpClient: HttpClient;
  realtimeClient: RealtimeClient;
  mediaManager: MediaManager;
}

export interface DesktopViewModel {
  environmentLabel: string;
  description: string;
  capabilities: string[];
}

export class AppController {
  constructor(private readonly deps: Dependencies) {}

  getViewModel(): DesktopViewModel {
    const settings = this.deps.settingsStore.getSnapshot();

    return {
      environmentLabel: `Профиль: ${this.deps.config.environment}, стадия: ${this.deps.config.stage}`,
      description: `HTTP ${this.deps.httpClient.baseUrl}, realtime ${this.deps.realtimeClient.endpoint}, медиа ${this.deps.mediaManager.mode}, тема ${settings.theme}.`,
      capabilities: [
        "UI слой отделён от application логики.",
        "Network и realtime оформлены как отдельные адаптеры.",
        "Media слой изолирован для будущего WebRTC и screen share.",
        "Local cache готов для настроек и клиентского состояния."
      ]
    };
  }
}
