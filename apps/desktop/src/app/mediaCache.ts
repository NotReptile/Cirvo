export const MEDIA_BLOB_CACHE_MAX = 80;
export const mediaBlobStore = new Map<string, string>();
export const mediaBlobCache = {
  get(key: string): string | undefined {
    const val = mediaBlobStore.get(key);
    if (val !== undefined) {
      mediaBlobStore.delete(key);
      mediaBlobStore.set(key, val);
    }
    return val;
  },
  set(key: string, val: string): void {
    if (mediaBlobStore.has(key)) mediaBlobStore.delete(key);
    mediaBlobStore.set(key, val);
    while (mediaBlobStore.size > MEDIA_BLOB_CACHE_MAX) {
      const oldestKey = mediaBlobStore.keys().next().value;
      if (oldestKey === undefined) break;
      const oldUrl = mediaBlobStore.get(oldestKey);
      mediaBlobStore.delete(oldestKey);
      if (oldUrl) {
        try {
          URL.revokeObjectURL(oldUrl);
        } catch {}
      }
    }
  },
};
export const gifStaticCache = new Map<string, string>();
