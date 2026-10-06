import assert from "node:assert/strict";
import test from "node:test";
import {
  averageMortgageBalanceForYear,
  deductibleMortgageInterest,
  MORTGAGE_ACQUISITION_DEBT_CAP,
  CA_MORTGAGE_ACQUISITION_DEBT_CAP,
} from "../lib/mortgage-amortization.ts";
import type { Account, Tx } from "../lib/vault-types.ts";

// Real evidence this is built against -- the actual 2025 Form 1098 from the lender:
//   Box 1 (interest received)        $23,955.38
//   Box 2 (outstanding principal, Jan 1, 2025)  $842,738.47
//   Box 3 (origination date)         2022-12-28 -- after the 2017-12-15 TCJA cutoff, so the
//                                     newer $750,000 cap applies, not the $1,000,000 grandfather
// The real filed federal Schedule A shows $21,586 deducted (NOT the full $23,955.38) -- the
// $750k cap was already applied somewhere upstream (FreeTaxUSA's own interview, most likely).
// The real Schedule CA (540) shows a $2,369 ADDITION back up to the full $23,955.38 for
// California, which never conformed to the TCJA's reduction and still allows the older $1M cap.

test("deductibleMortgageInterest reproduces the real 2025 federal and CA figures from the Form 1098", () => {
  // IRS Pub 936's simplified average-balance method: total interest / rate, when payments are
  // made at a roughly constant rate throughout the year (true here -- same $3,734.03 P&I payment
  // every period, confirmed in lib/mortgage-amortization.ts's own MORTGAGE_STANDARD_PAYMENT).
  const annualRate = 0.02875;
  const avgBalance2025 = 23_955.38 / annualRate; // ~$833,240 -- above both the $750k federal cap...

  const fed = deductibleMortgageInterest(avgBalance2025, 23_955.38);
  assert.equal(fed.capApplies, true);
  // Real federal Schedule A: $21,586. FreeTaxUSA's own average-balance calc differs slightly
  // from this simplified total-interest/rate approximation, so this checks "close", not exact.
  assert.ok(Math.abs(fed.deductible - 21_586) < 50, `expected close to 21586, got ${fed.deductible}`);

  // ...but under California's un-reduced $1,000,000 cap, the full amount passes through --
  // matching the real Schedule CA (540) exactly (federal $21,586 + $2,369 addition = $23,955.38).
  const ca = deductibleMortgageInterest(avgBalance2025, 23_955.38, CA_MORTGAGE_ACQUISITION_DEBT_CAP);
  assert.equal(ca.capApplies, false);
  assert.equal(ca.deductible, 23_955.38);
});

test("deductibleMortgageInterest applies no reduction when the average balance is under the cap", () => {
  const result = deductibleMortgageInterest(400_000, 15_000);
  assert.equal(result.capApplies, false);
  assert.equal(result.prorationFactor, 1);
  assert.equal(result.deductible, 15_000);
});

function account(id: number, name: string): Account {
  return { id, name, parent: "Loans", category: "Liability", currency: "USD", openingBalance: 0 };
}

function tx(id: number, date: string, entries: { accountId: number; amount: number }[]): Tx {
  return {
    id, guid: `g${id}`, syncStatus: "synced", createdAt: `${date}T00:00:00.000Z`, date,
    number: String(id), type: "Journal", narration: "test", historical: false, cancelled: false,
    entries: entries.map((e) => ({ ...e, accountName: "" })),
  };
}

test("averageMortgageBalanceForYear reads the real CCU Home Loan ledger balance, not a reconstructed anchor", () => {
  const ccu = account(1, "CCU Home Loan");
  const home = account(2, "Home");
  // Liability account "CCU Home Loan" -- Cr increases what's owed (opens at $900,000, i.e. a
  // credit/positive balance in this app's Entry.amount convention), Dr reduces it as principal
  // is paid down. ledgerBalanceAsOf returns -(opening + sum(entries)), so a $900,000 credit-only
  // opening balance (amount: +900000 would be recorded as the account's own openingBalance, not
  // an entry -- simulate via entries dated before the window instead for simplicity).
  const transactions: Tx[] = [
    // Loan funded 2022-12-28: Dr Home / Cr CCU Home Loan $900,000.
    tx(1, "2022-12-28", [{ accountId: home.id, amount: -900_000 }, { accountId: ccu.id, amount: 900_000 }]),
    // A chunk of principal paid down before 2025 starts, landing the loan at $842,738.47 by
    // 2025-01-01 -- matches the real Form 1098 box 2 exactly.
    tx(2, "2024-12-15", [{ accountId: ccu.id, amount: -(900_000 - 842_738.47) }, { accountId: home.id, amount: 900_000 - 842_738.47 }]),
    // Principal paid down during 2025 itself, landing at $823,740.83 by year-end (consistent with
    // the ~$833,240 average-balance figure derived from the real Form 1098 interest/rate above).
    tx(3, "2025-12-15", [{ accountId: ccu.id, amount: -(842_738.47 - 823_740.83) }, { accountId: home.id, amount: 842_738.47 - 823_740.83 }]),
  ];
  const avg = averageMortgageBalanceForYear({ accounts: [ccu, home], transactions }, "2025");
  assert.ok(Math.abs(avg - 833_239.65) < 1, `expected close to 833239.65, got ${avg}`);
});

test("MORTGAGE_ACQUISITION_DEBT_CAP is the TCJA $750k figure, CA_MORTGAGE_ACQUISITION_DEBT_CAP the pre-TCJA $1M figure", () => {
  assert.equal(MORTGAGE_ACQUISITION_DEBT_CAP, 750_000);
  assert.equal(CA_MORTGAGE_ACQUISITION_DEBT_CAP, 1_000_000);
});
