// ISO YYYY-MM-DD -> DD-MM-YYYY, the display convention used throughout this app. Centralized
// here since the same 3-line function had been separately duplicated in EquityReport.tsx and
// TaxReport.tsx (and several other screens were displaying the raw ISO string with no
// conversion at all -- see the fix that introduced this file).
export function fmtDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}

// Today as YYYY-MM-DD in the CALLER's local timezone -- `new Date().toISOString().slice(0, 10)`
// (duplicated dozens of times across this app before this fix) is UTC, not local: in the evening
// in a timezone behind UTC (e.g. US Pacific), UTC has already rolled to tomorrow, so any "is this
// due today/already passed" check built on it fires a day early. Confirmed live: an RSU vest
// dated one day ahead of the user's own wall-clock date showed up in Needs Attention. Only for
// client-side code where "local" means the user's own device -- a server-side API route has no
// single user to be local to, so those intentionally keep using UTC.
export function todayLocalIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
