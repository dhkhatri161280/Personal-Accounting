"use client";
import { useState } from "react";
import { StatIcon, type IconKind } from "@/components/Icon";

interface CashFlowGroup {
  group: string;
  inflow: number;
  outflow: number;
  inflowLedgers: { name: string; amount: number }[];
  outflowLedgers: { name: string; amount: number }[];
}

export function CashFlowReport({
  periodLabel,
  cashOpening,
  cashInflows,
  cashOutflows,
  cashNet,
  cashFlowClosing,
  cashBank,
  cashFlowGroups,
  tol,
  fmt,
  onGroup,
  onLedger,
  uiTheme,
}: {
  periodLabel: string;
  cashOpening: number;
  cashInflows: number;
  cashOutflows: number;
  cashNet: number;
  cashFlowClosing: number;
  cashBank: number;
  cashFlowGroups: CashFlowGroup[];
  tol: number;
  fmt: (n: number) => string;
  onGroup: (group: string) => void;
  onLedger: (group: string, ledger: string) => void;
  uiTheme?: "classic" | "refresh";
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["inflows", "outflows"]));
  const toggle = (k: string) =>
    setExpanded((p) => {
      const n = new Set(p);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const renderSection = (
    key: string,
    title: string,
    total: number,
    items: CashFlowGroup[],
    kind: "inflow" | "outflow"
  ) => {
    const sectionOpen = expanded.has(key);
    return (
      <section className="report-group cash-flow-side">
        <button className="group-heading cash-flow-main-heading" onClick={() => toggle(key)}>
          <span className="bs-arr">{sectionOpen ? "-" : "+"}</span>
          <strong>{title}</strong>
          <span>{fmt(total)}</span>
        </button>
        {sectionOpen &&
          items.map((g) => {
            const lines = kind === "inflow" ? g.inflowLedgers : g.outflowLedgers;
            const totalValue = kind === "inflow" ? g.inflow : g.outflow;
            const groupKey = key + ":" + g.group;
            const groupOpen = expanded.has(groupKey);
            return (
              <section className="cash-flow-group" key={kind + g.group}>
                <button
                  className="report-line cash-flow-group-total cash-flow-toggle-line"
                  onClick={() => toggle(groupKey)}
                >
                  <span>
                    <b className="bs-arr">{groupOpen ? "-" : "+"}</b>
                    {g.group}
                  </span>
                  <strong>{fmt(totalValue)}</strong>
                </button>
                {groupOpen &&
                  lines.map((l) => (
                    <button
                      className="report-line cash-flow-ledger-line"
                      key={kind + g.group + l.name}
                      onClick={() => onLedger(g.group, l.name)}
                    >
                      <span>{l.name}</span>
                      <strong>{fmt(l.amount)}</strong>
                    </button>
                  ))}
              </section>
            );
          })}
        {sectionOpen && (
          <div className="report-grand">
            <span>Total {title}</span>
            <strong>{fmt(total)}</strong>
          </div>
        )}
      </section>
    );
  };

  const summaryCards: { label: string; value: number; icon: IconKind; color: string }[] = [
    { label: "Opening Balance", value: cashOpening, icon: "bank", color: "#64748b" },
    { label: "Cash Inflows", value: cashInflows, icon: "trending-up", color: "#16a34a" },
    { label: "Cash Outflows", value: cashOutflows, icon: "trending-up", color: "#dc2626" },
    { label: "Closing Balance", value: cashFlowClosing, icon: "bank", color: "#1e40af" },
  ];

  return (
    <div className="data-panel cash-flow-report">
      <h3>Cash Flow - {periodLabel}</h3>
      <div className="equity-summary-row" style={{ marginBottom: "0.75rem" }}>
        {summaryCards.map((c) => (
          <div key={c.label} className="equity-summary-col">
            <div className="equity-summary-card">
              {uiTheme === "refresh" && <StatIcon kind={c.icon} color={c.color} />}
              <div className="equity-summary-card-body">
                <span>{c.label}</span>
                <strong className="equity-amt">{fmt(c.value)}</strong>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="cash-flow-columns">
        {renderSection(
          "inflows",
          "Cash inflows",
          cashInflows,
          cashFlowGroups.filter((g) => g.inflow > tol),
          "inflow"
        )}
        {renderSection(
          "outflows",
          "Cash outflows",
          cashOutflows,
          cashFlowGroups.filter((g) => g.outflow > tol),
          "outflow"
        )}
      </div>
      <div className="report-total">
        <span>Net increase / (decrease) in cash</span>
        <strong className={cashNet < 0 ? "negative" : ""}>{fmt(cashNet)}</strong>
      </div>
      <div className="report-grand">
        <span>Closing cash and bank balance</span>
        <strong>{fmt(cashFlowClosing)}</strong>
      </div>
      {Math.abs(cashFlowClosing - cashBank) > 0.01 && (
        <div className="balance-check difference">
          <strong>Reconciliation difference</strong>
          <span>{fmt(cashFlowClosing - cashBank)}</span>
        </div>
      )}
    </div>
  );
}
