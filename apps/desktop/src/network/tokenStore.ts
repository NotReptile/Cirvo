import type { AuthTokens } from "./httpClient";

export const LEGACY_TOKEN_KEY = "rucord:tokens";

export interface TokenStore {
  read(): AuthTokens | null;
  write(tokens: AuthTokens | null): void | Promise<void>;
}

export function parseTokens(raw: string | null): AuthTokens | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AuthTokens>;
    return [value.accessToken, value.accessExpiresAt, value.refreshToken, value.sessionId]
      .every(v => typeof v === "string" && v.length > 0) ? value as AuthTokens : null;
  } catch { return null; }
}

export function browserTokenStore(key = LEGACY_TOKEN_KEY): TokenStore {
  return {
    read() { try { return parseTokens(localStorage.getItem(key)); } catch { return null; } },
    write(tokens) {
      if (tokens) localStorage.setItem(key, JSON.stringify(tokens));
      else localStorage.removeItem(key);
    }
  };
}
