"use client";
import { useMemo, useState } from "react";
import type { Ledger, Tx } from "@/lib/vault-types";
import { fmtDate, todayLocalIso } from "@/lib/format-date";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";
import { FloatingWindow } from "@/components/FloatingWindow";
import { useUiPrefs } from "@/hooks/useUiPrefs";
import {
  computeCostcoRewardWindow,
  computeCostcoRewardEstimate,
  isQualifyingCostcoNarration,
  costcoQualifyingAmount,
  COSTCO_REWARD_RATE,
  listPastCostcoRewardCycles,
  type CostcoRewardWindow,
} from "@/lib/costco-reward";
import { computeCostcoRewardFromReceipts, costcoPriceMatchWatchlist } from "@/lib/costco-receipts";

// Shared by the current- and previous-cycle drill-downs below -- same per-entry Expense/Income
// netting as the report's own expenseLines/incomeLines (not computeCostcoRewardEstimate's whole-
// voucher sum), scoped to one reward window and only qualifying Costco narration.
function costcoLinesForWindow(
  transactions: Tx[],
  window: CostcoRewardWindow,
  expenseAccountIds: Set<number>,
  incomeAccountIds: Set<number>,
  accountName: Map<number, string>
): SpendLine[] {
  const lines: SpendLine[] = [];
  for (const t of transactions) {
    if (t.deleted || t.cancelled) continue;
    if (t.date < window.start || t.date >= window.end) continue;
    if (!isQualifyingCostcoNarration(t.narration)) continue;
    for (const e of t.entries) {
      const isExpense = expenseAccountIds.has(e.accountId);
      const isIncome = incomeAccountIds.has(e.accountId);
      if (!isExpense && !isIncome) continue;
      const amount = isExpense ? -e.amount : e.amount;
      // Same gift-card backout computeCostcoRewardEstimate applies at the whole-voucher level,
      // here per line -- an ordinary 2-leg Costco voucher's one qualifying entry already equals
      // that voucher's own total, so this agrees with the headline estimate exactly.
      const qualifying = costcoQualifyingAmount(t.narration, Math.abs(amount));
      const rewardAmount = (amount < 0 ? -1 : 1) * qualifying * COSTCO_REWARD_RATE;
      lines.push({
        key: `${t.guid}-${e.accountId}`,
        date: t.date,
        voucherType: t.type,
        voucherNumber: t.number,
        narration: t.narration,
        accountName: accountName.get(e.accountId) ?? "Unknown",
        amount,
        rewardAmount,
      });
    }
  }
  return lines.sort((a, b) => b.date.localeCompare(a.date));
}

