import assert from "node:assert/strict";
import test from "node:test";
import { backfillDividendNarrations } from "../lib/vault-accounting.ts";

test("backfillDividendNarrations appends the missing keyword to a CURRENCY_USD-narrated credit against an Income account", () => {
  const ledger = {
    accounts: [{ id: 1, name: "Other Income", category: "Income" }, { id: 2, name: "Charles Schwab", category: "Bank" }],
    transactions: [
      {
        id: 1,
        type: "Receipt",
        number: "122",
        date: "2026-10-01",
        narration: "CURRENCY_USD NVIDIA CORP (01-10-2026)",
        entries: [
          { accountId: 2, accountName: "Charles Schwab", amount: -3163.25 },
          { accountId: 1, accountName: "Other Income", amount: 3163.25 },
        ],
      },
    ],
  } as any;
  const result = backfillDividendNarrations(ledger);
  assert.equal(result.transactions[0].narration, "CURRENCY_USD NVIDIA CORP (01-10-2026) Dividend/Interest");
});

test("backfillDividendNarrations leaves a CURRENCY_USD narration alone when it doesn't credit an Income account", () => {
  const ledger = {
    accounts: [{ id: 1, name: "Charles Schwab", category: "Bank" }, { id: 2, name: "Another Bank", category: "Bank" }],
    transactions: [
      {
        id: 1,
        type: "Contra",
        number: "1",
        date: "2026-10-01",
        narration: "CURRENCY_USD transfer (01-10-2026)",
        entries: [
          { accountId: 2, accountName: "Another Bank", amount: -100 },
          { accountId: 1, accountName: "Charles Schwab", amount: 100 },
        ],
      },
    ],
  } as any;
  const result = backfillDividendNarrations(ledger);
  assert.equal(result.transactions[0].narration, "CURRENCY_USD transfer (01-10-2026)");
});

test("backfillDividendNarrations is a no-op (same reference) when nothing needs fixing", () => {
  const ledger = {
    accounts: [{ id: 1, name: "Other Income", category: "Income" }],
    transactions: [
      { id: 1, type: "Receipt", number: "1", date: "2026-10-01", narration: "NVDA Qualified Dividend (01-10-2026)", entries: [{ accountId: 1, accountName: "Other Income", amount: 10 }] },
    ],
  } as any;
  assert.equal(backfillDividendNarrations(ledger), ledger);
});

test("backfillDividendNarrations never double-appends on a second pass", () => {
  const ledger = {
    accounts: [{ id: 1, name: "Other Income", category: "Income" }],
    transactions: [
      {
        id: 1,
        type: "Receipt",
        number: "1",
        date: "2026-10-01",
        narration: "CURRENCY_USD NVIDIA CORP (01-10-2026)",
        entries: [{ accountId: 1, accountName: "Other Income", amount: 10 }],
      },
    ],
  } as any;
  const once = backfillDividendNarrations(ledger);
  const twice = backfillDividendNarrations(once);
  assert.equal(twice, once);
  assert.equal(twice.transactions[0].narration, "CURRENCY_USD NVIDIA CORP (01-10-2026) Dividend/Interest");
});
