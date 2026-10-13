"use client";
import { useEffect, useMemo, useState } from "react";
import type { RsuGrant, EsppPurchase, Trade } from "@/lib/vault-types";
import { apiFetch } from "@/lib/api-fetch";

// Same broker-code labels TradingReport.tsx's own BROKER_LABEL uses -- not exported from there
// (that file wasn't refactored for this), so duplicated here rather than risk a deeper change to
// an already-large component just to share three strings.
const BROKER_LABEL: Record<string, string> = { CST: "Charles Schwab (CST)", CSS: "Charles Schwab (CSS)", RBS: "Robinhood (RBS)" };

const glColor = (n: number) => (n >= 0 ? "#16a34a" : "#dc2626");

// One place combining the three pieces that otherwise only exist on separate report screens:
// NVDA equity compensation (RSU vs. ESPP, split -- unlike Net Worth's single blended line),
// Schwab Trading's open positions, and Schwab's live uninvested cash balance. Deliberately a
// self-contained, lightweight re-computation (its own small live-price fetch for the Trading
// symbols, same /api/equity-price endpoint TradingReport.tsx itself calls) rather than a refactor
// of TradingReport.tsx to share state -- that file is large and already does a lot; duplicating a
// few dozen lines here is lower-risk than threading a new shared hook through it.
export function HoldingsReport({
  grants,
  esppPurchases,
  trades,
  nvdaPrice,
  nvdaPrevClose,
  fmt,
}: {
  grants: RsuGrant[];
  esppPurchases: EsppPurchase[];
  trades: Trade[];
  nvdaPrice: number | null;
  nvdaPrevClose: number | null;
  fmt: (n: number) => string;
}) {
  const [showInfo, setShowInfo] = useState(false);

  // ── NVDA equity compensation, RSU vs. ESPP kept separate ──────────────────────────────────
  // Cost basis: RSU uses the FMV at vest (vestPrice) -- that's the amount already taxed as
  // ordinary income, the real cost basis for a future capital gain/loss on sale. ESPP uses the
  // actual purchasePrice paid. Pending (not-yet-vested/not-yet-purchased) rows are excluded --
  // this is about what's actually HELD today, not what's scheduled.
  const rsuHeldShares = useMemo(
    () => grants.reduce((s, g) => s + g.vests.filter((v) => !v.pending).reduce((vs, v) => vs + v.sharesHeld, 0), 0),
    [grants]
  );
  const rsuCostBasis = useMemo(
    () => grants.reduce((s, g) => s + g.vests.filter((v) => !v.pending).reduce((vs, v) => vs + v.sharesHeld * v.vestPrice, 0), 0),
    [grants]
  );
  const esppHeldShares = useMemo(
    () => esppPurchases.filter((e) => !e.pending).reduce((s, e) => s + e.sharesHeld, 0),
    [esppPurchases]
  );
  const esppCostBasis = useMemo(
    () => esppPurchases.filter((e) => !e.pending).reduce((s, e) => s + e.sharesHeld * e.purchasePrice, 0),
    [esppPurchases]
  );
  const rsuValue = nvdaPrice != null ? rsuHeldShares * nvdaPrice : null;
  const esppValue = nvdaPrice != null ? esppHeldShares * nvdaPrice : null;
  const nvdaCostBasis = rsuCostBasis + esppCostBasis;
  const nvdaTotalValue = rsuValue != null && esppValue != null ? rsuValue + esppValue : null;
  // Daily gain: today's live price vs. yesterday's close, same two figures VaultApp.tsx's own
  // equityDailyGL already uses for the Dashboard's NVDA card -- same formula, applied per source.
  const nvdaDailyDelta = nvdaPrice != null && nvdaPrevClose != null ? nvdaPrice - nvdaPrevClose : null;
  const rsuDailyGL = nvdaDailyDelta != null ? rsuHeldShares * nvdaDailyDelta : null;
  const esppDailyGL = nvdaDailyDelta != null ? esppHeldShares * nvdaDailyDelta : null;

  // ── Schwab Trading open positions ─────────────────────────────────────────────────────────
  const openTrades = useMemo(() => trades.filter((t) => !t.saleDate), [trades]);
  const symbols = useMemo(() => [...new Set(openTrades.map((t) => t.symbol))], [openTrades]);
  const symbolsKey = symbols.join(",");
  const [prices, setPrices] = useState<Record<string, { price: number; prevClose: number | null }>>({});
  useEffect(() => {
    let cancelled = false;
    if (!symbolsKey) return;
    Promise.all(
      symbolsKey.split(",").map((sym) =>
        fetch(`/api/equity-price?ticker=${sym}`)
          .then((r) => r.json())
          .then((d: unknown) => {
            const j = d as { price?: number | null; previousClose?: number | null };
            return {
              sym,
              price: typeof j.price === "number" ? j.price : null,
              prevClose: typeof j.previousClose === "number" ? j.previousClose : null,
            };
          })
          .catch(() => ({ sym, price: null, prevClose: null }))
      )
    ).then((results) => {
      if (cancelled) return;
      const p: Record<string, { price: number; prevClose: number | null }> = {};
      for (const r of results) if (r.price != null) p[r.sym] = { price: r.price, prevClose: r.prevClose };
      setPrices(p);
    });
    return () => { cancelled = true; };
  }, [symbolsKey]);

  const positionRows = openTrades.map((t) => {
    const hasLivePrice = prices[t.symbol] != null;
    // Falls back to the trade's own last-known price (not a blank/zero) when the live fetch
    // hasn't returned yet or failed -- same "stay honest, don't silently vanish" principle as the
    // Schwab cash balance fix, flagged with a visible marker rather than pretending it's live.
    const cur = prices[t.symbol]?.price ?? t.marketOrSalePrice;
    // Same fallback for yesterday's close, and the same per-position daily G/L formula
    // TradingReport.tsx's own vsToday()/dailyGL use (units x (current - previous close)).
    const prevClose = prices[t.symbol]?.prevClose ?? t.yesterday;
    const cost = t.units * t.costPerSh;
    const mv = t.units * cur;
    return { t, cur, cost, mv, gl: mv - cost, dailyGL: t.units * (cur - prevClose), hasLivePrice };
  });
  const tradingTotalCost = positionRows.reduce((s, r) => s + r.cost, 0);
  const tradingTotalValue = positionRows.reduce((s, r) => s + r.mv, 0);
  const tradingTotalGL = tradingTotalValue - tradingTotalCost;
  const tradingTotalDailyGL = positionRows.reduce((s, r) => s + r.dailyGL, 0);

  // ── Schwab live cash balance ──────────────────────────────────────────────────────────────
  // Same fetch + visible-error pattern as TradingReport.tsx/SchwabImport.tsx's own cash balance
  // (see their shared history: a silent .catch(() => {}) used to make this vanish with no
  // indication why -- fixed everywhere this figure appears, including here).
  const [schwabCash, setSchwabCash] = useState<number | null>(null);
  const [schwabCashError, setSchwabCashError] = useState<string | null>(null);
  useEffect(() => {
    apiFetch("/api/schwab/positions")
      .then(async (r) => {
        const d = (await r.json().catch(() => null)) as { accounts?: { cashBalance?: number }[]; error?: string } | null;
        if (!r.ok) { setSchwabCashError(d?.error || `fetch failed (HTTP ${r.status})`); return; }
        const accounts = d?.accounts ?? [];
        if (!accounts.length) { setSchwabCashError("no connected accounts -- check Import → Schwab"); return; }
        setSchwabCash(accounts.reduce((s, a) => s + (a.cashBalance ?? 0), 0));
      })
      .catch((e: unknown) => setSchwabCashError(e instanceof Error ? e.message : "network error"));
  }, []);

  const grandTotalComplete = nvdaTotalValue != null && schwabCash != null;
  const grandTotal = (nvdaTotalValue ?? 0) + tradingTotalValue + (schwabCash ?? 0);
  const totalGL = nvdaTotalValue != null ? nvdaTotalValue - nvdaCostBasis + tradingTotalGL : null;
  const totalDailyGL = rsuDailyGL != null && esppDailyGL != null ? rsuDailyGL + esppDailyGL + tradingTotalDailyGL : null;

  return (
    <div className="data-panel">
      <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
        Holdings — Everything in One Place
        <span
          className="info-icon-wrap"
          onMouseEnter={() => setShowInfo(true)}
          onMouseLeave={() => setShowInfo(false)}
        >
          <button
            type="button"
            className="info-icon-btn"
            aria-label="How this report works"
            onClick={() => setShowInfo((v) => !v)}
          >
            ⓘ
          </button>
          {showInfo && (
            <div className="info-icon-popover">
              NVDA equity compensation (RSU and ESPP, kept separate), Schwab Trading's open positions, and
              Schwab's live uninvested cash balance, combined into one real total. Live market values, same
              as the Equity and Trading reports themselves show -- not a ledger balance.
            </div>
          )}
        </span>
      </h3>

      <section className="equity-summary-row" style={{ marginBottom: 18 }}>
        <div className="equity-summary-col">
          <div className="equity-summary-card">
            <div className="equity-summary-card-body">
              <span>Total Holdings{!grandTotalComplete && " (partial)"}</span>
              <strong className="equity-amt">{fmt(grandTotal)}</strong>
            </div>
          </div>
        </div>
        <div className="equity-summary-col">
          <div className="equity-summary-card">
            <div className="equity-summary-card-body">
              <span>NVDA Equity (RSU + ESPP)</span>
              <strong className="equity-amt">{nvdaTotalValue != null ? fmt(nvdaTotalValue) : "—"}</strong>
            </div>
          </div>
        </div>
        <div className="equity-summary-col">
          <div className="equity-summary-card">
            <div className="equity-summary-card-body">
              <span>Trading Positions</span>
              <strong className="equity-amt">{fmt(tradingTotalValue)}</strong>
            </div>
          </div>
        </div>
        <div className="equity-summary-col">
          <div className="equity-summary-card">
            <div className="equity-summary-card-body">
              <span>Schwab Cash</span>
              <strong className="equity-amt">{schwabCash != null ? fmt(schwabCash) : "—"}</strong>
            </div>
          </div>
        </div>
        <div className="equity-summary-col">
          <div className="equity-summary-card">
            <div className="equity-summary-card-body">
              <span>Total Gain/(Loss)</span>
              <strong className="equity-amt" style={{ color: totalGL != null ? glColor(totalGL) : undefined }}>
                {totalGL != null ? fmt(totalGL) : "—"}
              </strong>
            </div>
          </div>
        </div>
        <div className="equity-summary-col">
          <div className="equity-summary-card">
            <div className="equity-summary-card-body">
              <span>Today's Gain/(Loss)</span>
              <strong className="equity-amt" style={{ color: totalDailyGL != null ? glColor(totalDailyGL) : undefined }}>
                {totalDailyGL != null ? fmt(totalDailyGL) : "—"}
              </strong>
            </div>
          </div>
        </div>
      </section>

      <table className="fx-ledger-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Detail</th>
            <th className="right">Units</th>
            <th className="right">Cost / Sh</th>
            <th className="right">Cost Basis</th>
            <th className="right">Current Price</th>
            <th className="right">Market Value</th>
            <th className="right">Gain/(Loss)</th>
            <th className="right">Today's Gain/(Loss)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>NVDA</td>
            <td>RSU</td>
            <td className="right">{rsuHeldShares.toLocaleString()}</td>
            <td className="right">{rsuHeldShares > 0 ? fmt(rsuCostBasis / rsuHeldShares) : "—"}</td>
            <td className="right">{fmt(rsuCostBasis)}</td>
            <td className="right">{nvdaPrice != null ? fmt(nvdaPrice) : "—"}</td>
            <td className="right">{rsuValue != null ? fmt(rsuValue) : "—"}</td>
            <td className="right" style={{ color: rsuValue != null ? glColor(rsuValue - rsuCostBasis) : undefined }}>
              {rsuValue != null ? fmt(rsuValue - rsuCostBasis) : "—"}
            </td>
            <td className="right" style={{ color: rsuDailyGL != null ? glColor(rsuDailyGL) : undefined }}>
              {rsuDailyGL != null ? fmt(rsuDailyGL) : "—"}
            </td>
          </tr>
          <tr>
            <td>NVDA</td>
            <td>ESPP</td>
            <td className="right">{esppHeldShares.toLocaleString()}</td>
            <td className="right">{esppHeldShares > 0 ? fmt(esppCostBasis / esppHeldShares) : "—"}</td>
            <td className="right">{fmt(esppCostBasis)}</td>
            <td className="right">{nvdaPrice != null ? fmt(nvdaPrice) : "—"}</td>
            <td className="right">{esppValue != null ? fmt(esppValue) : "—"}</td>
            <td className="right" style={{ color: esppValue != null ? glColor(esppValue - esppCostBasis) : undefined }}>
              {esppValue != null ? fmt(esppValue - esppCostBasis) : "—"}
            </td>
            <td className="right" style={{ color: esppDailyGL != null ? glColor(esppDailyGL) : undefined }}>
              {esppDailyGL != null ? fmt(esppDailyGL) : "—"}
            </td>
          </tr>
          {positionRows.map((r) => (
            <tr key={r.t.id}>
              <td>{r.t.symbol}</td>
              <td>{BROKER_LABEL[r.t.broker] || r.t.broker}</td>
              <td className="right">{r.t.units}</td>
              <td className="right">{fmt(r.t.costPerSh)}</td>
              <td className="right">{fmt(r.cost)}</td>
              <td className="right">
                {fmt(r.cur)}
                {!r.hasLivePrice && (
                  <span style={{ color: "#dc2626" }} title="Live price unavailable right now -- showing the last known price instead"> *</span>
                )}
              </td>
              <td className="right">{fmt(r.mv)}</td>
              <td className="right" style={{ color: glColor(r.gl) }}>{fmt(r.gl)}</td>
              <td className="right" style={{ color: glColor(r.dailyGL) }}>{fmt(r.dailyGL)}</td>
            </tr>
          ))}
          <tr>
            <td>Schwab Cash</td>
            <td>Uninvested cash</td>
            <td className="right">—</td>
            <td className="right">—</td>
            <td className="right">—</td>
            <td className="right">—</td>
            <td className="right">
              {schwabCash != null ? (
                fmt(schwabCash)
              ) : (
                <span style={{ color: "#dc2626" }} title={schwabCashError ?? undefined}>Unavailable</span>
              )}
            </td>
            <td className="right">—</td>
            <td className="right">—</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={4}>Total{!grandTotalComplete && " (partial)"}</th>
            <th className="right">{fmt(nvdaCostBasis + tradingTotalCost)}</th>
            <th></th>
            <th className="right">{fmt(grandTotal)}</th>
            <th className="right" style={{ color: totalGL != null ? glColor(totalGL) : undefined }}>
              {totalGL != null ? fmt(totalGL) : "—"}
            </th>
            <th className="right" style={{ color: totalDailyGL != null ? glColor(totalDailyGL) : undefined }}>
              {totalDailyGL != null ? fmt(totalDailyGL) : "—"}
            </th>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
