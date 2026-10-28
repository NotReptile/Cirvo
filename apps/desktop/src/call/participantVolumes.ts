// Локальные громкости участников голосового канала. Хранятся на этом клиенте
// по userId (не по sessionId: sessionId меняется при каждом входе в канал).
// Два независимых регулятора: голос участника и звук его демонстрации экрана.
// Диапазон 0..2 (0–200%). Значение по умолчанию 1 (100%) — ключ не хранится.

export type VolumeKind = "voice" | "screen";

export const VOLUME_MIN = 0;
export const VOLUME_MAX = 2;
export const VOLUME_DEFAULT = 1;

const STORAGE_KEY = "rucord.participantVolumes.v1";

export interface VolumeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type Entry = Partial<Record<VolumeKind, number>>;

export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return VOLUME_DEFAULT;
  const clamped = Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, value));
  // Шаг 1% — убираем float-шум после деления слайдера на 100.
  return Math.round(clamped * 100) / 100;
}

function parseStored(raw: string | null): Record<string, Entry> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, Entry> = {};
    for (const [userId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry: Entry = {};
      for (const kind of ["voice", "screen"] as const) {
        const v = (value as Record<string, unknown>)[kind];
        if (typeof v === "number" && Number.isFinite(v)) entry[kind] = clampVolume(v);
      }
      if (entry.voice !== undefined || entry.screen !== undefined) out[userId] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

export function createParticipantVolumeStore(storage: VolumeStorage | null) {
  let cache: Record<string, Entry> | null = null;

  const load = (): Record<string, Entry> => {
    if (cache) return cache;
    try {
      cache = parseStored(storage ? storage.getItem(STORAGE_KEY) : null);
    } catch {
      cache = {};
    }
    return cache;
  };

  const save = (): void => {
    if (!storage || !cache) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(cache));
    } catch {
      // Заблокированное хранилище: громкость живёт до перезагрузки.
    }
  };

  return {
    get(userId: string, kind: VolumeKind): number {
      return load()[userId]?.[kind] ?? VOLUME_DEFAULT;
    },
    set(userId: string, kind: VolumeKind, value: number): void {
      const data = load();
      const clamped = clampVolume(value);
      const entry: Entry = { ...(data[userId] ?? {}) };
      if (clamped === VOLUME_DEFAULT) delete entry[kind];
      else entry[kind] = clamped;
      if (entry.voice === undefined && entry.screen === undefined) delete data[userId];
      else data[userId] = entry;
      save();
    },
    reset(userId: string): void {
      const data = load();
      if (!(userId in data)) return;
      delete data[userId];
      save();
    },
  };
}

function defaultStorage(): VolumeStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export const participantVolumes = createParticipantVolumeStore(defaultStorage());
