import assert from "node:assert/strict";
import test from "node:test";
import {
  currentPeriodKey,
  dueTemplates,
  frequencyLabel,
  buildVoucherFromTemplate,
  matchRecurringTemplate,
  isTemplateSatisfiedForPeriod,
  lastPaidDate,
  type RecurringCheckTx,
} from "../lib/recurring.ts";
import type { Account, RecurringTemplate } from "../lib/vault-types.ts";

function template(overrides: Partial<RecurringTemplate> = {}): RecurringTemplate {
  return {
    id: "t1",
    label: "Netflix",
    active: true,
    frequency: "monthly",
    voucherType: "Payment",
    narrationTemplate: "{month} Netflix",
    entries: [
      { accountId: 9, amount: -15.99 },
      { accountId: 1, amount: 15.99 },
    ],
    postings: [],
    ...overrides,
  };
}

test("currentPeriodKey is YYYY-MM for monthly, YYYY for yearly", () => {
  assert.equal(currentPeriodKey(template({ frequency: "monthly" }), "2026-09-15"), "2026-09");
  assert.equal(currentPeriodKey(template({ frequency: "yearly" }), "2026-09-15"), "2026");
});

test("halfyearly is a standard 6-month frequency, not routed through custom", () => {
  const t = template({ frequency: "halfyearly", anchorMonth: "2026-02" });
  assert.equal(frequencyLabel(t), "Every 6 months");
  assert.equal(currentPeriodKey(t, "2026-02-01"), "2026-02");
  assert.equal(currentPeriodKey(t, "2026-07-30"), "2026-02", "still inside the Feb-Jul bucket");
  assert.equal(currentPeriodKey(t, "2026-08-01"), "2026-08", "rolled into the next 6-month bucket");
});

test("currentPeriodKey buckets a quarterly template from its anchorMonth, not an arbitrary offset", () => {
  const t = template({ frequency: "quarterly", anchorMonth: "2026-01" });
  assert.equal(currentPeriodKey(t, "2026-01-05"), "2026-01", "first month of the Jan/Apr/Jul/Oct cycle");
  assert.equal(currentPeriodKey(t, "2026-03-31"), "2026-01", "still inside the Jan-Mar bucket");
  assert.equal(currentPeriodKey(t, "2026-04-01"), "2026-04", "rolled into the next bucket");
  assert.equal(currentPeriodKey(t, "2026-10-15"), "2026-10");
});

test("currentPeriodKey buckets a bimonthly template (every 2 months) from its anchor", () => {
  const t = template({ frequency: "bimonthly", anchorMonth: "2026-02" });
  assert.equal(currentPeriodKey(t, "2026-02-01"), "2026-02");
  assert.equal(currentPeriodKey(t, "2026-03-28"), "2026-02", "still inside the Feb-Mar bucket");
  assert.equal(currentPeriodKey(t, "2026-04-01"), "2026-04");
});

test("currentPeriodKey honors a custom intervalMonths", () => {
  const t = template({ frequency: "custom", intervalMonths: 4, anchorMonth: "2026-01" });
  assert.equal(currentPeriodKey(t, "2026-04-30"), "2026-01");
  assert.equal(currentPeriodKey(t, "2026-05-01"), "2026-05");
});

test("currentPeriodKey falls back to asOfDate's own month as anchor when none is set", () => {
  const t = template({ frequency: "quarterly" });
  assert.equal(currentPeriodKey(t, "2026-06-15"), "2026-06");
});

test("dueTemplates withholds a quarterly template until the LAST month of its bucket, even past dayOfMonth in an earlier month", () => {
  const t = template({ frequency: "quarterly", anchorMonth: "2026-01", dayOfMonth: 1 });
  assert.equal(dueTemplates([t], "2026-02-15").length, 0, "Feb is inside the Jan-Mar bucket, but not its last month");
  assert.equal(dueTemplates([t], "2026-03-01").length, 1, "Mar is the bucket's last month, day 1 >= dayOfMonth 1");
});

test("dueTemplates gates a quarterly template's dayOfMonth within the bucket's last month", () => {
  const t = template({ frequency: "quarterly", anchorMonth: "2026-01", dayOfMonth: 10 });
  assert.equal(dueTemplates([t], "2026-03-05").length, 0, "last month of the bucket, but before the 10th");
  assert.equal(dueTemplates([t], "2026-03-10").length, 1, "last month of the bucket, due day reached");
});

