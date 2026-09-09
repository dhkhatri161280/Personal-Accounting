"use client";
import { useMemo, useState } from "react";
import { ThemeProvider } from "@mui/material/styles";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import { DataGrid, GridPagination, type GridColDef, type GridSortModel } from "@mui/x-data-grid";
import { appMuiTheme } from "@/lib/mui-theme";
import { fiscalYearOf } from "@/lib/vault-accounting";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";

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
type SortKey = "date" | "type" | "number" | "debit" | "credit" | "narration" | "amount" | "debitAmount" | "creditAmount";

// Single source of truth for column sizing, shared by the DataGrid's own columns AND the
// filter-input row above it (via FILTER_GRID_TEMPLATE below), so the two rows always line up.
// Date/Type/#/Amount don't need to grow, so they stay fixed px; Debit/Credit/Narration flex to
// fill whatever room is left, same as a normal responsive table -- on a wide screen the earlier
// all-fixed-width layout left a large empty gap on the right instead of using it. CSS Grid's
// `fr` unit and MUI DataGrid's `flex` column sizing compute track widths the same way (fixed
// tracks take their width, remaining space splits by weight, minmax floors each flexible track),
// which is what keeps a CSS Grid filter row and a DataGrid pixel-aligned even though one uses
// `fr` and the other uses `flex`.
type ColSpec = { width: number } | { flex: number; minWidth: number };
const COLUMN_SPECS: Record<SortKey, ColSpec> = {
  date: { width: 100 },
  type: { width: 120 },
  number: { width: 64 },
  debit: { flex: 1, minWidth: 170 },
  credit: { flex: 1, minWidth: 170 },
  narration: { flex: 1.6, minWidth: 220 },
  amount: { width: 120 },
  debitAmount: { width: 100 },
  creditAmount: { width: 100 },
};
const DEBIT_CREDIT_AMOUNT_COL_WIDTH = 100;
const BALANCE_COL_WIDTH = 120;
const ACTION_COL_WIDTH = 84;

const gridTrack = (spec: ColSpec) =>
  "width" in spec ? `${spec.width}px` : `minmax(${spec.minWidth}px, ${spec.flex}fr)`;
const FILTER_KEYS: SortKey[] = ["date", "type", "number", "debit", "credit", "narration", "amount"];
const FILTER_GRID_TEMPLATE = FILTER_KEYS.map((k) => gridTrack(COLUMN_SPECS[k])).join(" ");

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
// SAP/Oracle-style split of the one signed amount into its Debit/Credit side -- only meaningful
// once a specific ledger is selected (ledgerSignedAmount's Dr=positive/Cr=negative convention);
// without one, every voucher's debit total always equals its credit total by construction, so a
// split would just duplicate the same number in both columns.
const ledgerDebitAmount = (t: VoucherRow, selectedLedgerName?: string) => {
  const v = ledgerSignedAmount(t, selectedLedgerName);
  return v > 0.004 ? v : null;
};
const ledgerCreditAmount = (t: VoucherRow, selectedLedgerName?: string) => {
  const v = ledgerSignedAmount(t, selectedLedgerName);
  return v < -0.004 ? Math.abs(v) : null;
};

