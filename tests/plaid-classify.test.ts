import assert from "node:assert/strict";
import test from "node:test";
import { isCcAcct, isBankAcct, enforceContraType, inferReversalVoucherType } from "../lib/plaid-classify.ts";

const BOFA = { id: 1, name: "Bank Of America", parent: "Bank Accounts" };
const CITI_CARD = { id: 2, name: "Citi Credit Card", parent: "Credit Card" };
const HOME = { id: 3, name: "Home", parent: "Fixed Assets" };
const AMEX = { id: 4, name: "AMEX Credit Card", parent: "Credit Card" };
const HOUSEHOLD = { id: 5, name: "House Hold Exps - Aug 26", parent: "Indirect Expenses" };
const accounts = [BOFA, CITI_CARD, HOME, AMEX, HOUSEHOLD];

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

test("inferReversalVoucherType flips a Payment's reversal to a Receipt (financial account lands on the Dr side)", () => {
  // Original Payment: Dr House Hold Exps(-11.06) / Cr AMEX(+11.06). Reversed entries (sides
  // flipped): Dr AMEX(-11.06) / Cr House Hold Exps(+11.06) -- AMEX is now on the Dr side.
  const type = inferReversalVoucherType(
    [
      { accountId: AMEX.id, amount: -11.06 },
      { accountId: HOUSEHOLD.id, amount: 11.06 },
    ],
    accounts
  );
  assert.equal(type, "Receipt");
});

test("inferReversalVoucherType flips a Receipt's reversal to a Payment", () => {
  // Reversed a Receipt (Dr AMEX / Cr HouseHold) -> now Dr HouseHold / Cr AMEX: AMEX on Cr side.
  const type = inferReversalVoucherType(
    [
      { accountId: HOUSEHOLD.id, amount: -20 },
      { accountId: AMEX.id, amount: 20 },
    ],
    accounts
  );
  assert.equal(type, "Payment");
});

test("inferReversalVoucherType keeps a Contra reversal as Contra (both sides still financial)", () => {
  const type = inferReversalVoucherType(
    [
      { accountId: BOFA.id, amount: -235 },
      { accountId: CITI_CARD.id, amount: 235 },
    ],
    accounts
  );
  assert.equal(type, "Contra");
});

test("inferReversalVoucherType keeps a Journal reversal as Journal (no financial account either side)", () => {
  const type = inferReversalVoucherType(
    [
      { accountId: HOME.id, amount: -100 },
      { accountId: HOUSEHOLD.id, amount: 100 },
    ],
    accounts
  );
  assert.equal(type, "Journal");
});