test("dueTemplates is due again once a quarterly template's next bucket starts", () => {
  const t = template({
    frequency: "quarterly",
    anchorMonth: "2026-01",
    postings: [{ periodKey: "2026-01", txGuid: "v1", postedAt: "2026-03-10" }],
  });
  assert.equal(dueTemplates([t], "2026-03-15").length, 0, "already posted for the Jan-Mar bucket");
  assert.equal(dueTemplates([t], "2026-04-01").length, 0, "new Apr-Jun bucket has started, but not yet in its last month");
  assert.equal(dueTemplates([t], "2026-06-01").length, 1, "Jun is the new bucket's last month, not yet posted");
});

test("dueTemplates excludes inactive templates and ones already posted this period", () => {
  const active = template();
  const inactive = template({ id: "t2", active: false });
  const posted = template({ id: "t3", postings: [{ periodKey: "2026-09", txGuid: "v1", postedAt: "2026-09-01" }] });
  const due = dueTemplates([active, inactive, posted], "2026-09-15");
  assert.deepEqual(due.map((d) => d.template.id), ["t1"]);
  assert.equal(due[0].periodKey, "2026-09");
  assert.equal(due[0].periodLabel, "September 2026");
});

test("dueTemplates is due again once a new period starts", () => {
  const t = template({ postings: [{ periodKey: "2026-08", txGuid: "v1", postedAt: "2026-08-01" }] });
  const due = dueTemplates([t], "2026-09-15");
  assert.equal(due.length, 1);
});

test("dueTemplates withholds a MONTHLY template with a dayOfMonth until that day arrives -- not due from the 1st", () => {
  const t = template({ dayOfMonth: 6 });
  assert.equal(dueTemplates([t], "2026-10-01").length, 0, "day 1 -- bill isn't due until the 6th");
  assert.equal(dueTemplates([t], "2026-10-05").length, 0, "day before due -- still not due");
  assert.equal(dueTemplates([t], "2026-10-06").length, 1, "due day itself -- now flagged");
  assert.equal(dueTemplates([t], "2026-10-20").length, 1, "still unposted past the due day -- stays flagged");
});

test("dueTemplates keeps the whole-period behavior for a MONTHLY template with no dayOfMonth set", () => {
  const t = template({ dayOfMonth: undefined });
  assert.equal(dueTemplates([t], "2026-10-01").length, 1);
});

test("dueTemplates does NOT gate a YEARLY template with no anchorMonth -- there's no known due month to anchor a day against", () => {
  const t = template({ frequency: "yearly", dayOfMonth: 20 });
  assert.equal(dueTemplates([t], "2026-01-01").length, 1, "yearly stays due for the whole year, even day 1");
});

test("dueTemplates gates a YEARLY template with an anchorMonth to that due month, not the whole year", () => {
  // A December-due bill (home insurance, say) shouldn't show as "due" starting every January 1st.
  const t = template({ frequency: "yearly", anchorMonth: "2024-12" });
  assert.equal(dueTemplates([t], "2026-01-01").length, 0, "January -- not due yet");
  assert.equal(dueTemplates([t], "2026-06-15").length, 0, "June -- still not due yet");
  assert.equal(dueTemplates([t], "2026-12-01").length, 1, "December -- now due");
});

test("dueTemplates stays due for the rest of the SAME year once a yearly template's due month has passed", () => {
  // A March-due bill, still unposted by June of the same year -- overdue, not forgotten.
  const t = template({ frequency: "yearly", anchorMonth: "2024-03" });
  assert.equal(dueTemplates([t], "2026-06-15").length, 1);
});

test("dueTemplates resets a YEARLY template's due-month gate on the new calendar year, not carried over from last year's miss", () => {
  // currentPeriodKey for yearly is always the CURRENT calendar year -- once the year rolls over,
  // last year's unresolved period is simply no longer "the current period" (same as the
  // pre-existing yearly behavior this builds on); the new year's own cycle hasn't reached its due
  // month yet either, so it correctly goes quiet again until December comes around.
  const t = template({ frequency: "yearly", anchorMonth: "2024-12" });
  assert.equal(dueTemplates([t], "2027-01-15").length, 0);
});

