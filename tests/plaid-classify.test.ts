import assert from "node:assert/strict";
import test from "node:test";
import { isCcAcct, isBankAcct, enforceContraType } from "../lib/plaid-classify.ts";

const BOFA = { id: 1, name: "Bank Of America", parent: "Bank Accounts" };
const CITI_CARD = { id: 2, name: "Citi Credit Card", parent: "Credit Card" };
const HOME = { id: 3, name: "Home", parent: "Fixed Assets" };
const accounts = [BOFA, CITI_CARD, HOME];

test("isCcAcct requires the literal words 'credit card'", () => {
  assert.equal(isCcAcct(CITI_CARD), true);
  assert.equal(isCcAcct({ name: "Credit Union of America" }), false);
  assert.equal(isCcAcct({ name: "Income Credit" }), false);
});

test("isBankAcct matches known bank patterns and excludes expense/income names", () => {
  assert.equal(isBankAcct(BOFA), true);
  assert.equal(isBankAcct({ name: "Bank Charges Expense" }), false);
  assert.equal(isBankAcct({ name: "Salary Income" }), false);
});

test("enforceContraType promotes a bank<->card payment to Contra with a clean narration when the raw text is unhelpful", () => {
  const result = enforceContraType(
    {
      voucherType: "Payment",
      narration: "Ch. No. :",
      entries: [
        { accountId: BOFA.id, accountName: BOFA.name },
        { accountId: CITI_CARD.id, accountName: CITI_CARD.name },
      ],
    },
    accounts
  );
  assert.equal(result.voucherType, "Contra");
  assert.equal(result.narration, "Citi Credit Card Payment");
});

test("enforceContraType leaves an already-descriptive payment narration alone", () => {
  const result = enforceContraType(
    {
      voucherType: "Payment",
      narration: "BofA Credit Card Payment",
      entries: [
        { accountId: BOFA.id, accountName: BOFA.name },
        { accountId: CITI_CARD.id, accountName: CITI_CARD.name },
      ],
    },
    accounts
  );
  assert.equal(result.voucherType, "Contra");
  assert.equal(result.narration, "BofA Credit Card Payment");
});

test("enforceContraType does not touch a voucher with a non-financial (expense) entry", () => {
  const result = enforceContraType(
    {
      voucherType: "Payment",
      narration: "Grocery run",
      entries: [
        { accountId: HOME.id, accountName: HOME.name },
        { accountId: BOFA.id, accountName: BOFA.name },
      ],
    },
    accounts
  );
  // HOME is neither a bank nor a credit-card account by these rules, so it stays a Payment.
  assert.equal(result.voucherType, "Payment");
});
