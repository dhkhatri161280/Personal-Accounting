"use client";
import { useState } from "react";
import type { Ledger, PrepaidExpense } from "@/lib/vault-types";
import { monthlyAmortization, amortizedToDate, remainingBalance } from "@/lib/prepaid-expense";
import { getOrCreatePrepaidAccount, getOrCreateExpenseAccount, postAmortization, writeOffPrepaid } from "@/lib/prepaid-expense-ledger";
import { exportWorkbook } from "@/lib/export-excel";
import { ExportButton } from "@/components/ExportButton";

export function PrepaidExpenseRegister({
  data,
  fmt,
  onSave,
}: {
  data: Ledger;
  fmt: (n: number) => string;
  onSave: (next: Ledger) => Promise<boolean> | boolean;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [termMonths, setTermMonths] = useState("12");
  const [expenseAcctId, setExpenseAcctId] = useState<number | "">("");
  const [newExpenseAcctName, setNewExpenseAcctName] = useState("");
  const [saving, setSaving] = useState(false);
  const [writingOffId, setWritingOffId] = useState<string | null>(null);
  const [writeOffDate, setWriteOffDate] = useState(new Date().toISOString().slice(0, 10));

  const items = (data.prepaidExpenses ?? []).slice().sort((a, b) => a.startDate.localeCompare(b.startDate));
  const todayStr = new Date().toISOString().slice(0, 10);

  // postAmortization is pure (returns a new object, never mutates `data`) -- calling it here just
  // to read `postedCount` for the button label is safe and cheap for a personal-scale register.
  const pendingCount = postAmortization(data, todayStr).postedCount;

  const expenseAccounts = data.accounts
    .filter((a) => a.active !== false && a.category === "Expense")
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  async function addPrepaid() {
    const amountNum = Number(totalAmount);
    const termNum = Number(termMonths);
    if (!name.trim() || !amountNum || amountNum <= 0 || !termNum || termNum <= 0) return;
    if (!newExpenseAcctName.trim() && expenseAcctId === "") return;
    setSaving(true);
    try {
      let working = data;
      let expenseAccountId: number;
      if (newExpenseAcctName.trim()) {
        const { data: withAcct, account } = getOrCreateExpenseAccount(working, newExpenseAcctName.trim());
        working = withAcct;
        expenseAccountId = account.id;
      } else {
        expenseAccountId = expenseAcctId as number;
      }
      const { data: withPrepaidAcct, account } = getOrCreatePrepaidAccount(working, name.trim(), amountNum, startDate);
      working = withPrepaidAcct;
      const item: PrepaidExpense = {
        id: crypto.randomUUID(),
        name: name.trim(),
        accountId: account.id,
        expenseAccountId,
        startDate,
        totalAmount: amountNum,
        termMonths: termNum,
      };
      const next: Ledger = { ...working, prepaidExpenses: [...(working.prepaidExpenses ?? []), item] };
      const ok = await onSave(next);
      if (ok) {
        setShowAdd(false);
        setName("");
        setTotalAmount("");
        setTermMonths("12");
        setExpenseAcctId("");
        setNewExpenseAcctName("");
      }
    } finally {
      setSaving(false);
    }
  }

  async function runAmortization() {
    setSaving(true);
    try {
      const { data: next } = postAmortization(data, todayStr);
      await onSave(next);
    } finally {
      setSaving(false);
    }
  }

  async function confirmWriteOff(id: string) {
    setSaving(true);
    try {
      const result = writeOffPrepaid(data, id, writeOffDate);
      if ("data" in result) {
        const ok = await onSave(result.data);
        if (ok) setWritingOffId(null);
      }
    } finally {
      setSaving(false);
    }
  }

  async function exportItems() {
    const header = ["Name", "Start Date", "Total Amount", "Term (mo)", "Monthly Amort.", "Amortized", "Remaining", "Status"];
    const body = items.map((p) => [
      p.name,
      p.startDate,
      p.totalAmount,
      p.termMonths,
      monthlyAmortization(p),
      amortizedToDate(p, todayStr),
      remainingBalance(p, todayStr),
      p.writtenOff ? `Written off ${p.writtenOff.date}` : "Active",
    ]);
    await exportWorkbook("Prepaid Expense Amortization.xlsx", [{ name: "Prepaid Expenses", rows: [header, ...body] }]);
  }

  return (
    <div className="data-panel">
      <h3>Prepaid Expense Amortization</h3>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px" }}>
        Straight-line amortization only. Each prepaid item gets its own ledger account under "Current Assets". The
        Amortized/Remaining columns below are always live and up to date — no action needed to see them. "Run Amortization" is a
        separate, optional step that <strong>posts real Journal vouchers</strong> for whichever months haven't been posted yet;
        skip it if you only want the numbers for reference.
      </p>
      <div className="master-toolbar">
        <button type="button" className="tr-refresh-btn" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? "Cancel" : "+ Add Prepaid Expense"}
        </button>
        <button type="button" className="tr-refresh-btn" disabled={saving || pendingCount === 0} onClick={runAmortization}>
          {saving ? "Posting…" : pendingCount === 0 ? "Amortization up to date" : `Run Amortization (${pendingCount} pending) — posts vouchers`}
        </button>
        <ExportButton onExport={exportItems} />
      </div>

      {showAdd && (
        <div className="report-line" style={{ flexWrap: "wrap", gap: 8 }}>
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            placeholder="Total amount"
            type="number"
            value={totalAmount}
            onChange={(e) => setTotalAmount(e.target.value)}
            style={{ width: 110 }}
          />
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <input
            placeholder="Term (months)"
            type="number"
            value={termMonths}
            onChange={(e) => setTermMonths(e.target.value)}
            style={{ width: 120 }}
          />
          <select
            value={expenseAcctId}
            onChange={(e) => {
              setExpenseAcctId(e.target.value ? Number(e.target.value) : "");
              if (e.target.value) setNewExpenseAcctName("");
            }}
          >
            <option value="">Expense category…</option>
            {expenseAccounts.map((acc) => (
              <option key={acc.id} value={acc.id}>
                {acc.name}
              </option>
            ))}
          </select>
          <input
            placeholder="or new category name"
            value={newExpenseAcctName}
            onChange={(e) => {
              setNewExpenseAcctName(e.target.value);
              if (e.target.value) setExpenseAcctId("");
            }}
            style={{ width: 160 }}
          />
          <button type="button" className="tr-refresh-btn" disabled={saving} onClick={addPrepaid}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No prepaid expenses yet. Add one above to start tracking amortization.</p>
      ) : (
        <div className="columnar-report-scroll">
          <table className="columnar-report-table budget-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Start Date</th>
                <th className="right">Total Amount</th>
                <th className="right">Term</th>
                <th className="right">Monthly Amort.</th>
                <th className="right">Amortized</th>
                <th className="right">Remaining</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => {
                const monthly = monthlyAmortization(p);
                const amortized = amortizedToDate(p, todayStr);
                const remaining = remainingBalance(p, todayStr);
                return (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{p.startDate}</td>
                    <td className="right">{fmt(p.totalAmount)}</td>
                    <td className="right">{p.termMonths} mo</td>
                    <td className="right">{fmt(monthly)}</td>
                    <td className="right">{fmt(amortized)}</td>
                    <td className="right">{fmt(remaining)}</td>
                    <td>
                      {p.writtenOff ? (
                        <span style={{ opacity: 0.6, fontSize: 12 }}>Written off {p.writtenOff.date}</span>
                      ) : (
                        <span style={{ color: "#16a34a", fontSize: 12 }}>Active</span>
                      )}
                    </td>
                    <td>
                      {!p.writtenOff &&
                        (writingOffId === p.id ? (
                          <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                            <input type="date" value={writeOffDate} onChange={(e) => setWriteOffDate(e.target.value)} style={{ width: 120 }} />
                            <button type="button" className="tr-refresh-btn" disabled={saving} onClick={() => confirmWriteOff(p.id)}>
                              Confirm
                            </button>
                            <button type="button" className="tr-refresh-btn" onClick={() => setWritingOffId(null)}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button type="button" className="tr-refresh-btn" onClick={() => setWritingOffId(p.id)}>
                            Write Off
                          </button>
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
