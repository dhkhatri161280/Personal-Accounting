import assert from "node:assert/strict";
import test from "node:test";
import {
  MORTGAGE_ANCHOR,
  MORTGAGE_ANNUAL_RATE,
  MORTGAGE_STANDARD_PAYMENT,
  currentMortgageBalance,
  computeMortgagePaymentSplit,
} from "../lib/mortgage-amortization.ts";
import type { Ledger } from "../lib/vault-types.ts";

function baseLedger(overrides: Partial<Ledger> = {}): Ledger {
  return {
    currency: "USD",
    accounts: [{ id: 1, name: "Home", parent: "Fixed Assets", category: "Asset", currency: "USD", openingBalance: 0 }],
    transactions: [],
    ...overrides,
  } as Ledger;
}

test("computeMortgagePaymentSplit reproduces the confirmed real payment amount", () => {
  const ledger = baseLedger();
  const { principal, interest, totalPayment } = computeMortgagePaymentSplit(ledger, MORTGAGE_ANCHOR.asOfDate);
  assert.equal(totalPayment, MORTGAGE_STANDARD_PAYMENT);
  // Confirmed against the real loan: $900k / 2.875% / 30yr rounds to exactly $3,734.03/mo.
  assert.ok(Math.abs(principal + interest - MORTGAGE_STANDARD_PAYMENT) < 0.001);
});

test("principal + interest always sums to the standard payment (never drifts off-balance)", () => {
  const ledger = baseLedger();
  for (const date of ["2026-09-04", "2026-10-04", "2027-01-04", "2027-06-04"]) {
    const { principal, interest, totalPayment } = computeMortgagePaymentSplit(ledger, date);
    assert.equal(Math.round((principal + interest) * 100) / 100, totalPayment);
  }
});

test("currentMortgageBalance self-corrects from postings to the Home account since the anchor", () => {
  const ledger = baseLedger({
    transactions: [
      {
        id: 1,
        guid: "v1",
        date: "2026-09-10",
        number: "1",
        type: "Payment",
        narration: "Extra principal payment",
        historical: false,
        entries: [
          { accountId: 1, accountName: "Home", amount: -20000 }, // Dr Home = principal reduction
          { accountId: 2, accountName: "Bank Of America", amount: 20000 },
        ],
      },
    ],
  });
  const balance = currentMortgageBalance(ledger, "2026-10-04");
  assert.equal(balance, MORTGAGE_ANCHOR.balance - 20000);
});

test("currentMortgageBalance ignores postings before the anchor date and cancelled/deleted vouchers", () => {
  const ledger = baseLedger({
    transactions: [
      {
        id: 1, guid: "v1", date: "2020-01-01", number: "1", type: "Payment", narration: "old", historical: true,
        entries: [{ accountId: 1, accountName: "Home", amount: -5000 }, { accountId: 2, accountName: "Bank", amount: 5000 }],
      },
      {
        id: 2, guid: "v2", date: "2026-09-10", number: "2", type: "Payment", narration: "cancelled", historical: false, cancelled: true,
        entries: [{ accountId: 1, accountName: "Home", amount: -1000 }, { accountId: 2, accountName: "Bank", amount: 1000 }],
      },
    ],
  });
  const balance = currentMortgageBalance(ledger, "2026-10-04");
  assert.equal(balance, MORTGAGE_ANCHOR.balance);
});

test("interest decreases as the balance amortizes down over successive months", () => {
  const ledger = baseLedger();
  const early = computeMortgagePaymentSplit(ledger, "2026-09-04").interest;
  const laterLedger = baseLedger({
    transactions: [
      {
        id: 1, guid: "v1", date: "2026-09-10", number: "1", type: "Payment", narration: "principal paydown", historical: false,
        entries: [{ accountId: 1, accountName: "Home", amount: -50000 }, { accountId: 2, accountName: "Bank", amount: 50000 }],
      },
    ],
  });
  const later = computeMortgagePaymentSplit(laterLedger, "2026-10-04").interest;
  assert.ok(later < early, `expected interest to decrease after principal paydown: ${later} !< ${early}`);
});

test("rateStale flags true once past the ARM rate-lock cutoff, false before it", () => {
  const ledger = baseLedger();
  assert.equal(computeMortgagePaymentSplit(ledger, "2027-01-01").rateStale, false);
  assert.equal(computeMortgagePaymentSplit(ledger, "2027-12-01").rateStale, true);
});

test("MORTGAGE_ANNUAL_RATE matches the confirmed Closing Disclosure rate", () => {
  assert.equal(MORTGAGE_ANNUAL_RATE, 0.02875);
});