type SubtotalPeriod = "none" | "date" | "month" | "quarter" | "year";
// Groups by calendar period, not fiscal -- matches how every other date grouping in this app
// (the FY/month pickers aside) already reads a plain YYYY-MM-DD date.
// Fiscal quarter within fiscalYearOf's Apr-Mar year (see lib/vault-accounting.ts): Q1=Apr-Jun,
// Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar -- shifts the calendar month so April lands on 1 before
// taking the usual ceil(month/3).
function fiscalQuarterOf(calendarMonth: number): number {
  const fiscalMonth = ((calendarMonth - 4 + 12) % 12) + 1;
  return Math.ceil(fiscalMonth / 3);
}
function periodKey(dateIso: string, period: SubtotalPeriod): string {
  const [y, m] = dateIso.split("-");
  if (period === "date") return dateIso;
  if (period === "month") return `${y}-${m}`;
  // Quarter and Year follow this app's own fiscal year (Apr-Mar, see fiscalYearOf) rather than
  // the calendar year -- matching the FY labels used everywhere else in the app (e.g. the Periods
  // screen), a September voucher belongs to FY <year>'s Q2, not calendar Q3.
  const fy = fiscalYearOf(dateIso);
  if (period === "quarter") return `FY${fy}-Q${fiscalQuarterOf(Number(m))}`;
  return `FY${fy}`;
}
function periodLabel(dateIso: string, period: SubtotalPeriod): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  if (period === "date") return `${String(d).padStart(2, "0")}-${String(m).padStart(2, "0")}-${y}`;
  if (period === "month") return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
  const fy = fiscalYearOf(dateIso);
  if (period === "quarter") return `Q${fiscalQuarterOf(m)} FY${fy}`;
  return `FY ${fy} (Apr ${fy} - Mar ${fy + 1})`;
}

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
  virtualized,
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
  // Opt-in for a large, standalone list (Day Book) -- starts the page size at the MIT/Community
  // DataGrid's own maximum (100; a larger pageSize literally throws "You need to upgrade to
  // DataGridPro/Premium" -- confirmed directly, this is a hard product-tier limit, not something
  // configurable away) instead of a smaller default sized for a FloatingWindow drill-down's
  // handful of rows. The real fix for "Day Book stops early" wasn't this flag at all, though --
  // it was that the custom `footer` slot below fully replaced DataGrid's default footer,
  // including its Prev/Next page controls, leaving pagination fully ACTIVE but with no visible
  // way to reach page 2+. The footer now renders <GridPagination /> alongside the totals so every
  // page is reachable regardless of row count.
  virtualized?: boolean;
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
    debitAmount: "",
    creditAmount: "",
  });
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({
    key: "date",
    direction: "desc",
  });
  // Sub-totaling a ledger by period only makes sense in chronological order -- picking a period
  // other than "None" forces the sort to Date (keeping whichever direction was already active) so
  // each period's rows land contiguously; sorting by any other column while sub-totaled would
  // scatter one period's rows across the table and break the grouping.
  const [subtotalPeriod, setSubtotalPeriod] = useState<SubtotalPeriod>("none");
  // Collapsed by default -- a period only expands into its individual vouchers once its own
  // header row is clicked. Keyed by periodKey, so switching between e.g. Monthly and Quarterly
  // starts every group fresh rather than carrying over stale keys from a different bucketing.
  const [expandedPeriods, setExpandedPeriods] = useState<Set<string>>(new Set());
  const changeSubtotal = (next: SubtotalPeriod) => {
    setSubtotalPeriod(next);
    setExpandedPeriods(new Set());
    if (next !== "none") setSort((s) => ({ ...s, key: "date" }));
  };
  const value = (t: VoucherRow, key: SortKey): string | number =>
    key === "debit"
      ? debit(t)
      : key === "credit"
        ? credit(t)
        : key === "amount"
          ? ledgerSignedAmount(t, selectedLedgerName)
          : key === "debitAmount"
            ? (ledgerDebitAmount(t, selectedLedgerName) ?? 0)
            : key === "creditAmount"
              ? (ledgerCreditAmount(t, selectedLedgerName) ?? 0)
              : key === "narration"
                ? text(t.narration)
                : String(t[key as keyof VoucherRow] || "");
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
        debitAmount: ledgerDebitAmount(t, selectedLedgerName),
        creditAmount: ledgerCreditAmount(t, selectedLedgerName),
        balance: balanceMap?.get(t.guid) ?? null,
      })),
    [rows, selectedLedgerName, balanceMap]
  );
  type Row = (typeof gridRows)[number] & { isSubtotal?: boolean; isGroupHeader?: boolean; periodKeyValue?: string };

  // One collapsed header row per period, summing that period's Dr/Cr and showing its real closing
  // balance -- clicking a header row (see the DataGrid's onRowClick below) toggles it open to
  // reveal that period's individual vouchers directly beneath it, collapsed again on a second
  // click. Rows are already grouped correctly because changeSubtotal forces Date sort whenever a
  // period is active. Only available once there's a real running balance to report as the
  // period's closing figure.
  const displayRows: Row[] = useMemo(() => {
    if (subtotalPeriod === "none" || !balanceMap) return gridRows;
    const isAsc = sort.direction === "asc";
    const out: Row[] = [];
    let i = 0;
    while (i < gridRows.length) {
      const key = periodKey(gridRows[i].date, subtotalPeriod);
      let drSum = 0;
      let crSum = 0;
      let j = i;
      while (j < gridRows.length && periodKey(gridRows[j].date, subtotalPeriod) === key) {
        drSum += gridRows[j].debitAmount ?? 0;
        crSum += gridRows[j].creditAmount ?? 0;
        j++;
      }
      const count = j - i;
      // balanceMap is already correct in either sort direction -- the row bordering the "later"
      // edge of this run holds the period's true closing balance: the last row when ascending
      // (latest date is last), the first row when descending (latest date is first).
      const edgeRow = isAsc ? gridRows[j - 1] : gridRows[i];
      const expanded = expandedPeriods.has(key);
      out.push({
        ...edgeRow,
        id: `group-${key}`,
        isSubtotal: true,
        isGroupHeader: true,
        periodKeyValue: key,
        date: "",
        type: "",
        number: "",
        debit: "",
        credit: "",
        narration: `${expanded ? "−" : "+"} ${periodLabel(edgeRow.date, subtotalPeriod)} (${count} voucher${count === 1 ? "" : "s"})`,
        amount: drSum - crSum,
        debitAmount: drSum > 0.004 ? drSum : null,
        creditAmount: crSum > 0.004 ? crSum : null,
        balance: edgeRow.balance,
      });
      if (expanded) {
        for (let k = i; k < j; k++) out.push(gridRows[k]);
      }
      i = j;
    }
    return out;
  }, [gridRows, subtotalPeriod, sort.direction, balanceMap, expandedPeriods]);

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

  const columns: GridColDef<Row>[] = [
    {
      field: "date",
      headerName: "Date",
      ...COLUMN_SPECS.date,
      valueFormatter: (v: string) => v.split("-").reverse().join("-"),
    },
    {
      field: "type",
      headerName: "Type",
      ...COLUMN_SPECS.type,
      renderCell: (params) =>
        params.row.isSubtotal ? null : (
          <span className={`pill ${params.row.voucher.cancelled ? "cancelled" : ""}`}>
            {params.row.type}
            {params.row.voucher.cancelled ? " - Cancelled" : ""}
          </span>
        ),
    },
    {
      field: "number",
      headerName: "#",
      ...COLUMN_SPECS.number,
      renderCell: (params) =>
        params.row.isSubtotal ? null : (
          <button className="voucher-reference" onClick={() => onView(params.row.voucher)}>
            {params.row.number || "-"}
          </button>
        ),
    },
    { field: "debit", headerName: "Debit Ledger", ...COLUMN_SPECS.debit },
    { field: "credit", headerName: "Credit Ledger", ...COLUMN_SPECS.credit },
    { field: "narration", headerName: "Narration", ...COLUMN_SPECS.narration },
    // SAP/Oracle-style two-column split (Debit Amount / Credit Amount, one populated per row) --
    // only meaningful once a specific ledger is selected, since that's what gives "debit" and
    // "credit" a fixed side; the general Day Book (no ledger selected) keeps the single Amount
    // column, since every voucher's debit total always equals its credit total there.
    ...(selectedLedgerName
      ? ([
          {
            field: "debitAmount",
            headerName: "Dr Amount",
            type: "number",
            width: DEBIT_CREDIT_AMOUNT_COL_WIDTH,
            valueFormatter: (v: number | null) => (v === null ? "" : formatAmount(v)),
          },
          {
            field: "creditAmount",
            headerName: "Cr Amount",
            type: "number",
            width: DEBIT_CREDIT_AMOUNT_COL_WIDTH,
            valueFormatter: (v: number | null) => (v === null ? "" : formatAmount(v)),
          },
        ] as GridColDef<Row>[])
      : ([
          {
            field: "amount",
            headerName: "Amount",
            type: "number",
            ...COLUMN_SPECS.amount,
            valueFormatter: (v: number) => formatAmount(v),
          },
        ] as GridColDef<Row>[])),
    ...(balanceMap
      ? ([
          {
            field: "balance",
            headerName: "Balance",
            type: "number",
            width: BALANCE_COL_WIDTH,
            valueFormatter: (v: number | null) => (v === null ? "" : formatAmount(v)),
          },
        ] as GridColDef<Row>[])
      : []),
    {
      field: "action",
      headerName: "Action",
      width: ACTION_COL_WIDTH,
      sortable: false,
      filterable: false,
      disableColumnMenu: true,
      renderCell: (params) =>
        params.row.isSubtotal ? null : (
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

  // Plain-table sort header, used only in `virtualized` mode (see below) -- DataGrid's own
  // sortModel/onSortModelChange only makes sense wired to an actual <DataGrid>.
  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, direction: s.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" }));
  }
  function sortArrow(key: SortKey) {
    return sort.key === key ? <span className="plain-table-sort-arrow">{sort.direction === "asc" ? " ▲" : " ▼"}</span> : null;
  }

  // Exports the currently filtered/sorted rows (not the collapsed Sub-total grouping -- Excel
  // itself can subtotal/pivot, and a flat transaction list is more useful pasted elsewhere than a
  // pre-collapsed one). Same column set as the on-screen table, split Dr/Cr amounts included when
  // a ledger is selected, otherwise the single Amount column, plus Balance when there's a running
  // balance to report.
  async function exportRows() {
    const header = ["Date", "Type", "#", "Debit Ledger", "Credit Ledger", "Narration"];
    if (selectedLedgerName) header.push("Dr Amount", "Cr Amount");
    else header.push("Amount");
    if (balanceMap) header.push("Balance");
    const body = rows.map((t) => {
      const row: (string | number)[] = [t.date.split("-").reverse().join("-"), t.type, t.number, debit(t), credit(t), text(t.narration)];
      if (selectedLedgerName) row.push(ledgerDebitAmount(t, selectedLedgerName) ?? "", ledgerCreditAmount(t, selectedLedgerName) ?? "");
      else row.push(ledgerSignedAmount(t, selectedLedgerName));
      if (balanceMap) row.push(balanceMap.get(t.guid) ?? "");
      return row;
    });
    await exportWorkbook(`${selectedLedgerName || "Day Book"}.xlsx`, [{ name: (selectedLedgerName || "Vouchers").slice(0, 31), rows: [header, ...body] }]);
  }

  return (
    <div className="excel-table">
      <div className="excel-toolbar">
        <strong>Displayed total: {formatAmount(filteredTotal)}</strong>
        <span>
          {rows.length} of {transactions.length} vouchers
        </span>
        <button
          onClick={() => {
            setFilters({ date: "", type: "", number: "", debit: "", credit: "", narration: "", amount: "", debitAmount: "", creditAmount: "" });
            onClearSearch?.();
          }}
        >
          Clear all filters
        </button>
        <ExportButton onExport={exportRows} />
        {balanceMap && (
          <label style={{ marginLeft: "auto", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
            Sub-total
            <select value={subtotalPeriod} onChange={(e) => changeSubtotal(e.target.value as SubtotalPeriod)}>
              <option value="none">None</option>
              <option value="date">Date</option>
              <option value="month">Monthly</option>
              <option value="quarter">Quarterly</option>
              <option value="year">Yearly</option>
            </select>
          </label>
        )}
      </div>
      <div className="table-filters grid-aligned-filters" style={{ gridTemplateColumns: FILTER_GRID_TEMPLATE }}>
        {filterField("date", "Date", "date")}
        {filterField("type", "Type", "voucher type")}
        {filterField("number", "#", "voucher number")}
        {filterField("debit", "Debit Ledger", "debit ledger")}
        {filterField("credit", "Credit Ledger", "credit ledger")}
        {filterField("narration", "Narration", "narration")}
        {filterField("amount", "Amount", "amount")}
      </div>
      {virtualized ? (
        // A large standalone list (Day Book) wants genuine "scroll to see everything," not
        // click-through paging -- but MIT/Community DataGrid hard-caps pageSize at 100 (a larger
        // value throws outright: "You need to upgrade to DataGridPro/Premium", confirmed directly
        // against a live reproduction) and `pagination` itself can't be turned off in the free
        // tier (it's in DataGrid's own DataGridForcedPropsKey list). So this renders every row as
        // a plain, ordinary <table> instead -- no page-size ceiling to hit, no virtualization
        // math to get wrong, just a native scrollbar over real rendered rows. A few hundred rows
        // is trivial for a browser; this app doesn't need DataGrid's paid-tier features here
        // (subtotal grouping and the running-balance column, both DataGrid-rendered above, are
        // never used in Day Book -- no selectedLedgerName/openingBalance is passed for it).
        <div className="plain-voucher-table-scroll">
          <table className="plain-voucher-table">
            {/* Fixed proportions instead of content-width auto-sizing, matching the Tally-style
                Day Book convention already used throughout this app (see the DataGrid column's
                own COLUMN_SPECS above): Debit/Credit Ledger stay compact, Narration -- the column
                someone actually reads -- gets the most room, not whatever's left over. */}
            <colgroup>
              <col style={{ width: "95px" }} />
              <col style={{ width: "90px" }} />
              <col style={{ width: "55px" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "auto" }} />
              <col style={{ width: "95px" }} />
              <col style={{ width: "50px" }} />
            </colgroup>
            <thead>
              <tr>
                <th onClick={() => toggleSort("date")}>Date{sortArrow("date")}</th>
                <th onClick={() => toggleSort("type")}>Type{sortArrow("type")}</th>
                <th onClick={() => toggleSort("number")}>#{sortArrow("number")}</th>
                <th onClick={() => toggleSort("debit")}>Debit Ledger{sortArrow("debit")}</th>
                <th onClick={() => toggleSort("credit")}>Credit Ledger{sortArrow("credit")}</th>
                <th onClick={() => toggleSort("narration")}>Narration{sortArrow("narration")}</th>
                <th className="right" onClick={() => toggleSort("amount")}>Amount{sortArrow("amount")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.guid}>
                  <td>{t.date.split("-").reverse().join("-")}</td>
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
                  <td title={debit(t)}>{debit(t)}</td>
                  <td title={credit(t)}>{credit(t)}</td>
                  <td>{text(t.narration) || "-"}</td>
                  <td className="right">{formatAmount(ledgerSignedAmount(t, selectedLedgerName))}</td>
                  <td>
                    <ActionMenuCell t={t} closed={isClosed(t)} onEdit={onEdit} onCopy={onCopy} onDelete={onDelete} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={6}>Displayed voucher total</th>
                <th className="right">{formatAmount(filteredTotal)}</th>
                <th></th>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
      <ThemeProvider theme={appMuiTheme}>
        <DataGrid
          rows={displayRows}
          columns={columns}
          density="compact"
          disableRowSelectionOnClick
          disableColumnFilter
          hideFooterSelectedRowCount
          pageSizeOptions={[10, 25, 50, 100]}
          initialState={{ pagination: { paginationModel: { pageSize: 25 } } }}
          getRowClassName={(params) => (params.row.isSubtotal ? "ledger-subtotal-row" : "")}
          onRowClick={(params) => {
            if (!params.row.isGroupHeader) return;
            const key = params.row.periodKeyValue as string;
            setExpandedPeriods((prev) => {
              const next = new Set(prev);
              next.has(key) ? next.delete(key) : next.add(key);
              return next;
            });
          }}
          sortingMode="server"
          sortingOrder={["asc", "desc"]}
          sortModel={sortModel}
          onSortModelChange={(model) => {
            const next = model[0];
            if (!next?.sort) return;
            setSort({ key: next.field as SortKey, direction: next.sort });
          }}
          slots={{
            // Replacing DataGrid's default footer entirely (rather than just adding to it) is
            // what silently disabled page navigation in the first place -- <GridPagination />
            // restores the real Prev/Next/page-size controls the default footer would have had,
            // alongside the totals summary this app actually wants shown too.
            footer: () => (
              <div className="ledger-grid-totals">
                <strong>Displayed voucher total</strong>
                <span>{formatAmount(filteredTotal)}</span>
                <GridPagination />
              </div>
            ),
          }}
          autoHeight
        />
      </ThemeProvider>
      )}
    </div>
  );
}