export type SpendLine = {
  key: string;
  date: string;
  voucherType: string;
  voucherNumber: string;
  narration: string;
  accountName: string;
  // Signed: positive = spend (Expense section) / earned (Income section); negative = a refund or
  // reversal against that same category -- e.g. a Receipt crediting an Expense ledger (money
  // reimbursed for something already spent) reduces net spend rather than being invisible.
  amount: number;
  // GR-only: which book this line originated from, plus (for a US-sourced line) the original USD
  // amount and FX rate applied -- mirrors the Day Book's own SRC badge + "$X @ rate" hint so GR's
  // Spend Report shows the same conversion detail as every other GR report instead of only the
  // converted INR figure. Left undefined by US/India's own SpendReport (single-currency, no
  // conversion to show).
  source?: "US" | "IN";
  originalAmountUsd?: number;
  appliedRate?: number;
  // Costco Executive 2% Reward drilldowns only (undefined everywhere else -- see
  // costcoLinesForWindow) -- this line's own contribution to the reward estimate, after backing
  // out any Costco Shop Card portion the SAME WAY computeCostcoRewardEstimate does at the
  // whole-cycle level (costcoQualifyingAmount). ONLY Costco's own Shop Card (its house gift-
  // certificate product) is excluded -- a THIRD-PARTY gift card bought at Costco (e.g. "Uber Gift
  // Card - Costco") is a qualifying purchase and earns the full reward, same as any other item in
  // the cart. A Shop Card line (no dollar figure) earns $0 here even though its own `amount` is
  // shown in full, so the two columns together answer "what counted toward the reward" instead of
  // just the raw spend total. Signed the same way `amount` is: a refund's reward is negative
  // (Costco's own terms deduct refunds).
  rewardAmount?: number;
};

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Independent of the header's "Financial period" selector (which is month-granularity only --
// its custom range is built from <input type="month">) -- this report needs its own day-level
// start/end so a user can check an arbitrary window (a weekend trip, a specific week) instead of
// being stuck at whole-month boundaries. Deliberately expense AND income side by side (not just
// expense) so the range shows the full picture -- what came in as well as what went out -- with
// transfers/journals/contras excluded either way since neither is really "spend" or "earn".
export function SpendReport({ data, fmt }: { data: Ledger; fmt: (n: number) => string }) {
  const [startDate, setStartDate] = useState(() => isoDaysAgo(6));
  const [endDate, setEndDate] = useState(todayLocalIso);
  const [showInfo, setShowInfo] = useState(false);
  const [showCostcoInfo, setShowCostcoInfo] = useState(false);
  const [showCostcoDrilldown, setShowCostcoDrilldown] = useState(false);
  const [showPrevCostcoDrilldown, setShowPrevCostcoDrilldown] = useState(false);
  // Index into pastCycles below -- 0 = the cycle immediately before the current one (the default,
  // same as before this became a dropdown), higher = further back.
  const [selectedPastCycleIndex, setSelectedPastCycleIndex] = useState(0);

  // Costco Executive Membership's 2% Reward estimate -- independent of this report's own
  // start/endDate range above (a fixed window Costco itself defines, not a date range the user
  // picks), so only rendered once Masters > Settings has a membership expiration date on file.
  const costcoReward = useMemo(() => {
    if (!data.costcoMembershipRenewalMonthDay) return null;
    const window = computeCostcoRewardWindow(data.costcoMembershipRenewalMonthDay, todayLocalIso());
    const estimate = computeCostcoRewardEstimate(data.transactions, window.start, window.end);
    return { window, estimate };
  }, [data.costcoMembershipRenewalMonthDay, data.transactions]);

  // Every past cycle that actually has qualifying Costco spend -- the dropdown's option list, so
  // it can never land on a meaningless all-zero pre-membership year. Most-recent-first; index 0
  // is the cycle immediately before the current one.
  const pastCycles = useMemo(() => {
    if (!data.costcoMembershipRenewalMonthDay || !costcoReward) return [];
    return listPastCostcoRewardCycles(data.costcoMembershipRenewalMonthDay, costcoReward.window.start, data.transactions);
  }, [data.costcoMembershipRenewalMonthDay, data.transactions, costcoReward]);
  const prevCostcoReward = pastCycles[selectedPastCycleIndex] ?? null;

  // Cross-check against the narration-based estimate above, computed from REAL itemized receipts
  // (Masters -> Costco Receipts) when any are on file -- see lib/costco-receipts.ts's own comment
  // for why this is more exact (receiptType settles Gas Station outright, a Shop Card shows up as
  // its own item line) than guessing either from voucher narration. Deliberately shown ALONGSIDE
  // the narration estimate, not replacing it -- receipt coverage is whatever's been imported so
  // far, never guaranteed complete for the whole cycle, so silently swapping the headline number
  // could understate it the moment coverage is partial.
  const receiptReward = useMemo(() => {
    if (!costcoReward || !data.costcoReceipts?.length) return null;
    return computeCostcoRewardFromReceipts(data.costcoReceipts, costcoReward.window.start, costcoReward.window.end);
  }, [costcoReward, data.costcoReceipts]);

  // Items from real receipts still inside Costco's price-adjustment window (>= 30 days --
  // see costcoPriceMatchWatchlist's own comment on why this is a floor, not an exact cutoff).
  const costcoWatchlist = useMemo(
    () => (data.costcoReceipts?.length ? costcoPriceMatchWatchlist(data.costcoReceipts, todayLocalIso()) : []),
    [data.costcoReceipts]
  );
  const [showWatchlistInfo, setShowWatchlistInfo] = useState(false);

  const expenseAccountIds = useMemo(
    () => new Set(data.accounts.filter((a) => a.category === "Expense").map((a) => a.id)),
    [data.accounts]
  );
  const incomeAccountIds = useMemo(
    () => new Set(data.accounts.filter((a) => a.category === "Income").map((a) => a.id)),
    [data.accounts]
  );
  const accountName = useMemo(() => new Map(data.accounts.map((a) => [a.id, a.name])), [data.accounts]);

  // Drill-down detail behind the Costco card's totals -- same per-entry Expense/Income netting as
  // expenseLines/incomeLines below (not computeCostcoRewardEstimate's own whole-voucher sum),
  // scoped to the reward window instead of startDate/endDate, and to only the qualifying Costco
  // narration. For an ordinary 2-leg Costco voucher (Household Exps vs. the card/bank) these two
  // ways of summing agree exactly; this just lists it at line level so "what adds up to this
  // total" has a real, clickable answer instead of only the headline number.
  const costcoLines = useMemo(
    () => (costcoReward ? costcoLinesForWindow(data.transactions, costcoReward.window, expenseAccountIds, incomeAccountIds, accountName) : []),
    [data.transactions, costcoReward, expenseAccountIds, incomeAccountIds, accountName]
  );
  const costcoLinesTotal = costcoLines.reduce((s, l) => s + l.amount, 0);
  const prevCostcoLines = useMemo(
    () => (prevCostcoReward ? costcoLinesForWindow(data.transactions, prevCostcoReward.window, expenseAccountIds, incomeAccountIds, accountName) : []),
    [data.transactions, prevCostcoReward, expenseAccountIds, incomeAccountIds, accountName]
  );
  const prevCostcoLinesTotal = prevCostcoLines.reduce((s, l) => s + l.amount, 0);

  const { expenseLines, incomeLines } = useMemo(() => {
    const expense: SpendLine[] = [];
    const income: SpendLine[] = [];
    for (const t of data.transactions) {
      if (t.deleted || t.cancelled || t.date < startDate || t.date > endDate) continue;
      for (const e of t.entries) {
        const isExpense = expenseAccountIds.has(e.accountId);
        const isIncome = incomeAccountIds.has(e.accountId);
        if (!isExpense && !isIncome) continue;
        // Expense: debit (negative entry) increases spend -> positive; credit (positive entry,
        // e.g. a reimbursement) reduces it -> negative. Income: credit (positive) increases
        // earned -> positive; debit (negative, e.g. a reversed/bounced payment) reduces it.
        const line: SpendLine = {
          key: `${t.guid}-${e.accountId}`,
          date: t.date,
          voucherType: t.type,
          voucherNumber: t.number,
          narration: t.narration,
          accountName: accountName.get(e.accountId) ?? "Unknown",
          amount: isExpense ? -e.amount : e.amount,
        };
        (isExpense ? expense : income).push(line);
      }
    }
    expense.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
    income.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
    return { expenseLines: expense, incomeLines: income };
  }, [data.transactions, startDate, endDate, expenseAccountIds, incomeAccountIds, accountName]);

  const totalExpense = expenseLines.reduce((s, l) => s + l.amount, 0);
  const totalIncome = incomeLines.reduce((s, l) => s + l.amount, 0);
  const net = totalIncome - totalExpense;

  const byCategory = (lines: SpendLine[]) => {
    const map = new Map<string, number>();
    for (const l of lines) map.set(l.accountName, (map.get(l.accountName) ?? 0) + l.amount);
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  };
  const expenseByCategory = useMemo(() => byCategory(expenseLines), [expenseLines]);
  const incomeByCategory = useMemo(() => byCategory(incomeLines), [incomeLines]);

  // "Last N days" ending today; a single specific day sets both ends to that same date.
  function applyPreset(days: number) {
    setStartDate(isoDaysAgo(days - 1));
    setEndDate(todayLocalIso());
  }
  function applyDay(daysAgo: number) {
    const iso = isoDaysAgo(daysAgo);
    setStartDate(iso);
    setEndDate(iso);
  }
  function applyThisMonth() {
    const d = new Date();
    setStartDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`);
    setEndDate(todayLocalIso());
  }
  // The full previous calendar month (e.g. run on Oct 1 -> Sep 1 to Sep 30), not a rolling 30-day
  // window -- Date's own month/day normalization (negative month wraps to the prior year) handles
  // the January-rollover case for free.
  function applyLastMonth() {
    const iso = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    const now = new Date();
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    setStartDate(iso(lastMonthStart));
    setEndDate(iso(lastMonthEnd));
  }

  return (
    <div className="data-panel">
      <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
        Spend Report
        <span
          className="info-icon-wrap"
          onMouseEnter={() => setShowInfo(true)}
          onMouseLeave={() => setShowInfo(false)}
        >
          <button
            type="button"
            className="info-icon-btn"
            aria-label="How the Spend Report works"
            onClick={() => setShowInfo((v) => !v)}
          >
            ⓘ
          </button>
          {showInfo && (
            <div className="info-icon-popover">
              Postings to Expense and Income category ledgers over any date range you pick -- independent of the
              header's Financial period selector, so you can check an arbitrary window (a trip, a week, a
              month-to-date) at day-level precision. Transfers, contras, and journals are excluded either way. A
              refund or reimbursement against either category (e.g. a Receipt crediting an Expense ledger) reduces
              the total instead of being left out.
            </div>
          )}
        </span>
      </h3>
      <div className="report-line" style={{ marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
          From
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} max={endDate} />
        </label>
        <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
          To
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} min={startDate} />
        </label>
        <button type="button" className="tr-refresh-btn" onClick={() => applyDay(0)}>
          Today
        </button>
        <button type="button" className="tr-refresh-btn" onClick={() => applyDay(1)}>
          Yesterday
        </button>
        <button type="button" className="tr-refresh-btn" onClick={() => applyPreset(7)}>
          Last 7 days
        </button>
        <button type="button" className="tr-refresh-btn" onClick={applyThisMonth}>
          This month
        </button>
        <button type="button" className="tr-refresh-btn" onClick={applyLastMonth}>
          Last Month
        </button>
        <ExportButton
          disabled={expenseLines.length === 0 && incomeLines.length === 0}
          onExport={async () => {
            const header = ["Date", "Voucher Type", "Voucher #", "Account", "Narration", "Amount"];
            const expenseRows = expenseLines.map((l) => [fmtDate(l.date), l.voucherType, l.voucherNumber, l.accountName, l.narration, l.amount]);
            const incomeRows = incomeLines.map((l) => [fmtDate(l.date), l.voucherType, l.voucherNumber, l.accountName, l.narration, l.amount]);
            await exportWorkbook(`Spend Report ${startDate} to ${endDate}.xlsx`, [
              { name: "Expense", rows: [header, ...expenseRows] },
              { name: "Income", rows: [header, ...incomeRows] },
            ]);
          }}
        />
      </div>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", margin: "0 0 16px" }}>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Total Expense</div>
          <div className="spend-total-amt" style={{ fontSize: 22, fontWeight: 700, color: "#dc2626" }}>{fmt(totalExpense)}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Total Income</div>
          <div className="spend-total-amt" style={{ fontSize: 22, fontWeight: 700, color: "#16a34a" }}>{fmt(totalIncome)}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Net</div>
          <div className="spend-total-amt" style={{ fontSize: 22, fontWeight: 700, color: net >= 0 ? "#16a34a" : "#dc2626" }}>{fmt(net)}</div>
        </div>
      </div>

      <SpendSection title="Expense" lines={expenseLines} byCategory={expenseByCategory} total={totalExpense} fmt={fmt} color="#dc2626" emptyLabel="expense" />
      <SpendSection title="Income" lines={incomeLines} byCategory={incomeByCategory} total={totalIncome} fmt={fmt} color="#16a34a" emptyLabel="income" />

      {costcoReward && (
        <>
          {/* Its own fixed Costco-renewal-driven window, not this report's From/To range above --
              kept visually separate (divider + its own heading) at the bottom, not sandwiched
              between the date-range summary and the Expense/Income sections it has nothing to do
              with, so it doesn't read as part of that same date-range-driven flow. */}
          <hr style={{ margin: "24px 0", border: "none", borderTop: "1px solid #e5e7eb" }} />
          <div className="data-panel" style={{ padding: 12 }}>
            <h4 style={{ margin: "0 0 8px", display: "flex", alignItems: "center", gap: 8 }}>
              Costco Executive 2% Reward (estimate)
              <span
                className="info-icon-wrap"
                onMouseEnter={() => setShowCostcoInfo(true)}
                onMouseLeave={() => setShowCostcoInfo(false)}
              >
                <button
                  type="button"
                  className="info-icon-btn"
                  aria-label="How this estimate works"
                  onClick={() => setShowCostcoInfo((v) => !v)}
                >
                  ⓘ
                </button>
                {showCostcoInfo && (
                  <div className="info-icon-popover">
                    Costco calculates the Executive 2% Reward on a window ending ~3 months before your membership's
                    renewal date, not the membership year itself -- confirmed against Costco's own Executive 2% Reward
                    FAQ. Counts Costco household purchases tagged by narration (same pattern the Plaid import itself
                    uses to post them); Costco Gasoline is excluded (Costco's own terms exclude it, and the
                    certificate can't be redeemed at the pump), and a refund against a prior Costco purchase subtracts
                    from the total. Only Costco's own Shop Cards (buying or reloading one) are excluded by Costco's
                    own terms -- a third-party gift card bought at Costco (Uber, Southwest, Instacart, etc.) is a
                    qualifying purchase and earns the full reward. A voucher whose narration mentions "Shop Card"
                    with no dollar figure is assumed to be entirely a Shop Card purchase/reload and dropped from the
                    total; add a dollar figure right after it (e.g. "Costco run -- Shop Card $50") on a bill that
                    mixed regular items with a Shop Card reload, and only that amount is backed out. This is an
                    estimate only -- the real number always comes from Costco's own
                    coupon/certificate once issued. Capped at $1,250.
                  </div>
                )}
              </span>
            </h4>
            <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
              <div>
                <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 8px" }}>
                  Current cycle: {fmtDate(costcoReward.window.start)} – {fmtDate(costcoReward.window.end)}
                </p>
                <button
                  type="button"
                  className="spend-category-chip"
                  style={{ display: "flex", gap: 24, flexWrap: "wrap", width: "auto", textAlign: "left" }}
                  disabled={costcoLines.length === 0}
                  title={costcoLines.length > 0 ? `Click to see the ${costcoLines.length} voucher(s) behind this total` : "No qualifying vouchers in this cycle"}
                  onClick={() => setShowCostcoDrilldown(true)}
                >
                  <span>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Qualifying spend {costcoLines.length > 0 && `(${costcoLines.length} voucher${costcoLines.length !== 1 ? "s" : ""})`}</div>
                    <div className="costco-reward-amt" style={{ fontSize: 20, fontWeight: 700 }}>{fmt(costcoReward.estimate.qualifyingSpend)}</div>
                  </span>
                  <span>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Estimated reward{costcoReward.estimate.capped ? " (capped)" : ""}</div>
                    <div className="costco-reward-amt" style={{ fontSize: 20, fontWeight: 700, color: "#16a34a" }}>{fmt(costcoReward.estimate.estimatedReward)}</div>
                  </span>
                </button>
                {receiptReward && (
                  <p style={{ fontSize: 11, opacity: 0.7, margin: "4px 0 0" }}>
                    Verified from {receiptReward.receiptCount} real receipt{receiptReward.receiptCount !== 1 ? "s" : ""} this cycle
                    (Masters → Costco Receipts): {fmt(receiptReward.qualifyingSpend)} qualifying spend, {fmt(receiptReward.estimatedReward)} reward
                    {Math.abs(receiptReward.estimatedReward - costcoReward.estimate.estimatedReward) > 0.5
                      ? " -- differs from the narration estimate above because not every voucher this cycle has a matching receipt imported yet."
                      : "."}
                  </p>
                )}
                {showCostcoDrilldown && (
                  <FloatingWindow title={<>Costco Executive — <span className="fw-title-amt">{fmt(costcoLinesTotal)}</span></>} onClose={() => setShowCostcoDrilldown(false)} wide>
                    <SpendVoucherTable lines={costcoLines} total={costcoLinesTotal} fmt={fmt} color="#1d4ed8" />
                  </FloatingWindow>
                )}
              </div>

              {pastCycles.length > 0 && (
                <div>
                  <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 8px", display: "flex", alignItems: "center", gap: 6 }}>
                    Cycle
                    <select
                      className="period-select-inline"
                      value={selectedPastCycleIndex}
                      onChange={(e) => setSelectedPastCycleIndex(Number(e.target.value))}
                    >
                      {pastCycles.map((c, i) => (
                        <option key={c.window.start} value={i}>
                          {fmtDate(c.window.start)} – {fmtDate(c.window.end)}
                        </option>
                      ))}
                    </select>
                  </p>
                  {prevCostcoReward && (
                    <>
                      <button
                        type="button"
                        className="spend-category-chip"
                        style={{ display: "flex", gap: 24, flexWrap: "wrap", width: "auto", textAlign: "left" }}
                        disabled={prevCostcoLines.length === 0}
                        title={prevCostcoLines.length > 0 ? `Click to see the ${prevCostcoLines.length} voucher(s) behind this total` : "No qualifying vouchers in this cycle"}
                        onClick={() => setShowPrevCostcoDrilldown(true)}
                      >
                        <span>
                          <div style={{ fontSize: 12, opacity: 0.7 }}>Qualifying spend {prevCostcoLines.length > 0 && `(${prevCostcoLines.length} voucher${prevCostcoLines.length !== 1 ? "s" : ""})`}</div>
                          <div className="costco-reward-amt" style={{ fontSize: 20, fontWeight: 700 }}>{fmt(prevCostcoReward.estimate.qualifyingSpend)}</div>
                        </span>
                        <span>
                          <div style={{ fontSize: 12, opacity: 0.7 }}>Estimated reward{prevCostcoReward.estimate.capped ? " (capped)" : ""}</div>
                          <div className="costco-reward-amt" style={{ fontSize: 20, fontWeight: 700, color: "#16a34a" }}>{fmt(prevCostcoReward.estimate.estimatedReward)}</div>
                        </span>
                      </button>
                      {showPrevCostcoDrilldown && (
                        <FloatingWindow title={<>Costco Executive ({fmtDate(prevCostcoReward.window.start)} – {fmtDate(prevCostcoReward.window.end)}) — <span className="fw-title-amt">{fmt(prevCostcoLinesTotal)}</span></>} onClose={() => setShowPrevCostcoDrilldown(false)} wide>
                          <SpendVoucherTable lines={prevCostcoLines} total={prevCostcoLinesTotal} fmt={fmt} color="#1d4ed8" />
                        </FloatingWindow>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {costcoWatchlist.length > 0 && (
        <>
          <hr style={{ margin: "24px 0", border: "none", borderTop: "1px solid #e5e7eb" }} />
          <div className="data-panel" style={{ padding: 12 }}>
            <h4 style={{ margin: "0 0 8px", display: "flex", alignItems: "center", gap: 8 }}>
              Costco Price Match Watchlist
              <span
                className="info-icon-wrap"
                onMouseEnter={() => setShowWatchlistInfo(true)}
                onMouseLeave={() => setShowWatchlistInfo(false)}
              >
                <button
                  type="button"
                  className="info-icon-btn"
                  aria-label="How this watchlist works"
                  onClick={() => setShowWatchlistInfo((v) => !v)}
                >
                  ⓘ
                </button>
                {showWatchlistInfo && (
                  <div className="info-icon-popover">
                    Every item from an imported Costco receipt (Masters → Costco Receipts) still within
                    Costco's price-adjustment window -- 30 days is used as a conservative floor; some
                    categories (electronics especially) get longer per Costco's own terms, but there's no
                    reliable field in this data to tell those apart, so an item just past 30 days may still
                    be worth checking rather than assuming it's expired. This only tells you WHAT you bought
                    and WHEN the window closes -- checking whether the price actually dropped still has to
                    happen live, on costco.com or in the app, with your own warehouse/location selected.
                  </div>
                )}
              </span>
            </h4>
            <table className="fx-ledger-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Who</th>
                  <th>Item</th>
                  <th className="right">Paid</th>
                  <th className="right">Deadline (at least)</th>
                </tr>
              </thead>
              <tbody>
                {costcoWatchlist.map((w, i) => (
                  <tr key={`${w.itemNumber}-${w.date}-${i}`}>
                    <td>{fmtDate(w.date)}</td>
                    <td>{w.cardholder || "—"}</td>
                    <td className="fx-narration" title={`Item #${w.itemNumber}`}>
                      {w.description}
                    </td>
                    <td className="right">{fmt(w.pricePaid)}</td>
                    <td className="right" style={{ color: w.daysLeft <= 5 ? "#dc2626" : undefined }}>
                      {fmtDate(w.priceAdjustmentDeadlineAtLeast)} ({w.daysLeft}d)
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export function SpendSection({
  title,
  lines,
  byCategory,
  total,
  fmt,
  color,
  emptyLabel,
}: {
  title: string;
  lines: SpendLine[];
  byCategory: [string, number][];
  total: number;
  fmt: (n: number) => string;
  color: string;
  emptyLabel: string;
}) {
  const { privacyMode } = useUiPrefs();
  const [expanded, setExpanded] = useState(false);
  // Which category's card was clicked, if any -- opens a floating drill-down window scoped to
  // just that category's lines, separate from the "Show N vouchers" button above (which still
  // shows the whole section).
  const [drilldown, setDrilldown] = useState<string | null>(null);
  // Largest category in this section sets the 100% reference -- byCategory is already sorted
  // descending, so it's just the first entry. A refund-heavy category with a negative total gets
  // no fill (0%) rather than a visually meaningless negative-width bar.
  const maxAmt = byCategory[0]?.[1] ?? 0;
  const drilldownLines = drilldown ? lines.filter((l) => l.accountName === drilldown) : [];
  const drilldownTotal = drilldown ? drilldownLines.reduce((s, l) => s + l.amount, 0) : 0;
  return (
    <div style={{ marginBottom: 20 }}>
      <h4 style={{ margin: "0 0 6px" }}>{title}</h4>
      {lines.length === 0 ? (
        <p style={{ fontSize: 12, opacity: 0.6 }}>No {emptyLabel} postings in this range.</p>
      ) : (
        <>
          <div className="spend-category-grid">
            {byCategory.map(([name, amt]) => {
              const pct = maxAmt > 0 ? Math.max(0, Math.min(100, (amt / maxAmt) * 100)) : 0;
              return (
                <button
                  type="button"
                  key={name}
                  className="spend-category-chip"
                  title={privacyMode ? `${name} — click for detail` : `${name}: ${fmt(amt)} — click for detail`}
                  onClick={() => setDrilldown(name)}
                >
                  <span className="spend-category-chip-fill" style={{ width: `${pct}%`, background: color }} />
                  <span className="spend-category-chip-text">
                    <b>{name}</b>
                    <em className="spend-category-chip-amt">{fmt(amt)}</em>
                  </span>
                </button>
              );
            })}
          </div>
          <button type="button" className="tr-refresh-btn" onClick={() => setExpanded((v) => !v)} style={{ marginBottom: 8 }}>
            {expanded ? "Hide vouchers" : `Show ${lines.length} voucher${lines.length !== 1 ? "s" : ""}`}
          </button>
          {expanded && <SpendVoucherTable lines={lines} total={total} fmt={fmt} color={color} />}
          {drilldown && (
            <FloatingWindow title={<>{drilldown} — <span className="fw-title-amt">{fmt(drilldownTotal)}</span></>} onClose={() => setDrilldown(null)} wide>
              <SpendVoucherTable lines={drilldownLines} total={drilldownTotal} fmt={fmt} color={color} hideAccountColumn />
            </FloatingWindow>
          )}
        </>
      )}
    </div>
  );
}

// Shared by SpendSection's "Show N vouchers" (whole section) and its per-category drill-down
// popup (see SpendSection above) -- same table, just a different `lines` slice.
function SpendVoucherTable({
  lines,
  total,
  fmt,
  color,
  hideAccountColumn,
}: {
  lines: SpendLine[];
  total: number;
  fmt: (n: number) => string;
  color: string;
  hideAccountColumn?: boolean;
}) {
  const showSource = lines.some((l) => l.source);
  // Only the Costco reward drilldowns populate rewardAmount -- every other SpendVoucherTable
  // caller (the plain Expense/Income category drilldowns) leaves it undefined, so the column is
  // simply absent there instead of showing a meaningless blank/zero.
  const showReward = lines.some((l) => l.rewardAmount != null);
  const totalReward = showReward ? lines.reduce((s, l) => s + (l.rewardAmount ?? 0), 0) : 0;
  return (
    <table className="fx-ledger-table">
      <thead>
        <tr>
          <th>Date</th>
          {showSource && <th>Src</th>}
          <th>Voucher</th>
          {!hideAccountColumn && <th>Account</th>}
          <th className="fx-narration">Narration</th>
          <th className="right">Amount</th>
          {showReward && <th className="right">Reward</th>}
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.key}>
            <td>{fmtDate(l.date)}</td>
            {showSource && (
              <td>
                {l.source && <span className={`source-badge source-${l.source.toLowerCase()}`}>{l.source}</span>}
              </td>
            )}
            <td>
              {l.voucherType} {l.voucherNumber}
            </td>
            {!hideAccountColumn && <td>{l.accountName}</td>}
            <td className="fx-narration" title={l.narration}>
              {l.narration || "—"}
            </td>
            <td className="right" style={l.amount < 0 ? { color: "#6b7280" } : undefined} title={l.amount < 0 ? "Refund / reversal — reduces the total" : undefined}>
              {fmt(l.amount)}
              {l.source === "US" && l.originalAmountUsd != null && l.appliedRate != null && (
                <small className="gr-usd-hint">
                  ${l.originalAmountUsd.toFixed(2)} @ {l.appliedRate.toFixed(2)}
                </small>
              )}
            </td>
            {showReward && (
              <td
                className="right"
                style={{ color: l.rewardAmount ? "#16a34a" : "#9ca3af" }}
                title={l.rewardAmount === 0 ? "Not counted — Costco Shop Card purchases/reloads are excluded from the 2% Reward" : undefined}
              >
                {fmt(l.rewardAmount ?? 0)}
              </td>
            )}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={(hideAccountColumn ? 3 : 4) + (showSource ? 1 : 0)}>Total</td>
          <td className="right" style={{ color }}>
            {fmt(total)}
          </td>
          {showReward && (
            <td className="right" style={{ color: "#16a34a" }}>
              {fmt(totalReward)}
            </td>
          )}
        </tr>
      </tfoot>
    </table>
  );
}
