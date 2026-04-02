interface SettingsSnapshot {
  theme: "dark";
}

export class SettingsStore {
  getSnapshot(): SettingsSnapshot {
    return {
      theme: "dark"
    };
  }
}
