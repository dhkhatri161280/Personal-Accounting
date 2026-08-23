// ISO YYYY-MM-DD -> DD-MM-YYYY, the display convention used throughout this app. Centralized
// here since the same 3-line function had been separately duplicated in EquityReport.tsx and
// TaxReport.tsx (and several other screens were displaying the raw ISO string with no
// conversion at all -- see the fix that introduced this file).
export function fmtDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}
