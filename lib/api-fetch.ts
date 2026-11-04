"use client";

// Client-side counterpart to lib/api-auth.ts -- attaches the access-token header every
// protected API route now requires. Held in localStorage, not sessionStorage -- confirmed live
// (2026-11) that sessionStorage gets silently wiped on Android when the installed PWA is
// backgrounded (e.g. switching to the Google Drive app to pick a file for upload) and the OS
// reclaims the WebView process to free memory: the app's own React state survives and still
// LOOKS unlocked, but every API call then fails with 401 since the token is gone, with no
// obvious reason why ("parsing works, saving doesn't"). localStorage survives that. This does
// mean the access code persists across a full browser restart on this device -- an accepted
// tradeoff for a personal phone/PWA that already has its own lock screen; still cleared
// explicitly on logout via clearAccessToken.
const TOKEN_KEY = "dk-access-token";
const HEADER = "x-dk-access-token";

export function getAccessToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAccessToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {}
}

export function clearAccessToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
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
