"use client";
import React, { useState } from "react";

interface Trade {
  company: string;
  symbol: string;
  broker: "CST" | "CSS" | "RBS";
  buyDate: string;
  saleDate?: string;
  units: number;
  costPerSh: number;
  marketOrSalePrice: number;
  yesterday: number;
}

const TRADING_SEED: Trade[] = [
  // Open positions
  { company: "MicroStrategy", symbol: "MSTR", broker: "CST", buyDate: "2025-07-22", units: 20, costPerSh: 420.71, marketOrSalePrice: 100.20, yesterday: 100.01 },
  { company: "MicroStrategy", symbol: "MSTR", broker: "CST", buyDate: "2025-07-22", units: 80, costPerSh: 186.20, marketOrSalePrice: 100.20, yesterday: 100.01 },
  { company: "Oracle", symbol: "ORCL", broker: "CST", buyDate: "2025-12-10", units: 44, costPerSh: 219.59, marketOrSalePrice: 149.80, yesterday: 147.02 },
  { company: "Sarepta Therapeutics", symbol: "SRPT", broker: "CST", buyDate: "2025-10-28", units: 300, costPerSh: 24.30, marketOrSalePrice: 16.645, yesterday: 16.78 },
  // Closed positions
  { company: "Nokia", symbol: "NOK", broker: "CSS", buyDate: "2025-10-28", saleDate: "2026-03-12", units: 1000, costPerSh: 7.49, marketOrSalePrice: 8.25, yesterday: 9.26 },
  { company: "Palantir", symbol: "PLTR", broker: "CSS", buyDate: "2025-02-20", saleDate: "2025-12-09", units: 50, costPerSh: 96.00, marketOrSalePrice: 182.30, yesterday: 179.04 },
  { company: "Oklo", symbol: "OKLO", broker: "CSS", buyDate: "2025-09-17", saleDate: "2025-10-10", units: 150, costPerSh: 94.68, marketOrSalePrice: 155.75, yesterday: 45.32 },
  { company: "Robinhood", symbol: "HOOD", broker: "CSS", buyDate: "2025-08-07", saleDate: "2025-09-30", units: 135, costPerSh: 110.00, marketOrSalePrice: 142.25, yesterday: 93.29 },
  { company: "MicroStrategy", symbol: "MSTR", broker: "CSS", buyDate: "2024-12-10", saleDate: "2024-12-11", units: 10, costPerSh: 371.00, marketOrSalePrice: 405.00, yesterday: 100.01 },
  { company: "Broadcom", symbol: "AVGO", broker: "CSS", buyDate: "2024-12-12", saleDate: "2025-02-07", units: 50, costPerSh: 178.00, marketOrSalePrice: 232.55, yesterday: 427.76 },
  { company: "Uber", symbol: "UBER", broker: "CSS", buyDate: "2025-07-15", saleDate: "2025-09-15", units: 150, costPerSh: 92.10, marketOrSalePrice: 96.80, yesterday: 75.02 },
  { company: "Tesla", symbol: "TSLA", broker: "CSS", buyDate: "2024-12-10", saleDate: "2025-08-01", units: 50, costPerSh: 391.00, marketOrSalePrice: 301.21, yesterday: 328.58 },
  { company: "MicroStrategy", symbol: "MSTR", broker: "CSS", buyDate: "2024-12-19", saleDate: "2025-01-17", units: 50, costPerSh: 345.00, marketOrSalePrice: 443.00, yesterday: 100.01 },
  { company: "Super Micro", symbol: "SMCI", broker: "CSS", buyDate: "2024-12-16", saleDate: "2025-02-10", units: 150, costPerSh: 33.35, marketOrSalePrice: 38.50, yesterday: 31.13 },
  { company: "MicroStrategy", symbol: "MSTR", broker: "CSS", buyDate: "2025-01-27", saleDate: "2025-07-15", units: 50, costPerSh: 365.44, marketOrSalePrice: 388.00, yesterday: 100.01 },
  { company: "Meta", symbol: "META", broker: "CSS", buyDate: "2024-11-15", saleDate: "2024-11-18", units: 88, costPerSh: 558.60, marketOrSalePrice: 554.12, yesterday: 592.10 },
  { company: "MicroStrategy", symbol: "MSTR", broker: "CSS", buyDate: "2024-11-22", saleDate: "2024-11-22", units: 25, costPerSh: 405.90, marketOrSalePrice: 425.00, yesterday: 100.01 },
  { company: "Tesla", symbol: "TSLA", broker: "CSS", buyDate: "2024-11-25", saleDate: "2024-11-29", units: 150, costPerSh: 339.00, marketOrSalePrice: 343.00, yesterday: 328.58 },
  { company: "Tesla", symbol: "TSLA", broker: "CSS", buyDate: "2024-11-18", saleDate: "2024-11-22", units: 148, costPerSh: 331.55, marketOrSalePrice: 342.00, yesterday: 328.58 },
  { company: "Apple", symbol: "AAPL", broker: "RBS", buyDate: "2020-10-28", saleDate: "2024-11-13", units: 9.10, costPerSh: 113.18, marketOrSalePrice: 223.96, yesterday: 313.06 },
  { company: "Nio", symbol: "NIO", broker: "RBS", buyDate: "2020-11-13", saleDate: "2024-11-13", units: 2552, costPerSh: 9.82, marketOrSalePrice: 4.67, yesterday: 4.74 },
  { company: "Workhorse", symbol: "WKHS", broker: "RBS", buyDate: "2021-03-09", saleDate: "2024-11-05", units: 9, costPerSh: 222.22, marketOrSalePrice: 0.76, yesterday: 3.33 },
  { company: "DraftKings", symbol: "DKNG", broker: "RBS", buyDate: "2020-11-13", saleDate: "2024-03-21", units: 68.8, costPerSh: 44.04, marketOrSalePrice: 47.65, yesterday: 24.03 },
  { company: "Meta", symbol: "META", broker: "RBS", buyDate: "2024-10-17", saleDate: "2024-11-18", units: 347, costPerSh: 571.56, marketOrSalePrice: 552.85, yesterday: 592.10 },
  { company: "Tesla", symbol: "TSLA", broker: "RBS", buyDate: "2024-11-18", saleDate: "2024-11-22", units: 605, costPerSh: 343.10, marketOrSalePrice: 347.50, yesterday: 328.58 },
  { company: "Tesla", symbol: "TSLA", broker: "RBS", buyDate: "2024-11-25", saleDate: "2024-11-27", units: 450, costPerSh: 353.20, marketOrSalePrice: 348.90, yesterday: 328.58 },
  { company: "Block (SQ)", symbol: "SQ", broker: "RBS", buyDate: "2024-11-27", saleDate: "2024-12-04", units: 80, costPerSh: 96.00, marketOrSalePrice: 95.37, yesterday: 79.00 },
  { company: "MicroStrategy", symbol: "MSTR", broker: "RBS", buyDate: "2024-12-09", saleDate: "2024-12-11", units: 32, costPerSh: 378.50, marketOrSalePrice: 405.00, yesterday: 100.01 },
  { company: "MicroStrategy", symbol: "MSTR", broker: "RBS", buyDate: "2024-12-05", saleDate: "2024-12-06", units: 12, costPerSh: 391.50, marketOrSalePrice: 401.50, yesterday: 100.01 },
  { company: "MicroStrategy", symbol: "MSTR", broker: "RBS", buyDate: "2024-11-27", saleDate: "2024-12-04", units: 135, costPerSh: 377.00, marketOrSalePrice: 407.50, yesterday: 100.01 },
];

