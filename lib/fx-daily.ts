// Daily-granularity INR-per-USD rate lookup, distinct from lib/gr-consolidation.ts's
// getApplicableRate (which averages to one rate per calendar MONTH via a previous-month
// convention). Used where the literal rate on a transaction's own date is wanted, not a monthly
// approximation -- e.g. translating individual India-book Loans & Advances postings to USD.
export type DailyFxRates = Record<string, number>; // "YYYY-MM-DD" -> INR per 1 USD

// frankfurter.app has no rate for weekends/bank holidays (FX markets are closed), so an exact
// hit is the common case but not guaranteed -- falls back to the nearest EARLIER available date
// (the last real rate that was in effect on the requested date), then the nearest later one, then
// a hardcoded fallback shared with getApplicableRate's own last-resort default.
export function getApplicableDailyRate(rates: DailyFxRates, date: string): number {
  if (rates[date] != null) return rates[date];
  const keys = Object.keys(rates);
  const earlier = keys.filter((d) => d <= date).sort().reverse();
  if (earlier.length) return rates[earlier[0]];
  const later = keys.filter((d) => d > date).sort();
  if (later.length) return rates[later[0]];
  return 84;
}
