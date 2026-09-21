"use client";

// Client-side counterpart to lib/api-auth.ts -- attaches the access-token header every
// protected API route now requires. Held in sessionStorage (same lifetime/tradeoff as the vault
// password itself, see VaultApp.tsx's session keys) rather than localStorage, so it doesn't
// silently persist across browser restarts on a shared machine.
const TOKEN_KEY = "dk-access-token";
const HEADER = "x-dk-access-token";

export function getAccessToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAccessToken(token: string) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {}
}

export function clearAccessToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
}

// Drop-in replacement for fetch() against any protected API route -- attaches the access token
// header automatically. Safe to use for every request (protected or not); routes that don't
// require the header simply ignore it.
export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = getAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set(HEADER, token);
  return fetch(input, { ...init, headers });
}
