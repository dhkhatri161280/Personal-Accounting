"use client";
import { Icon, type IconKind } from "@/components/Icon";

export interface VoucherFlowEntry {
  accountName: string;
  amount: number; // negative = debit, positive = credit (this app's convention throughout)
}

const TYPE_STYLE: Record<string, { icon: IconKind; color: string }> = {
  payment: { icon: "wallet", color: "#dc2626" },
  receipt: { icon: "cash", color: "#16a34a" },
  contra: { icon: "bank", color: "#1e40af" },
  journal: { icon: "scale", color: "#7c3aed" },
};

export function voucherTypeStyle(type: string): { icon: IconKind; color: string } {
  return TYPE_STYLE[type.toLowerCase()] ?? { icon: "receipt", color: "#64748b" };
}

export function VoucherTypeBadge({ type }: { type: string }) {
  const style = voucherTypeStyle(type);
  return (
    <span className="voucher-type-badge" style={{ background: `${style.color}1a`, color: style.color, borderColor: `${style.color}40` }}>
      <Icon kind={style.icon} size={15} />
      {type}
    </span>
  );
}

/** A "From -> To" visual for a voucher's entries, replacing a raw Dr/Cr table -- Credit side
 * (positive amount) is the source the money/value came FROM, Debit side (negative amount) is
 * where it went TO, matching the standard accounting direction (e.g. Payment: Cr Bank -> Dr
 * Expense, money flows from the bank to the expense). Handles split vouchers with multiple
 * entries per side by stacking cards in each column. */
export function VoucherFlow({ entries, fmt }: { entries: VoucherFlowEntry[]; fmt: (n: number) => string }) {
  const from = entries.filter((e) => e.amount > 0);
  const to = entries.filter((e) => e.amount < 0);

  return (
    <div className="voucher-flow">
      <div className="voucher-flow-col">
        <div className="voucher-flow-col-label">From</div>
        {from.map((e, i) => (
          <div key={i} className="voucher-flow-card voucher-flow-card--from">
            <span>{e.accountName}</span>
            <strong>{fmt(e.amount)}</strong>
          </div>
        ))}
      </div>
      <div className="voucher-flow-arrow" aria-hidden="true">
        <Icon kind="trending-up" size={22} />
      </div>
      <div className="voucher-flow-col">
        <div className="voucher-flow-col-label">To</div>
        {to.map((e, i) => (
          <div key={i} className="voucher-flow-card voucher-flow-card--to">
            <span>{e.accountName}</span>
            <strong>{fmt(-e.amount)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
