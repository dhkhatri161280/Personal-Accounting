"use client";
import { useEffect, useMemo, useState } from "react";
import type { RsuGrant, EsppPurchase, Trade } from "@/lib/vault-types";
import { apiFetch } from "@/lib/api-fetch";

// Same broker-code labels TradingReport.tsx's own BROKER_LABEL uses -- not exported from there
// (that file wasn't refactored for this), so duplicated here rather than risk a deeper change to
// an already-large component just to share three strings.
const BROKER_LABEL: Record<string, string> = { CST: "Charles Schwab (CST)", CSS: "Charles Schwab (CSS)", RBS: "Robinhood (RBS)" };

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
  fmt,
}: {
  grants: RsuGrant[];
  esppPurchases: EsppPurchase[];
  trades: Trade[];
  nvdaPrice: number | null;
  fmt: (n: number) => string;
}) {
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

  // ── Schwab Trading open positions ─────────────────────────────────────────────────────────
  const openTrades = useMemo(() => trades.filter((t) => !t.saleDate), [trades]);
  const symbols = useMemo(() => [...new Set(openTrades.map((t) => t.symbol))], [openTrades]);
  const symbolsKey = symbols.join(",");
  const [prices, setPrices] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    if (!symbolsKey) return;
    Promise.all(
      symbolsKey.split(",").map((sym) =>
        fetch(`/api/equity-price?ticker=${sym}`)
          .then((r) => r.json())
          .then((d: unknown) => {
            const j = d as { price?: number | null };
            return { sym, price: typeof j.price === "number" ? j.price : null };
          })
          .catch(() => ({ sym, price: null }))
      )
    ).then((results) => {
      if (cancelled) return;
      const p: Record<string, number> = {};
      for (const r of results) if (r.price != null) p[r.sym] = r.price;
      setPrices(p);
    });
    return () => { cancelled = true; };
  }, [symbolsKey]);

  const positionRows = openTrades.map((t) => {
    const hasLivePrice = prices[t.symbol] != null;
    // Falls back to the trade's own last-known price (not a blank/zero) when the live fetch
    // hasn't returned yet or failed -- same "stay honest, don't silently vanish" principle as the
    // Schwab cash balance fix, flagged with a visible marker rather than pretending it's live.
    const cur = prices[t.symbol] ?? t.marketOrSalePrice;
    const cost = t.units * t.costPerSh;
    const mv = t.units * cur;
    return { t, cur, cost, mv, gl: mv - cost, hasLivePrice };
  });
  const tradingTotalCost = positionRows.reduce((s, r) => s + r.cost, 0);
  const tradingTotalValue = positionRows.reduce((s, r) => s + r.mv, 0);
  const tradingTotalGL = tradingTotalValue - tradingTotalCost;

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

  return (
    <div className="data-panel">
      <h3>Holdings — Everything in One Place</h3>
      <p className="gr-report-note">
        NVDA equity compensation (RSU and ESPP, kept separate), Schwab Trading's open positions, and
        Schwab's live uninvested cash balance, combined into one real total. Live market values, same
        as the Equity and Trading reports themselves show -- not a ledger balance.
      </p>

      <section className="equity-summary-row" style={{ marginBottom: 18 }}>
        <div className="equity-summary-col">
          <div className="equity-summary-card">
            <div className="equity-summary-card-body">
              <span>Total Holdings{!grandTotalComplete && " (partial — some figures unavailable below)"}</span>
              <strong className="equity-amt">{fmt(grandTotal)}</strong>
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
            <th className="right">Cost Basis</th>
            <th className="right">Current Price</th>
            <th className="right">Market Value</th>
            <th className="right">Gain/(Loss)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>NVDA</td>
            <td>RSU</td>
            <td className="right">{rsuHeldShares.toLocaleString()}</td>
            <td className="right">{fmt(rsuCostBasis)}</td>
            <td className="right">{nvdaPrice != null ? fmt(nvdaPrice) : "—"}</td>
            <td className="right">{rsuValue != null ? fmt(rsuValue) : "—"}</td>
            <td className="right" style={{ color: rsuValue != null && rsuValue - rsuCostBasis < 0 ? "#dc2626" : "#16a34a" }}>
              {rsuValue != null ? fmt(rsuValue - rsuCostBasis) : "—"}
            </td>
          </tr>
          <tr>
            <td>NVDA</td>
            <td>ESPP</td>
            <td className="right">{esppHeldShares.toLocaleString()}</td>
            <td className="right">{fmt(esppCostBasis)}</td>
            <td className="right">{nvdaPrice != null ? fmt(nvdaPrice) : "—"}</td>
            <td className="right">{esppValue != null ? fmt(esppValue) : "—"}</td>
            <td className="right" style={{ color: esppValue != null && esppValue - esppCostBasis < 0 ? "#dc2626" : "#16a34a" }}>
              {esppValue != null ? fmt(esppValue - esppCostBasis) : "—"}
            </td>
          </tr>
          {positionRows.map((r) => (
            <tr key={r.t.id}>
              <td>{r.t.symbol}</td>
              <td>{BROKER_LABEL[r.t.broker] || r.t.broker}</td>
              <td className="right">{r.t.units}</td>
              <td className="right">{fmt(r.cost)}</td>
              <td className="right">
                {fmt(r.cur)}
                {!r.hasLivePrice && (
                  <span style={{ color: "#dc2626" }} title="Live price unavailable right now -- showing the last known price instead"> *</span>
                )}
              </td>
              <td className="right">{fmt(r.mv)}</td>
              <td className="right" style={{ color: r.gl >= 0 ? "#16a34a" : "#dc2626" }}>{fmt(r.gl)}</td>
            </tr>
          ))}
          <tr>
            <td>Schwab Cash</td>
            <td>Uninvested cash</td>
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
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={3}>Total{!grandTotalComplete && " (partial)"}</th>
            <th className="right">{fmt(nvdaCostBasis + tradingTotalCost)}</th>
            <th></th>
            <th className="right">{fmt(grandTotal)}</th>
            <th className="right" style={{ color: nvdaTotalValue != null ? ((nvdaTotalValue - nvdaCostBasis + tradingTotalGL) >= 0 ? "#16a34a" : "#dc2626") : undefined }}>
              {nvdaTotalValue != null ? fmt(nvdaTotalValue - nvdaCostBasis + tradingTotalGL) : "—"}
            </th>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
