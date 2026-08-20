import type { Ledger, Tx } from "@/lib/vault-types";

export type FxRates = Record<string, number>;

export interface GrTx {
  guid: string;
  date: string;
  type: string;
  number: string;
  narration: string;
  cancelled?: boolean;
  source: "US" | "IN";
  originalCurrency: "USD" | "INR";
  amountUsd: number;
  amountInr: number;
  appliedRate: number;
  entries: Array<{ accountName: string; amountInr: number; originalAmount: number }>;
}

export interface GrAccount {
  name: string;
  parent: string;
  sources: ("US" | "IN")[];
  inOpeningInr: number;
  inDebitInr: number;
  inCreditInr: number;
  inClosingInr: number;
  usOpeningUsd: number;
  usClosingUsd: number;
  usOpeningInr: number;
  usDebitInr: number;
  usCreditInr: number;
  usClosingInr: number;
  openingInr: number;
  debitInr: number;
  creditInr: number;
  closingInr: number;
}

export interface GrLedger {
  accounts: GrAccount[];
  transactions: GrTx[];
  fxRates: FxRates;
  missingRateMonths: string[];
  latestRate: number;
}

export function prevMonthKey(txDate: string): string {
  const y = Number(txDate.slice(0, 4)),
    m = Number(txDate.slice(5, 7));
  const pm = m === 1 ? 12 : m - 1,
    py = m === 1 ? y - 1 : y;
  return `${py}-${String(pm).padStart(2, "0")}`;
}

export function getApplicableRate(fxRates: FxRates, txDate: string): number {
  const key = prevMonthKey(txDate);
  if (fxRates[key] != null) return fxRates[key];
  const earlier = Object.keys(fxRates)
    .filter((k) => k <= key)
    .sort()
    .reverse();
  if (earlier.length) return fxRates[earlier[0]];
  const all = Object.keys(fxRates).sort().reverse();
  return all.length ? fxRates[all[0]] : 84;
}

export function neededRateMonths(usTxns: Tx[]): string[] {
  const months = new Set<string>();
  for (const t of usTxns) {
    if (!t.deleted) months.add(prevMonthKey(t.date));
  }
  return Array.from(months).sort();
}

