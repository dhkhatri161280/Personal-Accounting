"use client";
import { useEffect, useMemo, useRef, useState } from "react";

type Entry = { accountName: string; amount: number };
export type VoucherRow = {
  guid: string;
  date: string;
  type: string;
  number: string;
  narration: string;
  cancelled?: boolean;
  entries: Entry[];
};
type SortKey = "date" | "type" | "number" | "debit" | "credit" | "narration" | "amount";

// Tally's own Day Book order within a date: Contra, Payment, Receipt, Journal -- fixed, never
// reversed even when the date sort direction is descending (only the date itself, and voucher
// number within a type, follow the chosen direction). Each voucher type has its own independent
// numbering sequence per fiscal year, so tie-breaking by raw number alone (ignoring type) doesn't
// reliably reproduce this -- a Contra voucher's own sequence commonly runs far lower than the
// same date's Payment/Receipt numbers, so it was sorting to the wrong end of the day entirely.
const VOUCHER_TYPE_ORDER: Record<string, number> = { contra: 0, payment: 1, receipt: 2, journal: 3 };
const voucherTypeRank = (type: string) => VOUCHER_TYPE_ORDER[(type || "").toLowerCase()] ?? 99;

const text = (value: string) =>
  String(value || "")
    .replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&");
const debit = (t: VoucherRow) =>
  t.entries
    .filter((e) => e.amount < 0)
    .map((e) => e.accountName)
    .join(" / ") || "-";
const credit = (t: VoucherRow) =>
  t.entries
    .filter((e) => e.amount > 0)
    .map((e) => e.accountName)
    .join(" / ") || "-";
const amount = (t: VoucherRow) => t.entries.reduce((sum, e) => sum + Math.abs(e.amount), 0) / 2;
const normLedger = (value: unknown) =>
  text(String(value ?? ""))
    .trim()
    .toLowerCase();
const ledgerSignedAmount = (t: VoucherRow, selectedLedgerName?: string) => {
  const wanted = normLedger(selectedLedgerName);
  if (wanted) {
    const signed = t.entries
      .filter((e) => normLedger(e.accountName) === wanted)
      .reduce((sum, e) => sum + Number(e.amount || 0), 0);
    if (Math.abs(signed) > 0.004) return signed > 0 ? -Math.abs(signed) : Math.abs(signed);
  }
  return amount(t);
};

