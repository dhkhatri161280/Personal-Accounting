import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithTimeout } from "../lib/fetch-with-timeout.ts";

test("resolves normally when the underlying fetch resolves before the timeout", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
  try {
    const res = await fetchWithTimeout("https://example.com", { method: "GET" }, 1000);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("aborts and rejects once the timeout elapses, instead of hanging forever", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_input: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    })) as typeof fetch;
  try {
    await assert.rejects(() => fetchWithTimeout("https://example.com", { method: "GET" }, 20), /AbortError|aborted/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("passes method/headers/body through to the underlying fetch, plus a signal", async () => {
  const realFetch = globalThis.fetch;
  let seenInit: RequestInit | undefined;
  globalThis.fetch = (async (_input: string, init?: RequestInit) => {
    seenInit = init;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await fetchWithTimeout("https://example.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, 1000);
    assert.equal(seenInit?.method, "POST");
    assert.equal((seenInit?.headers as Record<string, string>)?.["Content-Type"], "application/json");
    assert.equal(seenInit?.body, "{}");
    assert.ok(seenInit?.signal instanceof AbortSignal);
  } finally {
    globalThis.fetch = realFetch;
  }
});