test("dueTemplates gates a YEARLY template's anchorMonth by dayOfMonth too, within that due month", () => {
  const t = template({ frequency: "yearly", anchorMonth: "2024-12", dayOfMonth: 15 });
  assert.equal(dueTemplates([t], "2026-12-10").length, 0, "December, before the 15th");
  assert.equal(dueTemplates([t], "2026-12-15").length, 1, "December, due day reached");
});

test("dueTemplates is quiet once a YEARLY anchored template's due-month period is satisfied by a real transaction", () => {
  const t = template({ frequency: "yearly", anchorMonth: "2024-12" });
  const txs: RecurringCheckTx[] = [{ date: "2026-12-05", entries: [{ accountId: 9, amount: -1050.01 }, { accountId: 1, amount: 1050.01 }] }];
  assert.equal(dueTemplates([t], "2026-12-20", txs).length, 0);
});

test("isTemplateSatisfiedForPeriod is satisfied by ANY matching transaction in the period, regardless of amount -- not a hard posting rule", () => {
  const t = template(); // Netflix: debit 9, credit 1, $15.99 typical
  // A usage-based bill varies cycle to cycle -- a real posted transaction for a wildly different
  // amount still satisfies the period; the amount on the template is only a display default, never
  // enforced.
  const txs: RecurringCheckTx[] = [
    { date: "2026-09-18", entries: [{ accountId: 9, amount: -42.17 }, { accountId: 1, amount: 42.17 }] },
  ];
  assert.equal(isTemplateSatisfiedForPeriod(t, "2026-09", txs), true);
});

test("isTemplateSatisfiedForPeriod is NOT satisfied by a transaction outside the period's date range", () => {
  const t = template();
  const txs: RecurringCheckTx[] = [{ date: "2026-08-30", entries: [{ accountId: 9, amount: -15.99 }, { accountId: 1, amount: 15.99 }] }];
  assert.equal(isTemplateSatisfiedForPeriod(t, "2026-09", txs), false);
});

test("isTemplateSatisfiedForPeriod is NOT satisfied by a transaction through the wrong account pair", () => {
  const t = template();
  const txs: RecurringCheckTx[] = [{ date: "2026-09-10", entries: [{ accountId: 9, amount: -15.99 }, { accountId: 2, amount: 15.99 }] }];
  assert.equal(isTemplateSatisfiedForPeriod(t, "2026-09", txs), false);
});

test("isTemplateSatisfiedForPeriod ignores a deleted or cancelled transaction", () => {
  const t = template();
  const txs: RecurringCheckTx[] = [
    { date: "2026-09-10", deleted: true, entries: [{ accountId: 9, amount: -15.99 }, { accountId: 1, amount: 15.99 }] },
    { date: "2026-09-12", cancelled: true, entries: [{ accountId: 9, amount: -15.99 }, { accountId: 1, amount: 15.99 }] },
  ];
  assert.equal(isTemplateSatisfiedForPeriod(t, "2026-09", txs), false);
});

test("isTemplateSatisfiedForPeriod honors an explicit posting even with no matching transaction passed in", () => {
  const t = template({ postings: [{ periodKey: "2026-09", txGuid: "v1", postedAt: "2026-09-10" }] });
  assert.equal(isTemplateSatisfiedForPeriod(t, "2026-09", []), true);
});

test("lastPaidDate picks the most recent matching transaction's date", () => {
  const t = template();
  const txs: RecurringCheckTx[] = [
    { date: "2026-07-18", entries: [{ accountId: 9, amount: -15.99 }, { accountId: 1, amount: 15.99 }] },
    { date: "2026-08-19", entries: [{ accountId: 9, amount: -17.5 }, { accountId: 1, amount: 17.5 }] },
    { date: "2026-06-20", entries: [{ accountId: 9, amount: -15.99 }, { accountId: 1, amount: 15.99 }] },
  ];
  assert.equal(lastPaidDate(t, txs), "2026-08-19");
});

test("lastPaidDate falls back to the most recent explicit posting when no live transaction is passed", () => {
  const t = template({ postings: [{ periodKey: "2026-07", txGuid: "v1", postedAt: "2026-07-05" }, { periodKey: "2026-08", txGuid: "v2", postedAt: "2026-08-05" }] });
  assert.equal(lastPaidDate(t, []), "2026-08-05");
});

