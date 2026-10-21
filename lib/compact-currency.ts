/** Short, ~2-decimal abbreviated amount for a label that has to sit directly on a small chart
 * element (e.g. on top of a bar) where the full fmt() string (with grouping and paise/cents)
 * would never fit. INR uses the Indian Lakh/Crore system (K/L/C) to match how the user actually
 * reads these numbers -- a generic K/M/B abbreviation would be technically fine but foreign to
 * someone reading in Lakhs/Crores daily. Any other currency falls back to the Western K/M/B
 * system, both keyed on the same vault `currency` field everything else in the app uses. */
export function compactCurrency(n: number, currency: string): string {
  const symbol = currency === "INR" ? "₹" : currency === "USD" ? "$" : "";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);

  if (currency === "INR") {
    if (abs >= 1e7) return `${sign}${symbol}${(abs / 1e7).toFixed(2)}C`;
    if (abs >= 1e5) return `${sign}${symbol}${(abs / 1e5).toFixed(2)}L`;
    if (abs >= 1e3) return `${sign}${symbol}${(abs / 1e3).toFixed(2)}K`;
    return `${sign}${symbol}${Math.round(abs)}`;
  }
  if (abs >= 1e9) return `${sign}${symbol}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${symbol}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${symbol}${(abs / 1e3).toFixed(2)}K`;
  return `${sign}${symbol}${Math.round(abs)}`;
}
