// Classifies raw activity from Schwab's Trader API (/api/schwab/transactions -- see that route's
// comment for why it exists as a diagnostic pass-through) into buckets a staging UI can act on.
// Mirrors lib/parse-schwab-csv.ts's classifySchwabRows, but for the API's JSON shape instead of
// the web-export CSV's row shape.
export interface SchwabTransferItem {
  instrument?: {
    assetType?: string;
    symbol?: string;
    uniformSymbol?: string;
    instrumentId?: number;
    closingPrice?: number;
    type?: string;
  };
  amount?: number;
  cost?: number;
  price?: number;
}

export interface SchwabActivity {
  activityId: number;
  time: string;
  description?: string;
  accountNumber: string;
  type: string;
  status?: string;
  subAccount?: string;
  tradeDate?: string;
  positionId?: number;
  netAmount: number;
  transferItems: SchwabTransferItem[];
}

// The EQUITY leg is the one that matters for a Trade record -- an activity can carry other legs
// (e.g. a cash leg) alongside it, but only the equity instrument has the symbol/qty/price we need.
export function primaryInstrument(a: SchwabActivity): SchwabTransferItem | undefined {
  return a.transferItems.find((t) => t.instrument?.assetType === "EQUITY") ?? a.transferItems[0];
}

export interface ClassifiedSchwabActivity {
  // Real buy/sell -- cash actually moved (non-zero netAmount).
  trades: SchwabActivity[];
  // type: "TRADE" but netAmount is ~0 and the description reads as an account transfer (e.g.
  // "System transfer") -- shares moved in/out carrying a cost basis, but no purchase happened.
  // Cost-basis-sensitive, so kept as its own bucket that always requires an explicit per-row
  // confirm -- never lumped in with real trades or bulk-confirmable.
  transfersIn: SchwabActivity[];
  dividendsInterest: SchwabActivity[];
  // Unrecognized types (fees, margin activity, journal entries, etc.) -- shown for visibility,
  // not actionable from this screen.
  other: SchwabActivity[];
}

export function classifySchwabActivity(activities: SchwabActivity[]): ClassifiedSchwabActivity {
  const trades: SchwabActivity[] = [];
  const transfersIn: SchwabActivity[] = [];
  const dividendsInterest: SchwabActivity[] = [];
  const other: SchwabActivity[] = [];
  for (const a of activities) {
    if (a.type === "TRADE") {
      const isTransfer = Math.abs(a.netAmount) < 0.005 && /transfer/i.test(a.description || "");
      if (isTransfer) transfersIn.push(a);
      else trades.push(a);
    } else if (a.type === "DIVIDEND_OR_INTEREST" || /dividend|interest/i.test(a.description || "")) {
      dividendsInterest.push(a);
    } else {
      other.push(a);
    }
  }
  return { trades, transfersIn, dividendsInterest, other };
}

// Narration a posted dividend/interest voucher for this activity carries -- shared between the
// posting function and any future "already recorded" check, same convention as
// TradingReport's incomeNarration for CSV rows.
export function activityNarration(a: SchwabActivity): string {
  const inst = primaryInstrument(a);
  const symbol = inst?.instrument?.symbol;
  return symbol ? `${symbol} ${a.description || a.type}` : a.description || a.type;
}
