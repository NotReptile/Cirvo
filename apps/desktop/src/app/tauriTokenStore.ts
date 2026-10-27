import type { AuthTokens } from "../network/httpClient";
import { browserTokenStore, LEGACY_TOKEN_KEY, parseTokens, type TokenStore } from "../network/tokenStore";
import { getStoredServerUrl } from "./serverConfig";

// Windows tokens are persisted by the native adapter, separately for each server.
// The web client retains its browser fallback; native storage errors never fall back to plaintext.
export async function createTokenStore(serverUrl: string): Promise<TokenStore> {
  const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!native || !navigator.userAgent.includes("Windows")) {
    const store = browserTokenStore(`cirvo:tokens:${serverUrl}`);
    if (!store.read() && getStoredServerUrl() === serverUrl) {
      const legacy = parseTokens(localStorage.getItem(LEGACY_TOKEN_KEY));
      if (legacy) { await store.write(legacy); localStorage.removeItem(LEGACY_TOKEN_KEY); }
    }
    return store;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  let cached = parseTokens(await invoke<string | null>("load_auth_tokens", { serverUrl }));
  const legacy = getStoredServerUrl() === serverUrl ? parseTokens(localStorage.getItem(LEGACY_TOKEN_KEY)) : null;
  if (!cached && legacy) {
    await invoke("save_auth_tokens", { serverUrl, tokens: JSON.stringify(legacy) });
    cached = legacy;
  }
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  return {
    read: () => cached,
    async write(tokens: AuthTokens | null) {
      await invoke("save_auth_tokens", { serverUrl, tokens: tokens ? JSON.stringify(tokens) : null });
      cached = tokens;
    }
  };
}
