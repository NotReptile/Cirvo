import type { ScreenShareQualityKey } from "../types";

export function loadScreenShareQuality(): ScreenShareQualityKey {
  try {
    const v = localStorage.getItem("rucord:screenShareQuality");
    if (v && ["720p30", "1080p30", "1080p60", "1440p30"].includes(v))
      return v as ScreenShareQualityKey;
  } catch {
    /* ignore */
  }
  return "1080p30";
}

export function loadCollapsedCategories(): Set<string> {
  try {
    const raw = localStorage.getItem("rucord:collapsed-categories");
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(
      Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [],
    );
  } catch {
    return new Set();
  }
}