test("lastPaidDate is undefined when there's no sign of the bill ever being paid", () => {
  const t = template();
  assert.equal(lastPaidDate(t, []), undefined);
});

test("isTemplateSatisfiedForPeriod covers a quarterly template's whole 3-month bucket, not just one month", () => {
  const t = template({ frequency: "quarterly", anchorMonth: "2026-01" });
  const txs: RecurringCheckTx[] = [{ date: "2026-02-15", entries: [{ accountId: 9, amount: -500 }, { accountId: 1, amount: 500 }] }];
  assert.equal(isTemplateSatisfiedForPeriod(t, "2026-01", txs), true, "Feb falls inside the Jan-Mar bucket");
});

test("dueTemplates (with transactions) is quiet once a real transaction lands, even though nothing was ever explicitly linked or Posted", () => {
  const t = template({ dayOfMonth: 1 });
  const txs: RecurringCheckTx[] = [{ date: "2026-10-05", entries: [{ accountId: 9, amount: -18.5 }, { accountId: 1, amount: 18.5 }] }];
  assert.equal(dueTemplates([t], "2026-10-20", []).length, 1, "no transactions passed -- still shows as due");
  assert.equal(dueTemplates([t], "2026-10-20", txs).length, 0, "a real, un-linked transaction already covers this period");
});

test("buildVoucherFromTemplate interpolates {month}/{year} and resolves account names", () => {
  const accountById = new Map<number, Account>([
    [9, { id: 9, name: "Subscriptions", parent: "Indirect Expenses", category: "Expense", currency: "USD", openingBalance: 0 }],
    [1, { id: 1, name: "Bank Of America", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0 }],
  ]);
  const built = buildVoucherFromTemplate(template(), "2026-09-15", accountById);
  assert.equal(built.narration, "September Netflix");
  assert.equal(built.voucherType, "Payment");
  assert.deepEqual(built.entries, [
    { accountId: 9, accountName: "Subscriptions", amount: -15.99 },
    { accountId: 1, accountName: "Bank Of America", amount: 15.99 },
  ]);
});

test("buildVoucherFromTemplate redirects a House Hold Exps leg to the posting month's own sibling account, not the stale month saved on the template", () => {
  const accountById = new Map<number, Account>([
    [9, { id: 9, name: "House Hold Exps - Apr 17", parent: "Indirect Expenses", category: "Expense", currency: "USD", openingBalance: 0 }],
    [8, { id: 8, name: "House Hold Exps - Sep 26", parent: "Indirect Expenses", category: "Expense", currency: "USD", openingBalance: 0 }],
    [1, { id: 1, name: "Bank Of America", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0 }],
  ]);
  const built = buildVoucherFromTemplate(template(), "2026-09-15", accountById);
  assert.deepEqual(built.entries, [
    { accountId: 8, accountName: "House Hold Exps - Sep 26", amount: -15.99 },
    { accountId: 1, accountName: "Bank Of America", amount: 15.99 },
  ]);
});

test("buildVoucherFromTemplate leaves a House Hold Exps leg on the saved account when that month's sibling doesn't exist yet", () => {
  const accountById = new Map<number, Account>([
    [9, { id: 9, name: "House Hold Exps - Apr 17", parent: "Indirect Expenses", category: "Expense", currency: "USD", openingBalance: 0 }],
    [1, { id: 1, name: "Bank Of America", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0 }],
  ]);
  const built = buildVoucherFromTemplate(template(), "2026-09-15", accountById);
  assert.deepEqual(built.entries, [
    { accountId: 9, accountName: "House Hold Exps - Apr 17", amount: -15.99 },
    { accountId: 1, accountName: "Bank Of America", amount: 15.99 },
  ]);
});

test("matchRecurringTemplate matches institution + amount within tolerance, ignores templates without plaidMatch", () => {
  const withPlaid = template({ plaidMatch: { institutionPattern: "Bank of America", amountTolerance: 1 } });
  const withoutPlaid = template({ id: "t2" });
  const match = matchRecurringTemplate("Bank of America", 15.5, "2026-09-15", [withoutPlaid, withPlaid]);
  assert.ok(match);
  assert.equal(match!.template.id, "t1");
  assert.equal(match!.periodKey, "2026-09");
});

