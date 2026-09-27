// Cloudflare's version_metadata binding returns `timestamp` as either a numeric epoch-ms value
// or an ISO 8601 string depending on deploy path -- confirmed live: assuming it was always
// numeric (`new Date(Number(value)).toISOString()`) silently produced NaN -> Invalid Date ->
// toISOString() throwing RangeError for every request, 500ing app/api/build-info/route.ts on
// every deploy. Tries it as a date string first (handles ISO), then as a numeric epoch (handles
// a number or a numeric string), and returns null rather than throw on a genuinely malformed
// value -- this only ever feeds a cosmetic "Build xxxxx · date" footer stamp, never worth a 500.
export function parseVersionTimestamp(value: number | string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const asDate = new Date(value);
  if (!isNaN(asDate.getTime())) return asDate.toISOString();
  const asEpoch = new Date(Number(value));
  if (!isNaN(asEpoch.getTime())) return asEpoch.toISOString();
  return null;
}
