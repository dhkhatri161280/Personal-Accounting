"use client";
import { useState } from "react";
import type React from "react";

interface BSRow {
  id: number;
  name: string;
  parent?: string;
  category?: string;
  closing: number;
}

const BS_SECTION: Record<string, string> = {
  "capital account": "Capital Account",
  "reserves & surplus": "Reserves & Surplus",
  "secured loans": "Loans (Liability)",
  "unsecured loans": "Loans (Liability)",
  "bank od a/c": "Loans (Liability)",
  "loans (liability)": "Loans (Liability)",
  "sundry creditors": "Current Liabilities",
  "duties & taxes": "Current Liabilities",
  provisions: "Current Liabilities",
  "current liabilities": "Current Liabilities",
  "suspense a/c": "Suspense A/c",
  "fixed assets": "Fixed Assets",
  investments: "Investments",
  "current assets": "Current Assets",
  "cash-in-hand": "Current Assets",
  "bank accounts": "Current Assets",
  "loans & advances (asset)": "Current Assets",
  "deposits (asset)": "Current Assets",
  "sundry debtors": "Current Assets",
  "miscellaneous expenditure (asset)": "Miscellaneous Expenditure",
};
const L_ORDER = [
  "Capital Account",
  "Reserves & Surplus",
  "Loans (Liability)",
  "Current Liabilities",
  "Suspense A/c",
];
const R_ORDER = ["Fixed Assets", "Investments", "Current Assets", "Miscellaneous Expenditure"];
const SUB_ORDER: Record<string, number> = {
  "cash-in-hand": 1,
  "bank accounts": 2,
  "loans & advances (asset)": 3,
  "deposits (asset)": 4,
  "sundry debtors": 5,
  "bank od a/c": 1,
  "secured loans": 2,
  "unsecured loans": 3,
  "loans (liability)": 4,
  "sundry creditors": 1,
  "duties & taxes": 2,
  provisions: 3,
  "current liabilities": 4,
  "capital account": 1,
  "reserves & surplus": 2,
};

function sectionFor(a: BSRow, defaultSection: string): string {
  const g = (a.parent || a.category || "").toLowerCase().trim();
  return BS_SECTION[g] || (g.includes("(asset)") ? "Current Assets" : defaultSection);
}

function subOrder(p: string): number {
  return SUB_ORDER[(p || "").toLowerCase().trim()] ?? 99;
}

function buildMap(rows: BSRow[], defaultSection: string): Map<string, Map<string, BSRow[]>> {
  const m = new Map<string, Map<string, BSRow[]>>();
  for (const a of rows) {
    const sec = sectionFor(a, defaultSection);
    if (!m.has(sec)) m.set(sec, new Map());
    const pg = a.parent || a.category || "Other";
    const sm = m.get(sec)!;
    if (!sm.has(pg)) sm.set(pg, []);
    sm.get(pg)!.push(a);
  }
  return m;
}

