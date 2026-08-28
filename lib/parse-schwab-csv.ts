// Parses the CSV export from Schwab.com's Accounts > History > Export (NOT the Trader API --
// this is the regular web UI export, available regardless of the thinkorswim/API situation, and
// covers full account history rather than just forward from whenever the API starts working).
export interface SchwabCsvRow {
  date: string; // ISO YYYY-MM-DD -- the transaction/posted date (the "as of" settlement date, if
  // present, is dropped; the posted date is what determines which tax year/period a trade or
  // dividend belongs to)
  action: string;
  symbol: string;
  description: string;
  quantity: number | null;
  price: number | null;
  fees: number | null;
  amount: number | null;
}

function parseMoney(s: string): number | null {
  const t = (s || "").trim();
  if (!t) return null;
  const neg = t.startsWith("-") || (t.startsWith("(") && t.endsWith(")"));
  const n = parseFloat(t.replace(/[$,()]/g, ""));
  if (!Number.isFinite(n)) return null;
  return neg ? -Math.abs(n) : Math.abs(n);
}

function parseDate(s: string): string {
  // "08/17/2026 as of 08/15/2026" -> use the first (posted) date.
  const first = s.split(/\s+as of\s+/i)[0].trim();
  const m = first.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return "";
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

// Minimal RFC4180-style CSV line splitter -- handles quoted fields containing commas (every
// field in this export is quoted, including empty ones), which a plain .split(",") would break.
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { fields.push(cur); cur = ""; }
      else cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

export function parseSchwabTransactionsCsv(text: string): SchwabCsvRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const rows: SchwabCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    if (f.length < 8) continue;
    const [dateRaw, action, symbol, description, qty, price, fees, amount] = f;
    const date = parseDate(dateRaw);
    if (!date) continue;
    rows.push({
      date,
      action: action.trim(),
      symbol: symbol.trim(),
      description: description.trim(),
      quantity: qty.trim() ? parseFloat(qty.replace(/,/g, "")) : null,
      price: parseMoney(price),
      fees: parseMoney(fees),
      amount: parseMoney(amount),
    });
  }
  return rows;
}

export interface ClassifiedSchwabRows {
  trades: SchwabCsvRow[]; // Buy / Sell
  // RSU/ESPP shares journaled in from Equity Award Center for safekeeping -- NOT a purchase,
  // no cash changed hands (amount is blank). Real cost basis is the vest FMV in `price`.
  journaledShares: SchwabCsvRow[];
  dividends: SchwabCsvRow[];
  other: SchwabCsvRow[]; // interest, transfers, internal journal relabeling, fees, etc.
}

export function classifySchwabRows(rows: SchwabCsvRow[]): ClassifiedSchwabRows {
  const trades: SchwabCsvRow[] = [];
  const journaledShares: SchwabCsvRow[] = [];
  const dividends: SchwabCsvRow[] = [];
  const other: SchwabCsvRow[] = [];
  for (const r of rows) {
    if (r.action === "Buy" || r.action === "Sell") trades.push(r);
    else if (r.action === "Journaled Shares") journaledShares.push(r);
    else if (/dividend/i.test(r.action)) dividends.push(r);
    else other.push(r);
  }
  return { trades, journaledShares, dividends, other };
}
