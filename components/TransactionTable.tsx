"use client";
import { useMemo, useState } from "react";
import { ThemeProvider } from "@mui/material/styles";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import { DataGrid, type GridColDef, type GridSortModel } from "@mui/x-data-grid";
import { appMuiTheme } from "@/lib/mui-theme";

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

// Rendered inside a DataGrid cell (overflow: hidden), so the popover must be a portal-based
// MUI Menu rather than the app's usual <details>/<summary> dropdown -- that pattern relies on
// overflowing its container, which a grid cell clips.
function ActionMenuCell({
  t,
  closed,
  onEdit,
  onCopy,
  onDelete,
}: {
  t: VoucherRow;
  closed: boolean;
  onEdit: (t: VoucherRow) => void;
  onCopy: (t: VoucherRow) => void;
  onDelete: (t: VoucherRow) => void;
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const close = () => setAnchorEl(null);
  return (
    <>
      <button
        className="action-menu-trigger"
        aria-label={`Actions for ${t.type} voucher ${t.number}`}
        title="Voucher actions"
        onClick={(e) => setAnchorEl(e.currentTarget)}
      >
        <i className="dot edit-dot" />
        <i className="dot copy-dot" />
        <i className="dot delete-dot" />
      </button>
      <Menu anchorEl={anchorEl} open={!!anchorEl} onClose={close}>
        {!t.cancelled && !closed && (
          <MenuItem
            className="edit-voucher"
            onClick={() => {
              onEdit(t);
              close();
            }}
          >
            Edit
          </MenuItem>
        )}
        <MenuItem
          className="copy-voucher"
          onClick={() => {
            onCopy(t);
            close();
          }}
        >
          Copy
        </MenuItem>
        {!closed && (
          <MenuItem
            className="delete-voucher"
            onClick={() => {
              onDelete(t);
              close();
            }}
          >
            Delete
          </MenuItem>
        )}
        {closed && <MenuItem disabled className="period-closed-note">Period closed — read-only</MenuItem>}
      </Menu>
    </>
  );
}

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
  closedPeriods,
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
  // Edit/Delete are hidden (not just blocked at save time) for a voucher dated in one of these
  // "YYYY-MM" periods -- see isPeriodClosed in lib/vault-accounting.ts, same source of truth
  // the actual save-time enforcement uses.
  closedPeriods?: string[];
}) {
  const isClosed = (t: VoucherRow) => !!closedPeriods?.includes(t.date.slice(0, 7));
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

  const gridRows = useMemo(
    () =>
      rows.map((t) => ({
        id: t.guid,
        voucher: t,
        date: t.date,
        type: t.type,
        number: t.number,
        debit: debit(t),
        credit: credit(t),
        narration: text(t.narration) || "-",
        amount: ledgerSignedAmount(t, selectedLedgerName),
        balance: balanceMap?.get(t.guid) ?? null,
      })),
    [rows, selectedLedgerName, balanceMap]
  );

  const filterField = (key: SortKey, label: string, placeholder: string) => (
    <label key={key}>
      {label}
      <input
        aria-label={`Filter ${placeholder}`}
        value={filters[key]}
        onChange={(e) => setFilters((current) => ({ ...current, [key]: e.target.value }))}
        placeholder="All"
      />
    </label>
  );

  const columns: GridColDef<(typeof gridRows)[number]>[] = [
    {
      field: "date",
      headerName: "Date",
      width: 100,
      valueFormatter: (v: string) => v.split("-").reverse().join("-"),
    },
    {
      field: "type",
      headerName: "Type",
      width: 130,
      renderCell: (params) => (
        <span className={`pill ${params.row.voucher.cancelled ? "cancelled" : ""}`}>
          {params.row.type}
          {params.row.voucher.cancelled ? " - Cancelled" : ""}
        </span>
      ),
    },
    {
      field: "number",
      headerName: "#",
      width: 70,
      renderCell: (params) => (
        <button className="voucher-reference" onClick={() => onView(params.row.voucher)}>
          {params.row.number || "-"}
        </button>
      ),
    },
    { field: "debit", headerName: "Debit Ledger", flex: 1.1, minWidth: 140 },
    { field: "credit", headerName: "Credit Ledger", flex: 1.1, minWidth: 140 },
    { field: "narration", headerName: "Narration", flex: 1.6, minWidth: 180 },
    {
      field: "amount",
      headerName: "Amount",
      type: "number",
      width: 130,
      valueFormatter: (v: number) => formatAmount(v),
    },
    ...(balanceMap
      ? ([
          {
            field: "balance",
            headerName: "Balance",
            type: "number",
            width: 130,
            valueFormatter: (v: number | null) => (v === null ? "" : formatAmount(v)),
          },
        ] as GridColDef<(typeof gridRows)[number]>[])
      : []),
    {
      field: "action",
      headerName: "Action",
      width: 90,
      sortable: false,
      filterable: false,
      disableColumnMenu: true,
      renderCell: (params) => (
        <ActionMenuCell
          t={params.row.voucher}
          closed={isClosed(params.row.voucher)}
          onEdit={onEdit}
          onCopy={onCopy}
          onDelete={onDelete}
        />
      ),
    },
  ];

  const sortModel: GridSortModel = [{ field: sort.key, sort: sort.direction }];

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
      <div className="table-filters">
        {filterField("date", "Date", "date")}
        {filterField("type", "Type", "voucher type")}
        {filterField("number", "#", "voucher number")}
        {filterField("debit", "Debit Ledger", "debit ledger")}
        {filterField("credit", "Credit Ledger", "credit ledger")}
        {filterField("narration", "Narration", "narration")}
        {filterField("amount", "Amount", "amount")}
      </div>
      <ThemeProvider theme={appMuiTheme}>
        <DataGrid
          rows={gridRows}
          columns={columns}
          density="compact"
          disableRowSelectionOnClick
          disableColumnFilter
          hideFooterSelectedRowCount
          sortingMode="server"
          sortingOrder={["asc", "desc"]}
          sortModel={sortModel}
          onSortModelChange={(model) => {
            const next = model[0];
            if (!next?.sort) return;
            setSort({ key: next.field as SortKey, direction: next.sort });
          }}
          slots={{
            footer: () => (
              <div className="ledger-grid-totals">
                <strong>Displayed voucher total</strong>
                <span>{formatAmount(filteredTotal)}</span>
              </div>
            ),
          }}
          autoHeight
        />
      </ThemeProvider>
    </div>
  );
}
