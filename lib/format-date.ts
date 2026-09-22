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

// Yesterday as YYYY-MM-DD in the caller's local timezone -- same local-vs-UTC reasoning as
// todayLocalIso above. Used as the default date for the Dashboard's Daily Spend card (see
// components/DailySpendCard.tsx), since "how much did I spend yesterday" is the common case
// (today's postings are often still incomplete when someone checks in the morning).
// True once `todayIso` is more than `months` past `dateIso` -- e.g. flagging a Social Security
// estimate (see components/reports/RetirementReport.tsx) whose statement date is over 13 months
// old, since SSA issues a fresh annual statement roughly once a year. Generic date-add-and-compare,
// not tied to any one caller's business rule.
export function isOlderThanMonths(dateIso: string, months: number, todayIso: string): boolean {
  const m = dateIso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return false;
  const cutoff = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  cutoff.setUTCMonth(cutoff.getUTCMonth() + months);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  return todayIso > cutoffIso;
}

export function yesterdayLocalIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "5 min ago" / "3 hr ago" / "2 days ago" from a full ISO timestamp (not just a date) -- used for
// the Tally sync lock's "last synced" label and the Needs Attention "sync hasn't reported in a
// while" check, both of which care about minutes/hours, not just calendar days.
export function timeAgoLabel(isoTimestamp: string, nowMs: number = Date.now()): string {
  const then = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(then)) return "";
  const minutes = Math.max(0, Math.round((nowMs - then) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