export function consolidateLedger(
  usData: Ledger,
  indiaData: Ledger,
  fxRates: FxRates
): GrLedger {
  const seenMissing = new Set<string>();
  const missingRateMonths: string[] = [];

  const latestRate =
    Object.entries(fxRates).sort(([a], [b]) => b.localeCompare(a))[0]?.[1] ?? 84;

  // ── Build transactions ───────────────────────────────────────────────────
  const transactions: GrTx[] = [];

  for (const t of indiaData.transactions) {
    if (t.deleted) continue;
    const amtInr = t.entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
    transactions.push({
      guid: `in-${t.guid}`,
      date: t.date,
      type: t.type,
      number: t.number,
      narration: t.narration,
      cancelled: t.cancelled,
      source: "IN",
      originalCurrency: "INR",
      amountUsd: 0,
      amountInr: amtInr,
      appliedRate: 1,
      entries: t.entries.map((e) => ({
        accountName: e.accountName,
        amountInr: e.amount,
        originalAmount: e.amount,
      })),
    });
  }

  for (const t of usData.transactions) {
    if (t.deleted) continue;
    const rk = prevMonthKey(t.date);
    const rate = getApplicableRate(fxRates, t.date);
    if (fxRates[rk] == null && !seenMissing.has(rk)) {
      seenMissing.add(rk);
      missingRateMonths.push(rk);
    }
    const amtUsd = t.entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
    transactions.push({
      guid: `us-${t.guid}`,
      date: t.date,
      type: t.type,
      number: t.number,
      narration: t.narration,
      cancelled: t.cancelled,
      source: "US",
      originalCurrency: "USD",
      amountUsd: amtUsd,
      amountInr: amtUsd * rate,
      appliedRate: rate,
      entries: t.entries.map((e) => ({
        accountName: e.accountName,
        amountInr: e.amount * rate,
        originalAmount: e.amount,
      })),
    });
  }

  transactions.sort((a, b) => b.date.localeCompare(a.date));

  // ── Build accounts ───────────────────────────────────────────────────────
  const accountMap = new Map<string, GrAccount>();
  const normKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

  const getAcc = (name: string, parent: string): GrAccount => {
    const k = normKey(name);
    if (!accountMap.has(k)) {
      accountMap.set(k, {
        name,
        parent: parent || "",
        sources: [],
        inOpeningInr: 0,
        inDebitInr: 0,
        inCreditInr: 0,
        inClosingInr: 0,
        usOpeningUsd: 0,
        usClosingUsd: 0,
        usOpeningInr: 0,
        usDebitInr: 0,
        usCreditInr: 0,
        usClosingInr: 0,
        openingInr: 0,
        debitInr: 0,
        creditInr: 0,
        closingInr: 0,
      });
    }
    return accountMap.get(k)!;
  };

  // IN accounts
  const inDr = new Map<number, number>(),
    inCr = new Map<number, number>();
  for (const t of indiaData.transactions) {
    if (t.deleted || t.cancelled) continue;
    for (const e of t.entries) {
      if (e.amount < 0) inDr.set(e.accountId, (inDr.get(e.accountId) || 0) - e.amount);
      else inCr.set(e.accountId, (inCr.get(e.accountId) || 0) + e.amount);
    }
  }

  for (const acc of indiaData.accounts) {
    const ga = getAcc(acc.name, acc.parent);
    if (!ga.sources.includes("IN")) ga.sources.push("IN");
    const dr = inDr.get(acc.id) || 0,
      cr = inCr.get(acc.id) || 0;
    ga.inOpeningInr = acc.openingBalance;
    ga.inDebitInr = dr;
    ga.inCreditInr = cr;
    ga.inClosingInr = acc.openingBalance - dr + cr;
  }

  // US accounts: convert at per-tx rates, track native totals for closing USD
  const usDrInr = new Map<number, number>(),
    usCrInr = new Map<number, number>(),
    usDrNative = new Map<number, number>(),
    usCrNative = new Map<number, number>();

  for (const t of usData.transactions) {
    if (t.deleted || t.cancelled) continue;
    const rate = getApplicableRate(fxRates, t.date);
    for (const e of t.entries) {
      if (e.amount < 0) {
        usDrInr.set(e.accountId, (usDrInr.get(e.accountId) || 0) + -e.amount * rate);
        usDrNative.set(e.accountId, (usDrNative.get(e.accountId) || 0) - e.amount);
      } else {
        usCrInr.set(e.accountId, (usCrInr.get(e.accountId) || 0) + e.amount * rate);
        usCrNative.set(e.accountId, (usCrNative.get(e.accountId) || 0) + e.amount);
      }
    }
  }

  // FX translation adjustment accumulator.
  // Per-account: usClosingInrHistoric = openingBalance × latestRate - drInr + crInr
  //              usClosingInrFair      = usClosingUsd × latestRate
  // Difference goes to a synthetic Currency Adjustment account so balances stay correct.
  let totalFxAdj = 0;

  for (const acc of usData.accounts) {
    const ga = getAcc(acc.name, acc.parent);
    if (!ga.sources.includes("US")) ga.sources.push("US");
    const drInr = usDrInr.get(acc.id) || 0,
      crInr = usCrInr.get(acc.id) || 0;
    const closingUsd =
      acc.openingBalance -
      (usDrNative.get(acc.id) || 0) +
      (usCrNative.get(acc.id) || 0);

    ga.usOpeningUsd = acc.openingBalance;
    ga.usOpeningInr = acc.openingBalance * latestRate;
    ga.usDebitInr = drInr;
    ga.usCreditInr = crInr;
    ga.usClosingUsd = closingUsd;

    // Historic INR closing (what per-rate conversion gives)
    const historicInr = acc.openingBalance * latestRate - drInr + crInr;
    // Fair-value INR closing (closing USD at current rate — zero if account is zero)
    const fairInr = closingUsd * latestRate;
    // Accumulated FX translation difference
    const fxDiff = historicInr - fairInr;
    totalFxAdj += fxDiff;

    // Use fair-value so zero-USD accounts → zero INR contribution
    ga.usClosingInr = fairInr;
  }

  // Combine account totals
  const accounts: GrAccount[] = [];
  for (const ga of accountMap.values()) {
    ga.openingInr = ga.inOpeningInr + ga.usOpeningInr;
    ga.debitInr = ga.inDebitInr + ga.usDebitInr;
    ga.creditInr = ga.inCreditInr + ga.usCreditInr;
    ga.closingInr = ga.inClosingInr + ga.usClosingInr;
    accounts.push(ga);
  }

  // Add synthetic Currency Adjustment account if the total FX diff is material (> ₹1)
  if (Math.abs(totalFxAdj) > 1) {
    // Find the "US Fund Transfer" account to borrow its parent group,
    // or default to "Reserves & Surplus"
    const usFundKey = normKey("us fund transfer");
    const usFundAcc = accountMap.get(usFundKey);
    const adjParent = usFundAcc?.parent || "Reserves & Surplus";

    accounts.push({
      name: "Currency Adjustment (US/GR)",
      parent: adjParent,
      sources: ["US"],
      inOpeningInr: 0,
      inDebitInr: 0,
      inCreditInr: 0,
      inClosingInr: 0,
      usOpeningUsd: 0,
      usClosingUsd: 0,
      usOpeningInr: 0,
      usDebitInr: 0,
      usCreditInr: 0,
      usClosingInr: totalFxAdj,
      openingInr: 0,
      debitInr: 0,
      creditInr: 0,
      closingInr: totalFxAdj,
    });
  }

  return { accounts, transactions, fxRates, missingRateMonths, latestRate };
}
