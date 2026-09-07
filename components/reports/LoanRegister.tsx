"use client";
import { useState } from "react";
import type { Ledger, Loan } from "@/lib/vault-types";
import { standardMonthlyPayment, computePaymentSplit } from "@/lib/loans";
import { getOrCreateLoanAccount, getOrCreateExpenseAccount, currentLoanBalance, recordLoanPayment } from "@/lib/loans-ledger";

export function LoanRegister({
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
  const [principal, setPrincipal] = useState("");
  const [ratePct, setRatePct] = useState("");
  const [termMonths, setTermMonths] = useState("60");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [payment, setPayment] = useState("");
  const [expenseAcctId, setExpenseAcctId] = useState<number | "">("");
  const [newExpenseAcctName, setNewExpenseAcctName] = useState("");
  const [saving, setSaving] = useState(false);

  const [payingId, setPayingId] = useState<string | null>(null);
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentCashAcctId, setPaymentCashAcctId] = useState<number | "">("");

  const loans = (data.loans ?? []).slice().sort((a, b) => a.startDate.localeCompare(b.startDate));
  const todayStr = new Date().toISOString().slice(0, 10);

  const expenseAccounts = data.accounts
    .filter((a) => a.active !== false && a.category === "Expense")
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const cashAccounts = data.accounts
    .filter((a) => a.active !== false)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const suggestedPayment =
    Number(principal) > 0 && Number(termMonths) > 0
      ? standardMonthlyPayment(Number(principal), (Number(ratePct) || 0) / 100, Number(termMonths))
      : 0;

  async function addLoan() {
    const principalNum = Number(principal);
    const termNum = Number(termMonths);
    const rateNum = (Number(ratePct) || 0) / 100;
    const paymentNum = Number(payment) || suggestedPayment;
    if (!name.trim() || !principalNum || principalNum <= 0 || !termNum || termNum <= 0 || !paymentNum) return;
    if (!newExpenseAcctName.trim() && expenseAcctId === "") return;
    setSaving(true);
    try {
      let working = data;
      let interestExpenseAccountId: number;
      if (newExpenseAcctName.trim()) {
        const { data: withAcct, account } = getOrCreateExpenseAccount(working, newExpenseAcctName.trim());
        working = withAcct;
        interestExpenseAccountId = account.id;
      } else {
        interestExpenseAccountId = expenseAcctId as number;
      }
      const { data: withLoanAcct, account } = getOrCreateLoanAccount(working, name.trim(), principalNum, startDate);
      working = withLoanAcct;
      const loan: Loan = {
        id: crypto.randomUUID(),
        name: name.trim(),
        accountId: account.id,
        interestExpenseAccountId,
        originalPrincipal: principalNum,
        annualRate: rateNum,
        termMonths: termNum,
        startDate,
        standardPayment: paymentNum,
      };
      const next: Ledger = { ...working, loans: [...(working.loans ?? []), loan] };
      const ok = await onSave(next);
      if (ok) {
        setShowAdd(false);
        setName("");
        setPrincipal("");
        setRatePct("");
        setTermMonths("60");
        setPayment("");
        setExpenseAcctId("");
        setNewExpenseAcctName("");
      }
    } finally {
      setSaving(false);
    }
  }

  function openPayFor(loan: Loan) {
    setPayingId(loan.id);
    setPaymentAmount(String(loan.standardPayment));
    setPaymentDate(todayStr);
    setPaymentCashAcctId("");
  }

  async function confirmPayment(loanId: string) {
    if (paymentCashAcctId === "" || !Number(paymentAmount)) return;
    setSaving(true);
    try {
      const result = recordLoanPayment(data, loanId, paymentDate, Number(paymentAmount), paymentCashAcctId);
      if ("data" in result) {
        const ok = await onSave(result.data);
        if (ok) setPayingId(null);
      }
    } finally {
      setSaving(false);
    }
  }

  const payingLoan = loans.find((l) => l.id === payingId);
  const paymentPreview =
    payingLoan && Number(paymentAmount)
      ? computePaymentSplit(currentLoanBalance(data, payingLoan, paymentDate), payingLoan.annualRate, Number(paymentAmount))
      : null;

  return (
    <div className="data-panel">
      <h3>Loan / Debt Register</h3>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px" }}>
        Each loan gets its own liability account under "Loans (Liability)". A loan payment is a real cash event, not a backfillable
        accrual, so record each payment as it happens — the principal/interest split is computed from the current balance.
      </p>
      <div className="master-toolbar">
        <button type="button" className="tr-refresh-btn" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? "Cancel" : "+ Add Loan"}
        </button>
      </div>

      {showAdd && (
        <div className="report-line" style={{ flexWrap: "wrap", gap: 8 }}>
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            placeholder="Principal"
            type="number"
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
            style={{ width: 100 }}
          />
          <input
            placeholder="Rate %"
            type="number"
            value={ratePct}
            onChange={(e) => setRatePct(e.target.value)}
            style={{ width: 80 }}
          />
          <input
            placeholder="Term (months)"
            type="number"
            value={termMonths}
            onChange={(e) => setTermMonths(e.target.value)}
            style={{ width: 120 }}
          />
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <input
            placeholder={suggestedPayment ? `Payment (suggested ${fmt(suggestedPayment)})` : "Monthly payment"}
            type="number"
            value={payment}
            onChange={(e) => setPayment(e.target.value)}
            style={{ width: 180 }}
          />
          <select
            value={expenseAcctId}
            onChange={(e) => {
              setExpenseAcctId(e.target.value ? Number(e.target.value) : "");
              if (e.target.value) setNewExpenseAcctName("");
            }}
          >
            <option value="">Interest expense category…</option>
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
          <button type="button" className="tr-refresh-btn" disabled={saving} onClick={addLoan}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}

      {loans.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No loans yet. Add one above to start tracking payments.</p>
      ) : (
        <div className="columnar-report-scroll">
          <table className="columnar-report-table budget-table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="right">Principal</th>
                <th className="right">Rate</th>
                <th className="right">Term</th>
                <th className="right">Current Balance</th>
                <th className="right">Payment</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loans.map((l) => {
                const balance = currentLoanBalance(data, l, todayStr);
                return (
                  <tr key={l.id}>
                    <td>{l.name}</td>
                    <td className="right">{fmt(l.originalPrincipal)}</td>
                    <td className="right">{(l.annualRate * 100).toFixed(2)}%</td>
                    <td className="right">{l.termMonths} mo</td>
                    <td className="right">{fmt(balance)}</td>
                    <td className="right">{fmt(l.standardPayment)}</td>
                    <td>
                      {l.closed ? (
                        <span style={{ opacity: 0.6, fontSize: 12 }}>Closed {l.closed.date}</span>
                      ) : (
                        <span style={{ color: "#16a34a", fontSize: 12 }}>Active</span>
                      )}
                    </td>
                    <td>
                      {!l.closed &&
                        (payingId === l.id ? (
                          <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                            <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} style={{ width: 120 }} />
                            <input
                              placeholder="Amount"
                              type="number"
                              value={paymentAmount}
                              onChange={(e) => setPaymentAmount(e.target.value)}
                              style={{ width: 90 }}
                            />
                            <select value={paymentCashAcctId} onChange={(e) => setPaymentCashAcctId(e.target.value ? Number(e.target.value) : "")}>
                              <option value="">Paid from…</option>
                              {cashAccounts.map((acc) => (
                                <option key={acc.id} value={acc.id}>
                                  {acc.name}
                                </option>
                              ))}
                            </select>
                            {paymentPreview && (
                              <span style={{ fontSize: 11, opacity: 0.7 }}>
                                Principal {fmt(paymentPreview.principal)} · Interest {fmt(paymentPreview.interest)}
                              </span>
                            )}
                            <button type="button" className="tr-refresh-btn" disabled={saving} onClick={() => confirmPayment(l.id)}>
                              Confirm
                            </button>
                            <button type="button" className="tr-refresh-btn" onClick={() => setPayingId(null)}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button type="button" className="tr-refresh-btn" onClick={() => openPayFor(l)}>
                            Record Payment
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
