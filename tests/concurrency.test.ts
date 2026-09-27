import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "../lib/concurrency.ts";

test("preserves input order regardless of which items finish first", async () => {
  const delays = [30, 10, 20, 5];
  const result = await mapWithConcurrency(delays, 4, (d) => new Promise<number>((r) => setTimeout(() => r(d), d)));
  assert.deepEqual(result, delays);
});

test("never runs more than `limit` items concurrently", async () => {
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  await mapWithConcurrency(items, 3, async (i) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return i;
  });
  assert.ok(maxActive <= 3, `expected at most 3 concurrent, saw ${maxActive}`);
});

test("propagates a thrown error instead of silently dropping it", async () => {
  await assert.rejects(
    () => mapWithConcurrency([1, 2, 3], 2, async (i) => { if (i === 2) throw new Error("boom"); return i; }),
    /boom/
  );
});

test("an empty input returns an empty array without hanging", async () => {
  const result = await mapWithConcurrency([], 3, async (i: number) => i);
  assert.deepEqual(result, []);
});

test("limit larger than the item count still runs everything exactly once", async () => {
  const calls: number[] = [];
  const result = await mapWithConcurrency([1, 2], 10, async (i) => { calls.push(i); return i * 2; });
  assert.deepEqual(result, [2, 4]);
  assert.deepEqual(calls.sort(), [1, 2]);
});
