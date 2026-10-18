import type { Ledger } from "@/lib/vault-types";
import { fiscalYearOf, accountNature, stripTallyPrimaryMarker } from "@/lib/vault-accounting";
import { todayLocalIso } from "@/lib/format-date";

// Extracted out of components/reports/ReconReport.tsx so the same App-vs-Tally comparison can
// also power components/VaultApp.tsx's "Needs Attention" panel, without a second, divergent
// reimplementation that might not agree with what the report itself shows.

export interface ReconRow {
  name: string;
  parent: string;
  appBalance: number | null;
  tallyBalance: number | null;
  diff: number;
  status: "matched" | "difference" | "app-only" | "tally-only";
}

export const RECON_TOL = 0.005;

// Income/Expense ledgers reset to zero at the start of each fiscal year in Tally (they
// roll into Profit & Loss / Capital rather than carrying their own balance forward), so
// only Balance Sheet accounts (Asset/Liability/Capital/Bank/Cash/Investment) should be
// compared life-to-date. Comparing a P&L ledger's full history against Tally's current-FY
// balance would show a permanent, meaningless "difference" for every P&L account.
function isProfitAndLossNature(nature: string): boolean {
  return nature === "Income" || nature === "Expense";
}

// The synthetic "Profit & Loss A/c" ledger isn't posted to directly — Tally computes it as
// the net Income − Expense movement for the current fiscal year and rolls it into Capital
// at year-end. It must be computed the same way, not treated as a normal Capital-nature
// ledger with a life-to-date opening balance (which would show the deficit/surplus from
// every past year stacked up, not just the current one).
const isProfitAndLossAccountName = (name: string): boolean => /profit\s*&\s*loss|income\s*&\s*expenditure/i.test(name);

export function computeAppBalances(data: Ledger, fyStart: string, fyEnd: string): Map<string, number> {
  const masterGroups = new Map((data.groups || []).map((g) => [g.name.toLowerCase(), g]));
  const natureOf = (a: { parent: string }) => accountNature(a, masterGroups);
  const accountById = new Map(data.accounts.map((a) => [a.id, a]));
  const sums = new Map<number, number>();
  let currentYearPL = 0;
  for (const t of data.transactions) {
    if (t.deleted || t.cancelled) continue;
    const inCurrentFy = t.date >= fyStart && t.date <= fyEnd;
    for (const e of t.entries) {
      const acc = accountById.get(e.accountId);
      if (!acc) continue;
      if (isProfitAndLossNature(natureOf(acc))) {
        if (inCurrentFy) currentYearPL += e.amount;
        if (!inCurrentFy) continue;
      }
      sums.set(e.accountId, (sums.get(e.accountId) || 0) + e.amount);
    }
  }
  const closingFor = (a: Ledger["accounts"][number]) =>
    isProfitAndLossAccountName(a.name)
      ? currentYearPL
      : (isProfitAndLossNature(natureOf(a)) ? 0 : (a.openingBalance || 0)) + (sums.get(a.id) || 0);
  const byName = new Map<string, number>();
  // Two passes so an inactive duplicate ledger can never silently overwrite the active one
  // when two accounts share the same display name.
  for (const a of data.accounts) {
    if (a.active === false) continue;
    byName.set(a.name.trim().toLowerCase(), closingFor(a));
  }
  for (const a of data.accounts) {
    const key = a.name.trim().toLowerCase();
    if (a.active === false && !byName.has(key)) byName.set(key, closingFor(a));
  }
  return byName;
}

export function computeReconRows(data: Ledger): ReconRow[] {
  const snapshot = data.tallyLedgerSnapshot;
  const asOfDate = snapshot ? snapshot.asOf.slice(0, 10) : todayLocalIso();
  const fy = fiscalYearOf(asOfDate);
  const fyStart = `${fy}-04-01`, fyEnd = `${fy + 1}-03-31`;
  const appByName = computeAppBalances(data, fyStart, fyEnd);
  const tallyByName = new Map<string, { parent?: string; closingBalance: number }>();
  for (const b of snapshot?.balances || []) tallyByName.set(b.name.trim().toLowerCase(), b);

  const names = new Set<string>([...appByName.keys(), ...tallyByName.keys()]);
  const accountParent = new Map(data.accounts.map((a) => [a.name.trim().toLowerCase(), a.parent]));

  const out: ReconRow[] = [];
  for (const key of names) {
    const app = appByName.has(key) ? appByName.get(key)! : null;
    const t = tallyByName.get(key);
    const tally = t ? t.closingBalance : null;
    // data.accounts' own parent is already cleaned by backfillGroupParentNames on every vault
    // load, but the Tally snapshot (t?.parent) is untouched raw sync data -- confirmed live
    // showing "&#4; Primary" for "Profit & Loss A/c", a synthetic account with no real app-side
    // parent (so the fallback to the raw snapshot value kicked in) -- stripped here too so
    // EITHER source displays clean, regardless of which one ends up used.
    const parent = accountParent.get(key) || stripTallyPrimaryMarker(t?.parent) || "";
    const displayName = data.accounts.find((a) => a.name.trim().toLowerCase() === key)?.name
      || snapshot?.balances.find((b) => b.name.trim().toLowerCase() === key)?.name
      || key;
    // Status is driven by the actual numeric gap (missing side treated as an implicit 0),
    // not by mere existence -- a ledger that's ₹0 in the app and was never created in Tally
    // has nothing to reconcile, and shouldn't be flagged the same as a real one-sided balance.
    const diff = (app ?? 0) - (tally ?? 0);
    let status: ReconRow["status"];
    if (Math.abs(diff) <= RECON_TOL) status = "matched";
    else if (app === null) status = "tally-only";
    else if (tally === null) status = "app-only";
    else status = "difference";
    out.push({ name: displayName, parent, appBalance: app, tallyBalance: tally, diff, status });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
