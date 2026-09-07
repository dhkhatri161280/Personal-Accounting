"use client";
import { Fragment, useState } from "react";
import type { Ledger, Loan } from "@/lib/vault-types";
import { standardMonthlyPayment, computePaymentSplit } from "@/lib/loans";
import { getOrCreateLoanAccount, getOrCreateExpenseAccount, currentLoanBalance, recordLoanPayment } from "@/lib/loans-ledger";
import { computeLoanSchedule } from "@/lib/loan-amortization-schedule";

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
  const [rateValidThrough, setRateValidThrough] = useState("");
  const [expenseAcctId, setExpenseAcctId] = useState<number | "">("");
  const [newExpenseAcctName, setNewExpenseAcctName] = useState("");
  const [saving, setSaving] = useState(false);

  const [scheduleId, setScheduleId] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRatePct, setEditRatePct] = useState("");
  const [editPayment, setEditPayment] = useState("");
  const [editTermMonths, setEditTermMonths] = useState("");
  const [editRateValidThrough, setEditRateValidThrough] = useState("");
  const [editArmEnabled, setEditArmEnabled] = useState(false);
  const [editFirstChangeDate, setEditFirstChangeDate] = useState("");
  const [editChangeIntervalMonths, setEditChangeIntervalMonths] = useState("60");
  const [editFirstChangeCapPct, setEditFirstChangeCapPct] = useState("");
  const [editPeriodicCapPct, setEditPeriodicCapPct] = useState("");
  const [editLifetimeCapPct, setEditLifetimeCapPct] = useState("");
  const [editLifetimeFloorPct, setEditLifetimeFloorPct] = useState("");

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
        ...(rateValidThrough ? { rateValidThrough } : {}),
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
        setRateValidThrough("");
        setExpenseAcctId("");
        setNewExpenseAcctName("");
      }
    } finally {
      setSaving(false);
    }
  }

  function openEditFor(loan: Loan) {
    setEditingId(loan.id);
    setEditRatePct(String(round2Pct(loan.annualRate)));
    setEditPayment(String(loan.standardPayment));
    setEditTermMonths(String(loan.termMonths));
    setEditRateValidThrough(loan.rateValidThrough ?? "");
    setEditArmEnabled(!!loan.rateAdjustment);
    setEditFirstChangeDate(loan.rateAdjustment?.firstChangeDate ?? "");
    setEditChangeIntervalMonths(String(loan.rateAdjustment?.changeIntervalMonths ?? 60));
    setEditFirstChangeCapPct(loan.rateAdjustment ? String(loan.rateAdjustment.firstChangeCapPct) : "");
    setEditPeriodicCapPct(loan.rateAdjustment ? String(loan.rateAdjustment.periodicCapPct) : "");
    setEditLifetimeCapPct(loan.rateAdjustment ? String(loan.rateAdjustment.lifetimeCapPct) : "");
    setEditLifetimeFloorPct(loan.rateAdjustment ? String(loan.rateAdjustment.lifetimeFloorPct) : "");
  }

  function round2Pct(rate: number): number {
    return Math.round(rate * 100 * 100) / 100;
  }

  async function confirmEdit(loanId: string) {
    const rateNum = (Number(editRatePct) || 0) / 100;
    const paymentNum = Number(editPayment);
    const termNum = Number(editTermMonths);
    if (!paymentNum || paymentNum <= 0 || !termNum || termNum <= 0) return;
    const rateAdjustment =
      editArmEnabled && editFirstChangeDate && Number(editChangeIntervalMonths) > 0
        ? {
            firstChangeDate: editFirstChangeDate,
            changeIntervalMonths: Number(editChangeIntervalMonths),
            firstChangeCapPct: Number(editFirstChangeCapPct) || 0,
            periodicCapPct: Number(editPeriodicCapPct) || 0,
            lifetimeCapPct: Number(editLifetimeCapPct) || 0,
            lifetimeFloorPct: Number(editLifetimeFloorPct) || 0,
          }
        : undefined;
    setSaving(true);
    try {
      const updatedLoans = (data.loans ?? []).map((l) =>
        l.id === loanId
          ? {
              ...l,
              annualRate: rateNum,
              standardPayment: paymentNum,
              termMonths: termNum,
              rateValidThrough: editRateValidThrough || undefined,
              rateAdjustment,
            }
          : l
      );
      const ok = await onSave({ ...data, loans: updatedLoans });
      if (ok) setEditingId(null);
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
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
            Rate valid through (ARM, optional)
            <input type="date" value={rateValidThrough} onChange={(e) => setRateValidThrough(e.target.value)} />
          </label>
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
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loans.map((l) => {
                const balance = currentLoanBalance(data, l, todayStr);
                const showSchedule = scheduleId === l.id;
                const schedule = showSchedule ? computeLoanSchedule(data, l, todayStr) : null;
                const isEditing = editingId === l.id;
                return (
                  <Fragment key={l.id}>
                  <tr>
                    <td>{l.name}</td>
                    <td className="right">{fmt(l.originalPrincipal)}</td>
                    <td className="right">
                      {(l.annualRate * 100).toFixed(2)}%
                      {l.rateValidThrough && (
                        <div style={{ fontSize: 10, opacity: 0.6 }}>through {l.rateValidThrough}</div>
                      )}
                    </td>
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
                      <button type="button" className="tr-refresh-btn" onClick={() => setScheduleId(showSchedule ? null : l.id)}>
                        {showSchedule ? "Hide Schedule" : "Amortization Schedule"}
                      </button>
                    </td>
                    <td>
                      <button type="button" className="tr-refresh-btn" onClick={() => (isEditing ? setEditingId(null) : openEditFor(l))}>
                        {isEditing ? "Cancel Edit" : "Edit Terms"}
                      </button>
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
                  {isEditing && (
                    <tr>
                      <td colSpan={10} style={{ padding: 0 }}>
                        <div style={{ padding: "10px 12px", background: "#f8fafc" }}>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
                            <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                              Rate % (current)
                              <input type="number" value={editRatePct} onChange={(e) => setEditRatePct(e.target.value)} style={{ width: 80 }} />
                            </label>
                            <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                              Payment (current)
                              <input type="number" value={editPayment} onChange={(e) => setEditPayment(e.target.value)} style={{ width: 100 }} />
                            </label>
                            <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                              Term (months)
                              <input type="number" value={editTermMonths} onChange={(e) => setEditTermMonths(e.target.value)} style={{ width: 90 }} />
                            </label>
                          </div>
                          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                            <input type="checkbox" checked={editArmEnabled} onChange={(e) => setEditArmEnabled(e.target.checked)} />
                            This is an adjustable-rate loan with known reset terms (from the Note)
                          </label>
                          {editArmEnabled ? (
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
                              <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                                First Change Date
                                <input type="date" value={editFirstChangeDate} onChange={(e) => setEditFirstChangeDate(e.target.value)} />
                              </label>
                              <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                                Reset every (months)
                                <input
                                  type="number"
                                  value={editChangeIntervalMonths}
                                  onChange={(e) => setEditChangeIntervalMonths(e.target.value)}
                                  style={{ width: 70 }}
                                />
                              </label>
                              <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                                First-change cap %
                                <input
                                  type="number"
                                  value={editFirstChangeCapPct}
                                  onChange={(e) => setEditFirstChangeCapPct(e.target.value)}
                                  style={{ width: 70 }}
                                />
                              </label>
                              <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                                Per-reset cap ±%
                                <input
                                  type="number"
                                  value={editPeriodicCapPct}
                                  onChange={(e) => setEditPeriodicCapPct(e.target.value)}
                                  style={{ width: 70 }}
                                />
                              </label>
                              <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                                Lifetime cap %
                                <input
                                  type="number"
                                  value={editLifetimeCapPct}
                                  onChange={(e) => setEditLifetimeCapPct(e.target.value)}
                                  style={{ width: 70 }}
                                />
                              </label>
                              <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                                Lifetime floor %
                                <input
                                  type="number"
                                  value={editLifetimeFloorPct}
                                  onChange={(e) => setEditLifetimeFloorPct(e.target.value)}
                                  style={{ width: 70 }}
                                />
                              </label>
                            </div>
                          ) : (
                            <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4, marginBottom: 8 }}>
                              Rate valid through (unknown reset terms, optional)
                              <input type="date" value={editRateValidThrough} onChange={(e) => setEditRateValidThrough(e.target.value)} />
                            </label>
                          )}
                          <button type="button" className="tr-refresh-btn" disabled={saving} onClick={() => confirmEdit(l.id)}>
                            {saving ? "Saving…" : "Save Terms"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                  {showSchedule && schedule && (
                    <tr>
                      <td colSpan={10} style={{ padding: 0 }}>
                        <div style={{ padding: "10px 12px", background: "#f8fafc" }}>
                          <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 8px" }}>
                            One table, start to end: <strong>Posted</strong> rows are a straight read of every real entry posted
                            against this loan's account (so out-of-schedule principal payments show up as themselves, not
                            smoothed away). <strong>Projected</strong> rows roll forward from today's real balance ({fmt(balance)}
                            ); if this loan has known adjustable-rate reset terms, future rate changes are applied at the
                            contractual worst case (the rate can legally never be higher than shown) and the payment is
                            re-amortized over the remaining term at each reset, exactly like the Note itself does.
                          </p>
                          {schedule.rateUnknownPast && (
                            <p style={{ fontSize: 12, color: "#b45309", margin: "0 0 8px" }}>
                              Stops at {schedule.rateUnknownPast} — the rate is only confirmed through this date. Add the loan's
                              reset terms under "Edit Terms" to extend the projection through maturity.
                            </p>
                          )}
                          <div className="columnar-report-scroll" style={{ maxHeight: 420, overflowY: "auto" }}>
                            <table className="columnar-report-table budget-table">
                              <thead>
                                <tr>
                                  <th>Date</th>
                                  <th>Type</th>
                                  <th className="right">Rate</th>
                                  <th className="right">Payment</th>
                                  <th className="right">Principal</th>
                                  <th className="right">Interest</th>
                                  <th className="right">Balance</th>
                                  <th>Note</th>
                                </tr>
                              </thead>
                              <tbody>
                                {schedule.rows.map((row, i) => (
                                  <tr key={i} style={row.type === "projected" ? { opacity: 0.75 } : undefined}>
                                    <td>{row.date}</td>
                                    <td>{row.type === "posted" ? "Posted" : "Projected"}</td>
                                    <td className="right">{row.ratePct.toFixed(3)}%</td>
                                    <td className="right">{row.payment === null ? "—" : fmt(row.payment)}</td>
                                    <td className="right" style={{ color: row.principal < 0 ? "#dc2626" : undefined }}>
                                      {fmt(row.principal)}
                                    </td>
                                    <td className="right">{row.interest === null ? "—" : fmt(row.interest)}</td>
                                    <td className="right">{fmt(row.balance)}</td>
                                    <td style={{ fontSize: 11 }}>{row.note}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