export function BalanceSheetReport({
  assets,
  liabilities,
  capitalTransfer,
  tol = 0.005,
  link,
  fmt,
  onNavigateToIE,
}: {
  assets: BSRow[];
  liabilities: BSRow[];
  capitalTransfer: number;
  plRows?: BSRow[];
  tol?: number;
  link: (a: BSRow) => React.ReactNode;
  fmt: (n: number) => string;
  onNavigateToIE?: () => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setExpanded((p) => {
      const n = new Set(p);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const lMap = buildMap(liabilities, "Current Liabilities");
  const rMap = buildMap(assets, "Current Assets");
  const PLdisp = -capitalTransfer;
  const assetLedg = assets.reduce((s, a) => s - a.closing, 0);
  const liabLedg = liabilities.reduce((s, a) => s + a.closing, 0);
  const assetSide = assetLedg + (PLdisp >= 0 ? PLdisp : 0);
  const liabSide = liabLedg + (PLdisp < 0 ? -PLdisp : 0);
  const diff = assetSide - liabSide;
  const showPL = Math.abs(PLdisp) > tol;

  const renderSection = (sk: string, side: "L" | "R", sub: Map<string, BSRow[]>) => {
    const sign = side === "L" ? 1 : -1;
    const tot = [...sub.values()].flat().reduce((s, a) => s + sign * a.closing, 0);
    const isE = expanded.has(sk);
    return (
      <section key={sk} className="bs-sec">
        <button className="bs-sec-head" onClick={() => toggle(sk)}>
          <span className="bs-arr">{isE ? "-" : "+"}</span>
          <strong>{sk}</strong>
          <span className="bs-amt">{fmt(tot)}</span>
        </button>
        {isE && (
          <div className="bs-body">
            {[...sub.entries()]
              .sort((a, b) => subOrder(a[0]) - subOrder(b[0]))
              .map(([grp, rows]) => {
                const gt = rows.reduce((s, a) => s + sign * a.closing, 0);
                return (
                  <div key={grp} className="bs-sg">
                    {sub.size > 1 && (
                      <div className="bs-sg-head">
                        <em>{grp}</em>
                        <span>{fmt(gt)}</span>
                      </div>
                    )}
                    {rows
                      .slice()
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((a) => (
                        <div key={a.id} className="bs-row">
                          {link(a)}
                          <span>{fmt(sign * a.closing)}</span>
                        </div>
                      ))}
                  </div>
                );
              })}
          </div>
        )}
      </section>
    );
  };

  const renderPL = (side: "L" | "R") => {
    const isE = expanded.has("__pl__");
    const lbl =
      side === "R" && PLdisp > 0
        ? "Profit & Loss A/c (Deficit)"
        : side === "L"
          ? "Profit & Loss A/c (Surplus)"
          : "Profit & Loss A/c";
    return (
      <section className="bs-sec bs-pl-sec">
        <div className="bs-pl-head">
          <button className="bs-pl-toggle" onClick={() => toggle("__pl__")} title="Expand">
            <span className="bs-arr">{isE ? "-" : "+"}</span>
          </button>
          <button
            className="bs-pl-nav-btn"
            onClick={() => onNavigateToIE?.()}
            title="View Income & Expenditure"
          >
            <strong>{lbl}</strong>
            <span className="bs-amt">{fmt(Math.abs(PLdisp))}</span>
          </button>
        </div>
        {isE && (
          <div className="bs-body">
            <div className="bs-row">
              <span>
                {capitalTransfer >= 0 ? "Current period surplus" : "Current period deficit"}
              </span>
              <span>{fmt(Math.abs(capitalTransfer))}</span>
            </div>
          </div>
        )}
      </section>
    );
  };

  return (
    <>
      <div className="bs-grid">
        <div className="bs-col">
          <div className="bs-col-head">Liabilities</div>
          {L_ORDER.filter((s) => lMap.has(s) && [...lMap.get(s)!.values()].flat().length > 0).map(
            (s) => renderSection(s, "L", lMap.get(s)!)
          )}
          {showPL && PLdisp < 0 && renderPL("L")}
          <div className="bs-total">
            <span>Total Capital and Liabilities</span>
            <strong>{fmt(liabSide)}</strong>
          </div>
        </div>
        <div className="bs-col">
          <div className="bs-col-head">Assets</div>
          {R_ORDER.filter((s) => rMap.has(s) && [...rMap.get(s)!.values()].flat().length > 0).map(
            (s) => renderSection(s, "R", rMap.get(s)!)
          )}
          {showPL && PLdisp >= 0 && renderPL("R")}
          <div className="bs-total">
            <span>Total Assets</span>
            <strong>{fmt(assetSide)}</strong>
          </div>
        </div>
      </div>
      <div className={`balance-check ${Math.abs(diff) < 0.005 ? "tied" : "difference"}`}>
        <strong>Balance Sheet check</strong>
        <span>{fmt(Math.abs(diff))}</span>
        <small>
          {Math.abs(diff) < 0.005
            ? "Balanced"
            : "Difference: review ledger classifications or opening balances"}
        </small>
      </div>
    </>
  );
}
