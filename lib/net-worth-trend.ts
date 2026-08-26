import type { Account, Tx } from "./vault-types";
import type { GrAccount, GrTx } from "./gr-consolidation";

export interface NetWorthPoint {
  label: string;
  assets: number;
  liabilities: number;
  netWorth: number;
}

function fyLabel(fy: number): string {
  return `FY${String(fy).slice(-2)}-${String(fy + 1).slice(-2)}`;
}

function fyOf(date: string): number {
  const y = Number(date.slice(0, 4)),
    m = Number(date.slice(5, 7));
  return m >= 4 ? y : y - 1;
}

function classifyNature(parent: string, groups: Map<string, string>): string {
  const group = (parent || "").toLowerCase();
  const configured = groups.get(group);
  if (group.includes("(asset)")) return "Asset";
  if (configured) return configured;
  if (/^(direct incomes|indirect incomes|sales accounts)$/.test(group)) return "Income";
  if (/^(direct expenses|indirect expenses|purchase accounts)$/.test(group)) return "Expense";
  if (/^(capital account|reserves & surplus)$/.test(group)) return "Capital";
  if (
    /^(current liabilities|loans \(liability\)|bank od a\/c|secured loans|unsecured loans|duties & taxes|provisions|sundry creditors)$/.test(
      group
    )
  )
    return "Liability";
  if (group === "bank accounts") return "Bank";
  if (group === "cash-in-hand") return "Cash";
  if (group === "investments") return "Investment";
  return "Asset";
}

/** Net worth over time for a Tally-style ledger (US/India books) -- one snapshot per fiscal
 * year-end present in the transaction history, using ALL transactions regardless of whatever
 * period the rest of the report is currently scoped to (net worth is a full-history view).
 * "Liabilities" here means real debt only (loans, credit cards, sundry creditors) -- Capital
 * Account/Reserves & Surplus are deliberately excluded since they represent accumulated net worth
 * itself, not money owed to someone else; including them would double-count against the assets
 * they were used to build. */
export function computeNetWorthTrend(
  accounts: Account[],
  transactions: Tx[],
  groups: { name: string; nature: string }[]
): NetWorthPoint[] {
  const groupMap = new Map(groups.map((g) => [g.name.toLowerCase(), g.nature]));
  const isProfitLoss = (name: string) => /profit\s*&\s*loss|income\s*&\s*expenditure/i.test(name);
  const natureFor = (parent: string) => classifyNature(parent, groupMap);
  const isAsset = (a: Account) =>
    !isProfitLoss(a.name) && ["Asset", "Bank", "Cash", "Investment"].includes(natureFor(a.parent || ""));
  const isRealLiability = (a: Account) => !isProfitLoss(a.name) && natureFor(a.parent || "") === "Liability";

  const active = transactions
    .filter((t) => !t.deleted && !t.cancelled)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const fyEnds = [...new Set(active.map((t) => fyOf(t.date)))].sort((a, b) => a - b);
  if (fyEnds.length === 0) return [];

  const running = new Map<number, number>(accounts.map((a) => [a.id, a.openingBalance]));
  let idx = 0;
  const points: NetWorthPoint[] = [];
  for (const fy of fyEnds) {
    const end = `${fy + 1}-03-31`;
    while (idx < active.length && active[idx].date <= end) {
      for (const e of active[idx].entries) running.set(e.accountId, (running.get(e.accountId) || 0) + e.amount);
      idx++;
    }
    let assets = 0,
      liabilities = 0;
    for (const a of accounts) {
      const bal = running.get(a.id) || 0;
      if (Math.abs(bal) <= 0.005) continue;
      if (isAsset(a)) assets += -bal;
      else if (isRealLiability(a)) liabilities += bal;
    }
    points.push({ label: fyLabel(fy), assets, liabilities, netWorth: assets - liabilities });
  }
  return points;
}

/** Same idea for the GR consolidated (US+India, INR) book -- walks GrTx history (already
 * FX-converted per-transaction at the rate applicable on that transaction's date) instead of two
 * separate Tally ledgers. Seeds each account from its consolidated openingInr, so the final point
 * will drift slightly from the live closingInr total (which also folds in a today's-rate FX
 * fair-value adjustment) -- fine for a trend line, not meant to reconcile to the penny. */
export function computeGrNetWorthTrend(
  accounts: GrAccount[],
  transactions: GrTx[],
  grNature: (parent: string) => string
): NetWorthPoint[] {
  const isAsset = (a: GrAccount) => ["Asset", "Bank", "Cash"].includes(grNature(a.parent));
  const isRealLiability = (a: GrAccount) => grNature(a.parent) === "Liability";
  const normKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

  const active = transactions
    .filter((t) => !t.cancelled)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const fyEnds = [...new Set(active.map((t) => fyOf(t.date)))].sort((a, b) => a - b);
  if (fyEnds.length === 0) return [];

  const byName = new Map(accounts.map((a) => [normKey(a.name), a]));
  const running = new Map<string, number>(accounts.map((a) => [normKey(a.name), a.openingInr]));
  let idx = 0;
  const points: NetWorthPoint[] = [];
  for (const fy of fyEnds) {
    const end = `${fy + 1}-03-31`;
    while (idx < active.length && active[idx].date <= end) {
      for (const e of active[idx].entries) {
        const k = normKey(e.accountName);
        running.set(k, (running.get(k) || 0) + e.amountInr);
      }
      idx++;
    }
    let assets = 0,
      liabilities = 0;
    for (const [k, bal] of running) {
      if (Math.abs(bal) <= 0.005) continue;
      const acc = byName.get(k);
      if (!acc) continue;
      if (isAsset(acc)) assets += -bal;
      else if (isRealLiability(acc)) liabilities += bal;
    }
    points.push({ label: fyLabel(fy), assets, liabilities, netWorth: assets - liabilities });
  }
  return points;
}