export function TransactionTable({
  transactions,
  formatAmount,
  onView,
  onEdit,
  onCopy,
  onDelete,
  selectedLedgerName,
  openingBalance,
  onClearSearch,
}: {
  transactions: VoucherRow[];
  formatAmount: (n: number) => string;
  onView: (t: VoucherRow) => void;
  onEdit: (t: VoucherRow) => void;
  onCopy: (t: VoucherRow) => void;
  onDelete: (t: VoucherRow) => void;
  selectedLedgerName?: string;
  openingBalance?: number;
  onClearSearch?: () => void;
}) {
  const [filters, setFilters] = useState<Record<SortKey, string>>({
    date: "",
    type: "",
    number: "",
    debit: "",
    credit: "",
    narration: "",
    amount: "",
  });
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({
    key: "date",
    direction: "desc",
  });
  const topScroll = useRef<HTMLDivElement>(null),
    bottomScroll = useRef<HTMLDivElement>(null);
  const [tableWidth, setTableWidth] = useState(980);
  useEffect(() => {
    const update = () => setTableWidth(bottomScroll.current?.scrollWidth || 980);
    update();
    const observer = new ResizeObserver(update);
    if (bottomScroll.current) observer.observe(bottomScroll.current);
    return () => observer.disconnect();
  }, [transactions]);
  const value = (t: VoucherRow, key: SortKey): string | number =>
    key === "debit"
      ? debit(t)
      : key === "credit"
        ? credit(t)
        : key === "amount"
          ? ledgerSignedAmount(t, selectedLedgerName)
          : key === "narration"
            ? text(t.narration)
            : String(t[key] || "");
  const rows = useMemo(
    () =>
      transactions
        .filter((t) =>
          (Object.keys(filters) as SortKey[]).every((key) => {
            const filter = filters[key].trim().toLowerCase();
            if (!filter) return true;
            // Date: compare against DD-MM-YYYY (what the user sees) but value() keeps YYYY-MM-DD for sorting
            const cell = key === "date" ? t.date.split("-").reverse().join("-") : value(t, key);
            if (key === "amount") {
              const n = Number(filter.replace(/[^0-9.-]/g, ""));
              return Number.isFinite(n)
                ? Math.abs(Number(cell) - n) < 0.005
                : String(cell).includes(filter);
            }
            return String(cell).toLowerCase().includes(filter);
          })
        )
        .sort((a, b) => {
          if (sort.key === "date") {
            const av = String(value(a, "date")), bv = String(value(b, "date"));
            if (av !== bv) {
              const cmp = av < bv ? -1 : 1;
              return sort.direction === "asc" ? cmp : -cmp;
            }
            // Same date: Tally's fixed voucher-type order first (Contra, Payment, Receipt,
            // Journal) -- never reversed by direction, since Tally itself always shows this
            // order regardless of date direction. Only within the same type does voucher
            // number follow the chosen direction (matching how every other date's ordering
            // already behaves).
            const ta = voucherTypeRank(a.type), tb = voucherTypeRank(b.type);
            if (ta !== tb) return ta - tb;
            const numCmp = (Number(a.number) || 0) - (Number(b.number) || 0);
            return sort.direction === "asc" ? numCmp : -numCmp;
          }
          const av = value(a, sort.key),
            bv = value(b, sort.key),
            result =
              typeof av === "number"
                ? av - Number(bv)
                : sort.key === "number"
                  ? (Number(av) || 0) - (Number(bv) || 0)
                  : String(av).localeCompare(String(bv), undefined, { numeric: true });
          return sort.direction === "asc" ? result : -result;
        }),
    [transactions, filters, sort, selectedLedgerName]
  );
  const filteredTotal = useMemo(
    () => rows.reduce((sum, t) => sum + ledgerSignedAmount(t, selectedLedgerName), 0),
    [rows, selectedLedgerName]
  );

  // Running balance: computed chronologically on all (unfiltered) transactions so that
  // each row always shows its correct cumulative balance regardless of active filters.
  // Running balance: top-to-bottom cumulative sum that adapts to sort direction.
  //
  // Date-ascending  → start at opening, add each row's amount going down.
  //                   Last row reaches closing. Standard bank-statement format.
  //
  // Date-descending → start at closing (top row), subtract each row's amount going down.
  //                   Each row shows the balance before that row's transaction,
  //                   so balance[i] = balance[i-1] − amount[i-1] always holds.
  //                   Last row approaches opening.
  //
  // Both directions: balance[i] flows consistently row-by-row like Excel.
  const balanceMap = useMemo(() => {
    if (openingBalance === undefined || !selectedLedgerName) return null;
    const map = new Map<string, number>();
    if (sort.key === "date" && sort.direction === "desc") {
      const closingBalance = openingBalance +
        transactions.reduce((s, t) => s + ledgerSignedAmount(t, selectedLedgerName), 0);
      let running = closingBalance;
      for (const t of rows) {
        map.set(t.guid, running);
        running -= ledgerSignedAmount(t, selectedLedgerName);
      }
    } else {
      let running = openingBalance;
      for (const t of rows) {
        running += ledgerSignedAmount(t, selectedLedgerName);
        map.set(t.guid, running);
      }
    }
    return map;
  }, [rows, transactions, openingBalance, selectedLedgerName, sort]);
  const heading = (key: SortKey, label: string, right = false) => (
    <th className={right ? "right" : ""}>
      <button
        className="column-sort"
        onClick={() =>
          setSort((current) => ({
            key,
            direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
          }))
        }
      >
        {label}
        <span
          className="sort-mark"
          data-direction={sort.key === key ? sort.direction : "none"}
          aria-hidden="true"
        />
      </button>
    </th>
  );
  const filter = (key: SortKey, placeholder: string) => (
    <input
      aria-label={`Filter ${placeholder}`}
      value={filters[key]}
      onChange={(e) => setFilters((current) => ({ ...current, [key]: e.target.value }))}
      placeholder="All"
    />
  );
  return (
    <div className="excel-table">
      <div className="excel-toolbar">
        <strong>Displayed total: {formatAmount(filteredTotal)}</strong>
        <span>
          {rows.length} of {transactions.length} vouchers
        </span>
        <button
          onClick={() => {
            setFilters({ date: "", type: "", number: "", debit: "", credit: "", narration: "", amount: "" });
            onClearSearch?.();
          }}
        >
          Clear all filters
        </button>
      </div>
      <div
        className="table-scroll top-scroll"
        ref={topScroll}
        onScroll={(e) => {
          if (bottomScroll.current) bottomScroll.current.scrollLeft = e.currentTarget.scrollLeft;
        }}
      >
        <div style={{ width: tableWidth }} />
      </div>
      <div
        className="table-scroll"
        ref={bottomScroll}
        onScroll={(e) => {
          if (topScroll.current) topScroll.current.scrollLeft = e.currentTarget.scrollLeft;
        }}
      >
        <table className="transaction-table">
          <thead>
            <tr>
              {heading("date", "Date")}
              {heading("type", "Type")}
              {heading("number", "#")}
              {heading("debit", "Debit Ledger")}
              {heading("credit", "Credit Ledger")}
              {heading("narration", "Narration")}
              {heading("amount", "Amount", true)}
              {balanceMap && <th className="right balance-col">Balance</th>}
              <th>
                <span className="column-sort column-sort--static">Action</span>
              </th>
            </tr>
            <tr className="column-filters">
              <th>{filter("date", "date")}</th>
              <th>{filter("type", "voucher type")}</th>
              <th>{filter("number", "voucher number")}</th>
              <th>{filter("debit", "debit ledger")}</th>
              <th>{filter("credit", "credit ledger")}</th>
              <th>{filter("narration", "narration")}</th>
              <th>{filter("amount", "amount")}</th>
              {balanceMap && <th className="balance-col" />}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.guid}>
                <td className="date-cell">{t.date.split("-").reverse().join("-")}</td>
                <td>
                  <span className={`pill ${t.cancelled ? "cancelled" : ""}`}>
                    {t.type}
                    {t.cancelled ? " - Cancelled" : ""}
                  </span>
                </td>
                <td>
                  <button className="voucher-reference" onClick={() => onView(t)}>
                    {t.number || "-"}
                  </button>
                </td>
                <td>{debit(t)}</td>
                <td>{credit(t)}</td>
                <td>{text(t.narration) || "-"}</td>
                <td className="right">{formatAmount(ledgerSignedAmount(t, selectedLedgerName))}</td>
                {balanceMap && (
                  <td className="right balance-col balance-running">
                    {formatAmount(balanceMap.get(t.guid) ?? 0)}
                  </td>
                )}
                <td>
                  <details className="action-menu">
                    <summary
                      aria-label={`Actions for ${t.type} voucher ${t.number}`}
                      title="Voucher actions"
                    >
                      <i className="dot edit-dot" />
                      <i className="dot copy-dot" />
                      <i className="dot delete-dot" />
                    </summary>
                    <div className="action-popover">
                      {!t.cancelled && (
                        <button
                          className="edit-voucher"
                          onClick={(e) => {
                            onEdit(t);
                            (
                              e.currentTarget.closest("details") as HTMLDetailsElement
                            )?.removeAttribute("open");
                          }}
                        >
                          Edit
                        </button>
                      )}
                      <button
                        className="copy-voucher"
                        onClick={(e) => {
                          onCopy(t);
                          (
                            e.currentTarget.closest("details") as HTMLDetailsElement
                          )?.removeAttribute("open");
                        }}
                      >
                        Copy
                      </button>
                      <button
                        className="delete-voucher"
                        onClick={(e) => {
                          onDelete(t);
                          (
                            e.currentTarget.closest("details") as HTMLDetailsElement
                          )?.removeAttribute("open");
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={6}>Displayed voucher total</th>
              <th className="right">{formatAmount(filteredTotal)}</th>
              {balanceMap && <th className="balance-col" />}
              <th />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