test("matchRecurringTemplate rejects an amount outside tolerance or a non-matching institution", () => {
  const t = template({ plaidMatch: { institutionPattern: "Bank of America", amountTolerance: 1 } });
  assert.equal(matchRecurringTemplate("Bank of America", 20, "2026-09-15", [t]), null);
  assert.equal(matchRecurringTemplate("Citi", 15.99, "2026-09-15", [t]), null);
});

test("matchRecurringTemplate skips a template already posted for the current period", () => {
  const t = template({
    plaidMatch: { institutionPattern: "Bank of America", amountTolerance: 1 },
    postings: [{ periodKey: "2026-09", txGuid: "v1", postedAt: "2026-09-01" }],
  });
  assert.equal(matchRecurringTemplate("Bank of America", 15.99, "2026-09-15", [t]), null);
});

test("matchRecurringTemplate clamps an unreasonably wide tolerance to the expected amount -- an unrelated near-$0 transaction must never match a real recurring bill", () => {
  // A loose institution-only rule with a huge tolerance (larger than the bill itself) would
  // otherwise match almost anything from that institution, including a transaction with nothing
  // to do with this recurring bill.
  const t = template({ plaidMatch: { institutionPattern: "Bank of America", amountTolerance: 500 } });
  // A $50 grocery charge, clearly not a $15.99 Netflix bill -- would incorrectly match without
  // the clamp (|50 - 15.99| = 34.01 < 500), since the tolerance is now capped to the expected
  // amount itself (min(500, 15.99) = 15.99, and 34.01 > 15.99).
  assert.equal(matchRecurringTemplate("Bank of America", 50, "2026-09-15", [t]), null);
  // A genuinely close amount still matches even with the clamp in effect.
  const match = matchRecurringTemplate("Bank of America", 16.5, "2026-09-15", [t]);
  assert.ok(match);
});

function houseHoldAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 100,
    name: "House Hold Exps - Oct 26",
    parent: "Indirect Expenses",
    category: "Expense",
    currency: "USD",
    openingBalance: 0,
    ...overrides,
  };
}

test("isTemplateSatisfiedForPeriod resolves a House Hold Exps leg to the TRANSACTION's own month sibling, not the template's stale saved month", () => {
  // A yearly subscription template built back in October still has entries pinned to "House
  // Hold Exps - Oct 26" (id 100). A year later the real voucher posts against the fresh "...-
  // Oct 27" sibling (id 101) -- a raw accountId match would never fire again without the redirect.
  const oct26 = houseHoldAccount({ id: 100, name: "House Hold Exps - Oct 26" });
  const oct27 = houseHoldAccount({ id: 101, name: "House Hold Exps - Oct 27" });
  const bofa: Account = { id: 1, name: "Bank Of America", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0 };
  const t = template({
    frequency: "yearly",
    entries: [
      { accountId: 100, amount: -19.99 },
      { accountId: 1, amount: 19.99 },
    ],
  });
  const txs: RecurringCheckTx[] = [
    { date: "2027-10-22", entries: [{ accountId: 101, amount: -19.99 }, { accountId: 1, amount: 19.99 }] },
  ];
  assert.equal(isTemplateSatisfiedForPeriod(t, "2027", txs), false, "without an accounts list, no redirect -- stays unsatisfied (prior behavior)");
  assert.equal(isTemplateSatisfiedForPeriod(t, "2027", txs, [oct26, oct27, bofa]), true, "with accounts passed, resolves to the Oct 27 sibling and matches");
});

test("lastPaidDate also resolves a House Hold Exps leg through the month-sibling redirect", () => {
  const oct26 = houseHoldAccount({ id: 100, name: "House Hold Exps - Oct 26" });
  const nov26 = houseHoldAccount({ id: 102, name: "House Hold Exps - Nov 26" });
  const bofa: Account = { id: 1, name: "Bank Of America", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: 0 };
  const t = template({
    entries: [
      { accountId: 100, amount: -19.99 },
      { accountId: 1, amount: 19.99 },
    ],
  });
  const txs: RecurringCheckTx[] = [
    { date: "2026-11-22", entries: [{ accountId: 102, amount: -19.99 }, { accountId: 1, amount: 19.99 }] },
  ];
  assert.equal(lastPaidDate(t, txs), undefined, "without accounts, the Nov sibling doesn't match the Oct-pinned template");
  assert.equal(lastPaidDate(t, txs, [oct26, nov26, bofa]), "2026-11-22");
});
