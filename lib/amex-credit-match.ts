// Matches real Amex card transactions (from Plaid, or from Amex's own downloadable statement
// export) against a fixed table of confirmed statement-credit names, to auto-populate
// AmexBenefit.statementCredits WITHOUT scraping americanexpress.com -- see
// tools/amex-benefits/README.md "Credit-matching from transactions" for how these exact names
// were captured and cross-validated against the live (scraped) tracker totals.
//
// Only benefits with a CONFIRMED real name are listed -- Digital Entertainment Credit and the
// Lodging Credit have never actually posted for this card, so their real name is unknown and
// guessing one risks silently missing (or worse, mis-crediting) real money. They stay on the
// existing scrape/manual-reconciliation path until a real example is captured, at which point a
// row just gets added here.
export const AMEX_BENEFIT_CREDIT_NAMES: Record<string, string[]> = {
  "uber-one-credit": ["Platinum Uber One Credit"],
  "200-afc-tracker": ["AMEX Airline Fee Reimbursement"],
  "oura-ring-credit": ["Platinum Oura Ring Credit"],
  "clear-platinum-tracker": ["AMEX CLEAR PLUS CREDIT"],
  "300-lululemon-credit": ["Platinum Lululemon Credit"],
  "400-resy-credit": ["Platinum Resy Credit"],
  "walmart-platinum-tracker": ["Platinum Walmart+ Credit"],
};

export type RawAmexTx = { date: string; name: string; amount: number };
export type StatementCredit = { date: string; amount: number };

// A benefit credit can be clawed back and reissued -- confirmed on real data: the Oura Ring
// Credit's real -$200 credit came with an unrelated -$125.48/+$125.48 pair that nets to zero, and
// the CLEAR+ Credit's only two entries this year (-$209/+$209) net to exactly zero, matching its
// real $0-used status. Pairing is order-independent (confirmed: one real reversal posted BEFORE
// the credit it reversed) and keyed only on same benefit + equal |amount| + opposite sign within
// this window.
const REVERSAL_WINDOW_DAYS = 45;

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86400000;
}

// amount sign convention (matches both Plaid's `amount` field and Amex's own statement export):
// NEGATIVE = a credit/reduces balance, POSITIVE = a charge/increases balance.
//
// Returns ONLY newly-found credits, per benefitId, not already present in `existing` (deduped by
// exact date+amount) -- safe to re-run on overlapping date windows without double-counting. A
// benefitId is only a key in the result when it actually has something new; the caller should
// merge additively (missing key = no change), never treat an absent key as "clear this benefit".
export function matchAmexBenefitCredits(
  transactions: RawAmexTx[],
  existing: Record<string, StatementCredit[]> = {}
): Record<string, StatementCredit[]> {
  const nameToId = new Map<string, string>();
  for (const [benefitId, names] of Object.entries(AMEX_BENEFIT_CREDIT_NAMES))
    for (const name of names) nameToId.set(name.toLowerCase(), benefitId);

  const byBenefit = new Map<string, RawAmexTx[]>();
  for (const t of transactions) {
    const benefitId = nameToId.get((t.name || "").trim().toLowerCase());
    if (!benefitId) continue;
    if (!byBenefit.has(benefitId)) byBenefit.set(benefitId, []);
    byBenefit.get(benefitId)!.push(t);
  }

  const result: Record<string, StatementCredit[]> = {};
  for (const [benefitId, txs] of byBenefit) {
    const cancelled = new Set<number>();
    for (let i = 0; i < txs.length; i++) {
      if (cancelled.has(i)) continue;
      for (let j = i + 1; j < txs.length; j++) {
        if (cancelled.has(j)) continue;
        if (Math.sign(txs[i].amount) === Math.sign(txs[j].amount)) continue;
        if (Math.abs(Math.abs(txs[i].amount) - Math.abs(txs[j].amount)) > 0.001) continue;
        if (daysBetween(txs[i].date, txs[j].date) > REVERSAL_WINDOW_DAYS) continue;
        cancelled.add(i);
        cancelled.add(j);
        break;
      }
    }

    const existingSet = new Set((existing[benefitId] ?? []).map((c) => `${c.date}|${c.amount}`));
    const newCredits: StatementCredit[] = [];
    txs.forEach((t, i) => {
      if (cancelled.has(i)) return;
      if (t.amount >= 0) return; // an un-reversed charge against a benefit-credit name shouldn't happen; ignore defensively
      const amount = Math.round(-t.amount * 100) / 100;
      const key = `${t.date}|${amount}`;
      if (existingSet.has(key)) return;
      newCredits.push({ date: t.date, amount });
    });
    if (newCredits.length)
      result[benefitId] = [...(existing[benefitId] ?? []), ...newCredits].sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  return result;
}
