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
  const crTotal = from.reduce((s, e) => s + e.amount, 0);
  const drTotal = to.reduce((s, e) => s - e.amount, 0);
  // Rounds to the cent before comparing -- entries are stored as floats, and this is a purely
  // visual tally-check (the actual save-time guardrail in PlaidImport.tsx compares integer cents
  // the same way), so a sub-cent float artifact must not show as "doesn't balance".
  const balanced = Math.round((drTotal - crTotal) * 100) === 0;

  return (
    <>
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
      {/* Quiet when correct, loud when not -- the common case (balanced) is a small muted
          checkmark with no numbers to re-read, since they're already shown above. Only a real
          mismatch earns a full-width colored banner with the actual Dr/Cr breakdown, matching
          the same "blocked" banner PlaidImport.tsx uses for the save-time guardrail. */}
      {balanced ? (
        <div className="voucher-flow-tally-ok">✓ Tallied</div>
      ) : (
        <div className="voucher-flow-totals voucher-balance-diff">
          <strong>⚠ Doesn't balance</strong>
          <span>Dr {fmt(drTotal)}</span>
          <span>Cr {fmt(crTotal)}</span>
          <strong>Off by</strong>
          <span>{fmt(Math.abs(drTotal - crTotal))}</span>
        </div>
      )}
    </>
  );
}
