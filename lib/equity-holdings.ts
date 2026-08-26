import type { RsuGrant, EsppPurchase } from "./vault-types";

export interface PricePoint {
  date: string; // "YYYY-MM-DD"
  close: number;
}

/** Value of equity actually vested and held as of a given date, at that date's closing price --
 * RSU shares held after tax withholding and any sales, plus ESPP shares still held. Only counts
 * RSU tranches that had actually vested by asOfDate (pending/unvested and not-yet-vested
 * tranches excluded), and ESPP purchases made by asOfDate.
 *
 * Caveat: the data model records each tranche's CURRENT remaining share count (sharesHeld), not
 * a history of when a partial sale happened -- there's no sale date to reconstruct "shares held
 * exactly as of a past date" with certainty. This uses today's held/sold split as if it applied
 * throughout, which is exact for tranches that were never partially sold (the common case) and
 * an approximation for ones that were -- the best available without recording sale dates. */
export function computeHeldEquityValueAsOf(
  grants: RsuGrant[],
  esppPurchases: EsppPurchase[],
  asOfDate: string,
  priceOnDate: number
): { rsuValue: number; esppValue: number; totalValue: number } {
  if (!priceOnDate || priceOnDate <= 0) return { rsuValue: 0, esppValue: 0, totalValue: 0 };
  const rsuValue = grants.reduce(
    (s, g) =>
      s +
      g.vests
        .filter((v) => !v.pending && v.vestDate <= asOfDate)
        .reduce((vs, v) => vs + v.sharesHeld * priceOnDate, 0),
    0
  );
  const esppValue = esppPurchases
    .filter((e) => e.purchaseDate <= asOfDate)
    .reduce((s, e) => s + (e.sharesHeld || e.shares) * priceOnDate, 0);
  return { rsuValue, esppValue, totalValue: rsuValue + esppValue };
}

/** Same as computeHeldEquityValueAsOf, valued today at the live price -- the common case (Net
 * Worth's current snapshot). */
export function computeHeldEquityValue(
  grants: RsuGrant[],
  esppPurchases: EsppPurchase[],
  livePrice: number
): { rsuValue: number; esppValue: number; totalValue: number } {
  const today = new Date().toISOString().slice(0, 10);
  return computeHeldEquityValueAsOf(grants, esppPurchases, today, livePrice);
}

/** Closing price on the nearest trading day at or before `date` -- handles weekends/holidays by
 * falling back to the last available close. `history` must be sorted ascending by date. Returns
 * null if there's no data at or before that date (e.g. before the ticker existed). */
export function priceAsOf(history: PricePoint[], date: string): number | null {
  let lo = 0,
    hi = history.length - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].date <= date) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans >= 0 ? history[ans].close : null;
}