function daysBetween(d1: string, d2: string) {
  return Math.round((new Date(d2).getTime() - new Date(d1).getTime()) / 86400000);
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const BROKER_LABEL: Record<string, string> = { CST: "Charles Schwab (CST)", CSS: "Charles Schwab (CSS)", RBS: "Robinhood (RBS)" };

export function TradingReport({ fmt }: { fmt: (n: number) => string }) {
  const [activeTab, setActiveTab] = useState<"open" | "closed">("open");
  const [closedSort, setClosedSort] = useState<"date" | "gl" | "pct">("date");

  const open = TRADING_SEED.filter((t) => !t.saleDate);
  const closed = TRADING_SEED.filter((t) => !!t.saleDate);

  const glOf = (t: Trade) => t.units * (t.marketOrSalePrice - t.costPerSh);
  const pctOf = (t: Trade) => ((t.marketOrSalePrice - t.costPerSh) / t.costPerSh) * 100;
  const costOf = (t: Trade) => t.units * t.costPerSh;
  const vsToday = (t: Trade) => t.units * (t.marketOrSalePrice - t.yesterday);

  const totalUnrealized = open.reduce((s, t) => s + glOf(t), 0);
  const totalRealized = closed.reduce((s, t) => s + glOf(t), 0);
  const netPL = totalUnrealized + totalRealized;

  const brokerGL: Record<string, number> = {};
  TRADING_SEED.forEach((t) => {
    brokerGL[t.broker] = (brokerGL[t.broker] ?? 0) + glOf(t);
  });

  const sortedClosed = [...closed].sort((a, b) => {
    if (closedSort === "gl") return glOf(b) - glOf(a);
    if (closedSort === "pct") return pctOf(b) - pctOf(a);
    return new Date(b.buyDate).getTime() - new Date(a.buyDate).getTime();
  });

  const glClass = (v: number) => (v > 0 ? "tr-gain-pos" : v < 0 ? "tr-gain-neg" : "");
  const badge = (v: number) => (v >= 0 ? "tr-badge-pos" : "tr-badge-neg");

  // Insight data
  const missedGains = closed.filter((t) => glOf(t) > 0 && t.yesterday > t.marketOrSalePrice);
  const longSpeculative = closed.filter((t) => {
    const days = daysBetween(t.buyDate, t.saleDate!);
    return days > 365 && glOf(t) < 0;
  });
  const mstrTrades = TRADING_SEED.filter((t) => t.symbol === "MSTR");
  const mstrCost = mstrTrades.reduce((s, t) => s + costOf(t), 0);
  const totalCost = TRADING_SEED.reduce((s, t) => s + costOf(t), 0);
  const mstrConc = (mstrCost / totalCost) * 100;

  return (
    <div className="trading-report">
      {/* Summary bar */}
      <div className="tr-summary-bar">
        <div className="tr-summary-card tr-summary-card--neutral">
          <span>Open Positions</span>
          <strong>{open.length}</strong>
        </div>
        <div className={`tr-summary-card ${totalUnrealized < 0 ? "tr-summary-card--neg" : "tr-summary-card--pos"}`}>
          <span>Unrealized G/(L)</span>
          <strong className="trading-amt">{fmt(totalUnrealized)}</strong>
        </div>
        <div className={`tr-summary-card ${totalRealized < 0 ? "tr-summary-card--neg" : "tr-summary-card--pos"}`}>
          <span>Realized G/(L)</span>
          <strong className="trading-amt">{fmt(totalRealized)}</strong>
        </div>
        <div className={`tr-summary-card ${netPL < 0 ? "tr-summary-card--neg" : "tr-summary-card--pos"}`}>
          <span>Net P&amp;L</span>
          <strong className="trading-amt">{fmt(netPL)}</strong>
        </div>
        <div className="tr-summary-card tr-summary-card--neutral">
          <span>Total Trades</span>
          <strong>{TRADING_SEED.length}</strong>
        </div>
      </div>

      {/* Broker breakdown */}
      <div className="tr-broker-row">
        {Object.entries(brokerGL).map(([b, gl]) => (
          <div key={b} className="tr-broker-chip">
            <span className="tr-broker-name">{BROKER_LABEL[b] ?? b}</span>
            <span className={`tr-broker-gl ${glClass(gl)}`}>{fmt(gl)}</span>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="tr-tabs">
        <button className={activeTab === "open" ? "selected" : ""} onClick={() => setActiveTab("open")}>
          Open Positions ({open.length})
        </button>
        <button className={activeTab === "closed" ? "selected" : ""} onClick={() => setActiveTab("closed")}>
          Closed Positions ({closed.length})
        </button>
      </div>

      {activeTab === "open" && (
        <div className="tr-table-wrap">
          <table className="tr-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Ticker</th>
                <th>Broker</th>
                <th className="right">Buy Date</th>
                <th className="right">Days Held</th>
                <th className="right">Units</th>
                <th className="right">Cost/Sh</th>
                <th className="right">Total Cost</th>
                <th className="right">Current Price</th>
                <th className="right">Market Value</th>
                <th className="right">G/(L) $</th>
                <th className="right">G/(L) %</th>
                <th className="right">Daily G/(L) $</th>
                <th className="right">Daily G/(L) %</th>
              </tr>
            </thead>
            <tbody>
              {open.map((t, i) => {
                const gl = glOf(t);
                const pct = pctOf(t);
                const mv = t.units * t.marketOrSalePrice;
                const tc = costOf(t);
                const days = daysBetween(t.buyDate, new Date().toISOString().slice(0, 10));
                const dailyGL = t.units * (t.marketOrSalePrice - t.yesterday);
                const dailyPct = ((t.marketOrSalePrice - t.yesterday) / t.yesterday) * 100;
                return (
                  <tr key={i} className={gl < 0 ? "tr-row-loss" : "tr-row-gain"}>
                    <td>{t.company}</td>
                    <td><span className="tr-symbol">{t.symbol}</span></td>
                    <td><span className="tr-broker-tag">{t.broker}</span></td>
                    <td className="right">{fmtDate(t.buyDate)}</td>
                    <td className="right">{days}d</td>
                    <td className="right trading-amt">{t.units % 1 === 0 ? t.units : t.units.toFixed(2)}</td>
                    <td className="right trading-amt">${t.costPerSh.toFixed(2)}</td>
                    <td className="right trading-amt">{fmt(tc)}</td>
                    <td className="right trading-amt">${t.marketOrSalePrice.toFixed(2)}</td>
                    <td className="right trading-amt">{fmt(mv)}</td>
                    <td className={`right trading-amt ${glClass(gl)}`}>{fmt(gl)}</td>
                    <td className="right">
                      <span className={`tr-badge ${badge(pct)}`}>{pct >= 0 ? "+" : ""}{pct.toFixed(1)}%</span>
                    </td>
                    <td className={`right trading-amt ${glClass(dailyGL)}`}>{dailyGL >= 0 ? "+" : ""}{fmt(dailyGL)}</td>
                    <td className="right">
                      <span className={`tr-badge ${badge(dailyPct)}`}>{dailyPct >= 0 ? "+" : ""}{dailyPct.toFixed(2)}%</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={7}>Total Open</th>
                <th className="right trading-amt">{fmt(open.reduce((s, t) => s + costOf(t), 0))}</th>
                <th />
                <th className="right trading-amt">{fmt(open.reduce((s, t) => s + t.units * t.marketOrSalePrice, 0))}</th>
                <th className={`right trading-amt ${glClass(totalUnrealized)}`}>{fmt(totalUnrealized)}</th>
                <th />
                <th className={`right trading-amt ${glClass(open.reduce((s, t) => s + t.units * (t.marketOrSalePrice - t.yesterday), 0))}`}>
                  {open.reduce((s, t) => s + t.units * (t.marketOrSalePrice - t.yesterday), 0) >= 0 ? "+" : ""}
                  {fmt(open.reduce((s, t) => s + t.units * (t.marketOrSalePrice - t.yesterday), 0))}
                </th>
                <th />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {activeTab === "closed" && (
        <div className="tr-table-wrap">
          <div className="tr-sort-row">
            <span>Sort by:</span>
            <button className={closedSort === "date" ? "selected" : ""} onClick={() => setClosedSort("date")}>Buy Date</button>
            <button className={closedSort === "gl" ? "selected" : ""} onClick={() => setClosedSort("gl")}>G/(L) $</button>
            <button className={closedSort === "pct" ? "selected" : ""} onClick={() => setClosedSort("pct")}>G/(L) %</button>
          </div>
          <table className="tr-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Ticker</th>
                <th>Broker</th>
                <th className="right">Buy Date</th>
                <th className="right">Sale Date</th>
                <th className="right">Days</th>
                <th className="right">Units</th>
                <th className="right">Cost/Sh</th>
                <th className="right">Sale/Sh</th>
                <th className="right">Total Cost</th>
                <th className="right">Proceeds</th>
                <th className="right">G/(L) $</th>
                <th className="right">G/(L) %</th>
              </tr>
            </thead>
            <tbody>
              {sortedClosed.map((t, i) => {
                const gl = glOf(t);
                const pct = pctOf(t);
                const tc = costOf(t);
                const proceeds = t.units * t.marketOrSalePrice;
                const days = daysBetween(t.buyDate, t.saleDate!);
                return (
                  <tr key={i} className={gl < 0 ? "tr-row-loss" : "tr-row-gain"}>
                    <td>{t.company}</td>
                    <td><span className="tr-symbol">{t.symbol}</span></td>
                    <td><span className="tr-broker-tag">{t.broker}</span></td>
                    <td className="right">{fmtDate(t.buyDate)}</td>
                    <td className="right">{fmtDate(t.saleDate!)}</td>
                    <td className="right">{days === 0 ? "Same day" : `${days}d`}</td>
                    <td className="right trading-amt">{t.units % 1 === 0 ? t.units : t.units.toFixed(2)}</td>
                    <td className="right trading-amt">${t.costPerSh.toFixed(2)}</td>
                    <td className="right trading-amt">${t.marketOrSalePrice.toFixed(2)}</td>
                    <td className="right trading-amt">{fmt(tc)}</td>
                    <td className="right trading-amt">{fmt(proceeds)}</td>
                    <td className={`right trading-amt ${glClass(gl)}`}>{fmt(gl)}</td>
                    <td className="right">
                      <span className={`tr-badge ${badge(pct)}`}>{pct >= 0 ? "+" : ""}{pct.toFixed(1)}%</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={9}>Total Closed</th>
                <th className="right trading-amt">{fmt(closed.reduce((s, t) => s + costOf(t), 0))}</th>
                <th className="right trading-amt">{fmt(closed.reduce((s, t) => s + t.units * t.marketOrSalePrice, 0))}</th>
                <th className={`right trading-amt ${glClass(totalRealized)}`}>{fmt(totalRealized)}</th>
                <th />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Advisor Insights */}
      <div className="tr-insights">
        <h4 className="tr-insights-heading">Advisor Insights</h4>
        <div className="tr-insights-grid">

          {/* Alert: all open positions losing */}
          <div className="tr-insight tr-insight--warn">
            <div className="tr-insight-icon">⚠</div>
            <div className="tr-insight-body">
              <strong>All 4 open positions are losing</strong>
              <p>Every open trade is in the red, totaling <span className="tr-gain-neg">{fmt(totalUnrealized)}</span> unrealized loss. MSTR has two open positions bought at $420 and $186 — currently at $100 — suggesting you were averaging down in a declining stock. Consider whether a stop-loss or exit discipline could limit further damage.</p>
            </div>
          </div>

          {/* Alert: MSTR concentration */}
          <div className="tr-insight tr-insight--warn">
            <div className="tr-insight-icon">⚠</div>
            <div className="tr-insight-body">
              <strong>High concentration in MicroStrategy ({mstrConc.toFixed(0)}% of total capital deployed)</strong>
              <p>MSTR appears across all 3 brokers in {mstrTrades.length} trades. While your closed MSTR trades were profitable short swings, the open positions at CST are deep losses. Trading the same volatile stock across multiple accounts amplifies both risk and emotional bias. Keep individual stock exposure under 15–20% of trading capital.</p>
            </div>
          </div>

          {/* Long-term speculation disasters */}
          {longSpeculative.length > 0 && (
            <div className="tr-insight tr-insight--warn">
              <div className="tr-insight-icon">⚠</div>
              <div className="tr-insight-body">
                <strong>Long-term speculative holds destroyed capital</strong>
                <ul className="tr-insight-list">
                  {longSpeculative.map((t, i) => (
                    <li key={i}>
                      <strong>{t.symbol}</strong> — held {daysBetween(t.buyDate, t.saleDate!)} days, lost{" "}
                      <span className="tr-gain-neg">{fmt(glOf(t))}</span> ({pctOf(t).toFixed(1)}%)
                    </li>
                  ))}
                </ul>
                <p>Nio lost 52% over 4 years; Workhorse lost 99.7% over 3 years. Speculative small-caps carried without a stop-loss can go to near-zero. A hard rule (e.g., exit any position down &gt;25–30%) would have saved most of this capital.</p>
              </div>
            </div>
          )}

          {/* Missed gains */}
          {missedGains.length > 0 && (
            <div className="tr-insight tr-insight--info">
              <div className="tr-insight-icon">ℹ</div>
              <div className="tr-insight-body">
                <strong>Strong exits — but some left significant gains on the table</strong>
                <ul className="tr-insight-list">
                  {missedGains.slice(0, 5).map((t, i) => {
                    const missed = t.units * (t.yesterday - t.marketOrSalePrice);
                    return (
                      <li key={i}>
                        <strong>{t.symbol}</strong> — sold @ ${t.marketOrSalePrice.toFixed(2)}, now ${t.yesterday.toFixed(2)},{" "}
                        missed extra <span className="tr-gain-pos">{fmt(missed)}</span>
                      </li>
                    );
                  })}
                </ul>
                <p>These were good exits — you locked in gains. The "missed" column is hindsight; only flag if a pattern emerges (selling right after a small bounce before a larger move).</p>
              </div>
            </div>
          )}

          {/* Good exits worth repeating */}
          <div className="tr-insight tr-insight--pos">
            <div className="tr-insight-icon">✓</div>
            <div className="tr-insight-body">
              <strong>Excellent short-term discipline — keep repeating this</strong>
              <p>OKLO (+64.5% in 23 days), HOOD (+29.3% in 54 days), PLTR (+89.9% in 292 days), UBER (+5.1% in 62 days), SMCI (+15.4% in 56 days, SMCI later dropped). These exits show strong instinct for knowing when to take profits. Your CSS broker account runs a disciplined swing-trade style that works.</p>
            </div>
          </div>

          {/* Note on Daily G/(L) in source data */}
          <div className="tr-insight tr-insight--note">
            <div className="tr-insight-icon">ℹ</div>
            <div className="tr-insight-body">
              <strong>Data note: "Daily G/(L)" in your Excel is misleading for closed positions</strong>
              <p>The Excel Daily G/(L) column compares the original sale price to today's market price — not an actual day-over-day change. For closed positions, this column shows what you'd have gained or lost if you still held today vs. when you sold. This report does not display that column; it shows realized G/(L) based on buy vs. sale prices.</p>
            </div>
          </div>

        </div>
      </div>

    </div>
  );
}
