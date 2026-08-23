"use client";
import { useEffect, useRef, useState } from "react";
import type { Ledger, Tx, Account } from "@/lib/vault-types";
import { nextVoucherNumber, nextTransactionIds } from "@/lib/vault-accounting";
import { fmtDate } from "@/lib/format-date";

// ── Types ──────────────────────────────────────────────────────────────────────

interface TellerTxRaw {
  transaction_id: string;
  date: string;
  name: string;
  merchant_name?: string | null;
  amount: number; // normalised: positive = money OUT, negative = money IN
  account_id: string;
  account_type: string; // "depository" | "credit"
  account_subtype: string;
  institution_name: string;
  pending?: boolean;
  personal_finance_category?: { primary: string; detailed: string };
}

interface Enrollment {
  enrollment_id: string;
  institution_name: string;
  user_id: string;
  connected_at: string;
}

interface EntryDraft {
  accountId: number;
  accountName: string;
  amount: number; // vault: negative = debit, positive = credit
}

interface ImportRow {
  tx: TellerTxRaw;
  skip: boolean;
  alreadyImported: boolean;
  voucherType: string;
  narration: string;
  entries: EntryDraft[];
  confidence: number;
  source?: "payroll" | "history" | "household" | "none";
}

interface Props {
  data: Ledger;
  apiUrl: string;
  onSave: (next: Ledger) => Promise<boolean>;
}

// ── Teller Connect script loader ───────────────────────────────────────────────

declare global {
  interface Window {
    TellerConnect?: {
      setup: (opts: {
        applicationId: string;
        environment?: string;
        onSuccess: (enrollment: { accessToken: string; user: { id: string }; enrollment: { id: string }; institution: { name: string } }) => void;
        onFailure?: (err: unknown) => void;
        onExit?: () => void;
      }) => { open: () => void };
    };
  }
}

function useTellerConnect(appId: string | null, onSuccess: (e: { accessToken: string; user: { id: string }; enrollment: { id: string }; institution: { name: string } }) => void) {
  const tellerRef = useRef<{ open: () => void } | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!appId) return;
    if (window.TellerConnect) {
      tellerRef.current = window.TellerConnect.setup({ applicationId: appId, environment: "development", onSuccess });
      setReady(true);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdn.teller.io/connect/connect.js";
    script.onload = () => {
      if (window.TellerConnect) {
        tellerRef.current = window.TellerConnect.setup({ applicationId: appId, environment: "development", onSuccess });
        setReady(true);
      }
    };
    document.head.appendChild(script);
  }, [appId]);

  return { open: () => tellerRef.current?.open(), ready };
}

// ── Payroll template constants ─────────────────────────────────────────────────

const PAYROLL_PATTERNS = [/nvidia/i, /adp.*payroll/i, /payroll.*nvidia/i];
const PAYROLL_GROSS = 10_196.67;
const PAYROLL_MEDICAL = 202.50;
const PAYROLL_401K = 813.33;
const PAYROLL_TELEPHONE = 30.00;
const PAYROLL_BASE = PAYROLL_GROSS - PAYROLL_TELEPHONE;

function isPayroll(tx: TellerTxRaw) {
  if (tx.amount >= 0) return false;
  const desc = `${tx.name} ${tx.merchant_name || ""}`;
  return PAYROLL_PATTERNS.some((p) => p.test(desc));
}

// ── Account finder helpers ─────────────────────────────────────────────────────

function findAcct(accounts: Account[], ...names: string[]): Account | undefined {
  for (const name of names) {
    const lc = name.toLowerCase();
    const exact = accounts.find((a) => a.name.toLowerCase() === lc);
    if (exact) return exact;
    const partial = accounts.find((a) => a.name.toLowerCase().includes(lc));
    if (partial) return partial;
  }
}

// ── House Hold Exps monthly helpers ───────────────────────────────────────────

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function houseHoldMonthName(date: string): string {
  const [year, month] = date.split("-");
  const mon = MONTH_ABBR[parseInt(month, 10) - 1] || "Jan";
  return `House Hold Exps - ${mon} ${year.slice(-2)}`;
}

function findHouseHoldTemplate(accounts: Account[]): Account | undefined {
  return accounts.find((a) => /^house hold exps/i.test(a.name));
}

function computeNewAccounts(txs: TellerTxRaw[], ledger: Ledger): Record<string, Account> {
  const accounts = ledger.accounts.filter((a) => a.active !== false);
  const template = findHouseHoldTemplate(accounts);
  if (!template) return {};

  const result: Record<string, Account> = {};
  let nextId = Math.max(...ledger.accounts.map((a) => a.id), 0) + 1;

  for (const tx of txs) {
    if (tx.amount <= 0 || isPayroll(tx)) continue;
    const histMatch = matchFromHistory(tx, ledger);
    if (histMatch && histMatch.confidence >= 0.2) continue;
    const name = houseHoldMonthName(tx.date);
    const exists = accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (!exists && !result[name]) {
      result[name] = { ...template, id: nextId++, name };
    }
  }
  return result;
}

// ── GL pattern match from vault history ───────────────────────────────────────

function matchFromHistory(
  tx: TellerTxRaw,
  ledger: Ledger
): { debitId: number; creditId: number; confidence: number } | null {
  const keywords = `${tx.name} ${tx.merchant_name || ""}`
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);

  const scores = new Map<string, number>();

  for (const v of ledger.transactions) {
    if (v.deleted || v.cancelled) continue;
    const narration = (v.narration || "").toLowerCase();
    let score = 0;
    for (const kw of keywords) if (narration.includes(kw)) score += 2;
    if (score === 0) continue;

    const debitE = v.entries.find((e) => e.amount < 0);
    const creditE = v.entries.find((e) => e.amount > 0);
    if (debitE && creditE) {
      const key = `${debitE.accountId}:${creditE.accountId}`;
      scores.set(key, (scores.get(key) || 0) + score);
    }
  }

  if (!scores.size) return null;

  let bestKey = "", bestScore = 0;
  scores.forEach((s, k) => { if (s > bestScore) { bestScore = s; bestKey = k; } });
  const [dStr, cStr] = bestKey.split(":");
  return { debitId: +dStr, creditId: +cStr, confidence: Math.min(bestScore / 8, 1) };
}

// ── Build draft JE for a transaction ──────────────────────────────────────────

function buildDraft(
  tx: TellerTxRaw,
  ledger: Ledger,
  newAcctsByName: Record<string, Account>
): Pick<ImportRow, "entries" | "voucherType" | "narration" | "confidence" | "source"> {
  const accounts = ledger.accounts.filter((a) => a.active !== false);
  const allAccounts = [
    ...accounts,
    ...Object.values(newAcctsByName).filter(
      (na) => !accounts.find((a) => a.name.toLowerCase() === na.name.toLowerCase())
    ),
  ];
  const amt = Math.abs(tx.amount);

  // ── NVIDIA payroll ──
  if (isPayroll(tx)) {
    const salaryAcc = findAcct(accounts, "Salary Income - Nvidia", "Salary Income");
    const telAcc = findAcct(accounts, "Telephone Exps", "Telephone Expenses", "Telephone");
    const taxAcc = findAcct(accounts, "Tax Deduction", "Tax");
    const medAcc = findAcct(accounts, "Health Insurance", "Medical");
    const k401Acc = findAcct(accounts, "401K Investments", "401k");
    const bankAcc = findAcct(accounts, tx.institution_name, "Bank Of America", "Bank of America");

    if (salaryAcc && taxAcc && medAcc && k401Acc && bankAcc) {
      const taxAmount = Math.max(0, PAYROLL_GROSS - PAYROLL_MEDICAL - PAYROLL_401K - amt);
      return {
        entries: [
          { accountId: salaryAcc.id, accountName: salaryAcc.name, amount: PAYROLL_BASE },
          ...(telAcc ? [{ accountId: telAcc.id, accountName: telAcc.name, amount: PAYROLL_TELEPHONE }] : []),
          { accountId: taxAcc.id, accountName: taxAcc.name, amount: -taxAmount },
          { accountId: medAcc.id, accountName: medAcc.name, amount: -PAYROLL_MEDICAL },
          { accountId: k401Acc.id, accountName: k401Acc.name, amount: -PAYROLL_401K },
          { accountId: bankAcc.id, accountName: bankAcc.name, amount: -amt },
        ],
        voucherType: "Receipt",
        narration: "Salary Income - Semi Monthly",
        confidence: 0.95,
        source: "payroll",
      };
    }
  }

  // ── Credit card payment to bank (AUTOMATIC PAYMENT / PAYMENT THANK YOU) ──
  const isCCPayment =
    tx.account_type === "depository" &&
    /automatic payment|payment thank you|autopay|online payment/i.test(tx.name);
  if (isCCPayment && tx.amount > 0) {
    const bankAcc = findAcct(accounts, tx.institution_name, "Bank Of America", "Bank of America", "Chase");
    const ccAcc = findAcct(accounts, "Credit Card", "AMEX", "American Express", "Visa", "MasterCard");
    if (bankAcc && ccAcc) {
      return {
        entries: [
          { accountId: ccAcc.id, accountName: ccAcc.name, amount: -amt },
          { accountId: bankAcc.id, accountName: bankAcc.name, amount: amt },
        ],
        voucherType: "Payment",
        narration: tx.name,
        confidence: 0.7,
        source: "history",
      };
    }
  }

  // ── History match ──
  const match = matchFromHistory(tx, ledger);
  if (match) {
    const debitAcc = accounts.find((a) => a.id === match.debitId);
    const creditAcc = accounts.find((a) => a.id === match.creditId);
    if (debitAcc && creditAcc) {
      return {
        entries: [
          { accountId: debitAcc.id, accountName: debitAcc.name, amount: -amt },
          { accountId: creditAcc.id, accountName: creditAcc.name, amount: amt },
        ],
        voucherType: tx.amount < 0 ? "Receipt" : "Payment",
        narration: tx.merchant_name || tx.name,
        confidence: match.confidence,
        source: "history",
      };
    }
  }

  // ── House Hold Exps default for unmatched expenses ──
  if (tx.amount > 0) {
    const hhName = houseHoldMonthName(tx.date);
    const hhAcct = allAccounts.find((a) => a.name.toLowerCase() === hhName.toLowerCase());
    // For credit card transactions: credit side is the credit card account
    // For bank/debit transactions: credit side is the bank account
    const creditSideAcct =
      tx.account_type === "credit"
        ? findAcct(accounts, tx.institution_name, "Credit Card", "AMEX", "Visa", "Chase", "Bank Of America")
        : findAcct(accounts, tx.institution_name, "Bank Of America", "Bank of America", "Chase");

    if (hhAcct && creditSideAcct) {
      return {
        entries: [
          { accountId: hhAcct.id, accountName: hhAcct.name, amount: -amt },
          { accountId: creditSideAcct.id, accountName: creditSideAcct.name, amount: amt },
        ],
        voucherType: "Payment",
        narration: tx.merchant_name || tx.name,
        confidence: 0.35,
        source: "household",
      };
    }
  }

  return {
    entries: [],
    voucherType: tx.amount < 0 ? "Receipt" : "Payment",
    narration: tx.merchant_name || tx.name,
    confidence: 0,
    source: "none",
  };
}

// ── Already imported check ─────────────────────────────────────────────────────

function alreadyImported(tx: TellerTxRaw, ledger: Ledger): boolean {
  const amt = Math.abs(tx.amount);
  return ledger.transactions.some(
    (v) =>
      !v.deleted &&
      v.date === tx.date &&
      Math.abs(
        v.entries.filter((e) => e.amount < 0).reduce((s, e) => s + Math.abs(e.amount), 0) - amt
      ) < 0.05
  );
}

// ── Teller Connect Button ─────────────────────────────────────────────────────

function TellerConnectButton({ appId, onConnected }: { appId: string; onConnected: (name: string) => void }) {
  const [error, setError] = useState("");

  const { open, ready } = useTellerConnect(appId, (e) => {
    fetch("/api/teller/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: e.accessToken,
        user_id: e.user?.id || "",
        institution_name: e.institution?.name || "Bank",
        enrollment_id: e.enrollment?.id || e.user?.id || crypto.randomUUID(),
      }),
    }).then((r) => {
      if (r.ok) onConnected(e.institution?.name || "Bank");
      else setError("Failed to save enrollment");
    }).catch(() => setError("Network error"));
  });

  if (error) return <span className="plaid-error">{error}</span>;
  return (
    <button className="plaid-connect-btn" onClick={() => open?.()} disabled={!ready}>
      + Connect Bank / Card
    </button>
  );
}

// ── Main TellerImport component ───────────────────────────────────────────────

export function TellerImport({ data, onSave }: Props) {
  const [appId, setAppId] = useState<string | null>(null);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [newAccts, setNewAccts] = useState<Record<string, Account>>({});
  const [status, setStatus] = useState("");
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/teller/app-id")
      .then((r) => r.json())
      .then((d: any) => { if (d.applicationId) setAppId(d.applicationId); })
      .catch(() => {});
    reloadEnrollments();
  }, []);

  function reloadEnrollments() {
    fetch("/api/teller/enrollments")
      .then((r) => r.json())
      .then((es: unknown) => setEnrollments(es as Enrollment[]))
      .catch(() => {});
  }

  async function fetchTransactions() {
    setFetching(true);
    setStatus("Fetching transactions from connected banks & cards…");
    try {
      const r = await fetch("/api/teller/transactions");
      const { transactions, errors } = (await r.json()) as { transactions: TellerTxRaw[]; errors: string[] };
      if (errors?.length) setStatus(`Partial fetch — ${errors.join(", ")}`);
      else setStatus("");

      const pending = (transactions as TellerTxRaw[]).filter((t) => !t.pending);
      const acctsToCreate = computeNewAccounts(pending, data);
      setNewAccts(acctsToCreate);

      const draftRows: ImportRow[] = pending.map((tx) => {
        const draft = buildDraft(tx, data, acctsToCreate);
        return {
          tx,
          skip: alreadyImported(tx, data),
          alreadyImported: alreadyImported(tx, data),
          ...draft,
        };
      });
      setRows(draftRows);
    } catch {
      setStatus("Failed to fetch transactions");
    } finally {
      setFetching(false);
    }
  }

  async function disconnect(enrollment_id: string) {
    await fetch("/api/teller/enrollments", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enrollment_id }),
    });
    reloadEnrollments();
  }

  function updateRow(idx: number, patch: Partial<ImportRow>) {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function updateEntry(rowIdx: number, eIdx: number, patch: Partial<EntryDraft>) {
    setRows((rs) =>
      rs.map((r, i) =>
        i !== rowIdx ? r : { ...r, entries: r.entries.map((e, j) => (j === eIdx ? { ...e, ...patch } : e)) }
      )
    );
  }

  async function saveSelected() {
    const toSave = rows.filter((r) => !r.skip && !r.alreadyImported && r.entries.length >= 2);
    if (!toSave.length) { setStatus("Nothing to save."); return; }
    setSaving(true);

    const usedAcctIds = new Set(toSave.flatMap((r) => r.entries.map((e) => e.accountId)));
    const pendingAcctsNeeded = Object.values(newAccts).filter(
      (na) =>
        usedAcctIds.has(na.id) &&
        !data.accounts.find((a) => a.name.toLowerCase() === na.name.toLowerCase())
    );

    if (pendingAcctsNeeded.length) {
      setStatus(`Creating ${pendingAcctsNeeded.length} new account(s) and saving ${toSave.length} voucher(s)…`);
    } else {
      setStatus(`Saving ${toSave.length} voucher(s)…`);
    }

    const updatedAccounts = pendingAcctsNeeded.length
      ? [...data.accounts, ...pendingAcctsNeeded]
      : data.accounts;

    const newIds = nextTransactionIds(data.transactions, toSave.length);
    const newTxs: Tx[] = toSave.map((r, i) => ({
      id: newIds[i],
      guid: crypto.randomUUID(),
      syncStatus: "pending" as const,
      date: r.tx.date,
      number: "",
      type: r.voucherType,
      narration: r.narration,
      historical: false,
      cancelled: false,
      entries: r.entries,
    }));

    const next: Ledger = { ...data, accounts: updatedAccounts, transactions: [...data.transactions, ...newTxs] };
    const ok = await onSave(next);
    if (ok) {
      setStatus(`${toSave.length} voucher(s) saved.`);
      setRows((rs) => rs.map((r) => (r.skip ? r : { ...r, alreadyImported: true, skip: true })));
    } else {
      setStatus("Save failed — see vault status for details.");
    }
    setSaving(false);
  }

  const toImport = rows.filter((r) => !r.skip && !r.alreadyImported);
  const newAcctsNeededCount = Object.values(newAccts).filter(
    (na) =>
      !data.accounts.find((a) => a.name.toLowerCase() === na.name.toLowerCase()) &&
      toImport.some((r) => r.source === "household" && r.entries.some((e) => e.accountId === na.id))
  ).length;

  if (!appId) {
    return (
      <div className="plaid-import-panel">
        <div className="plaid-status">
          Teller not configured — add <strong>TELLER_APP_ID</strong> secret and redeploy.
        </div>
      </div>
    );
  }

  return (
    <div className="plaid-import-panel">
      {/* Connected banks */}
      <div className="plaid-banks-row">
        <strong>Connected banks &amp; cards</strong>
        {enrollments.length === 0 ? (
          <span className="plaid-none">None connected yet</span>
        ) : (
          enrollments.map((e) => (
            <span key={e.enrollment_id} className="plaid-bank-chip">
              {e.institution_name}
              <button onClick={() => disconnect(e.enrollment_id)} title="Disconnect">×</button>
            </span>
          ))
        )}
        <TellerConnectButton appId={appId} onConnected={(name) => { setStatus(`${name} connected!`); reloadEnrollments(); }} />
        {enrollments.length > 0 && (
          <button className="plaid-fetch-btn" onClick={fetchTransactions} disabled={fetching}>
            {fetching ? "Loading…" : "Fetch Transactions"}
          </button>
        )}
      </div>

      {status && <div className="plaid-status">{status}</div>}

      {rows.length > 0 && (
        <>
          <div className="plaid-queue-toolbar">
            <span>{toImport.length} transaction(s) to import ({rows.filter((r) => r.alreadyImported).length} already in vault)</span>
            {newAcctsNeededCount > 0 && (
              <span className="plaid-new-accts-notice">
                + {newAcctsNeededCount} new account{newAcctsNeededCount > 1 ? "s" : ""} will be created
              </span>
            )}
            <label>
              <input type="checkbox" onChange={(e) => setRows((rs) => rs.map((r) => ({ ...r, skip: r.alreadyImported ? true : e.target.checked })))} />
              Skip all
            </label>
            <button className="plaid-save-btn" onClick={saveSelected} disabled={saving || !toImport.length}>
              {saving ? "Saving…" : `Save ${toImport.length} selected`}
            </button>
          </div>

          <div className="plaid-queue">
            {rows.map((row, idx) => (
              <div
                key={row.tx.transaction_id}
                className={[
                  "plaid-queue-row",
                  row.alreadyImported ? "plaid-row-exists" : "",
                  row.skip && !row.alreadyImported ? "plaid-row-skipped" : "",
                  row.confidence >= 0.8 ? "plaid-row-confident" : row.confidence === 0 ? "plaid-row-unmatched" : "",
                ].filter(Boolean).join(" ")}
              >
                <input
                  type="checkbox"
                  checked={row.skip || row.alreadyImported}
                  disabled={row.alreadyImported}
                  onChange={(e) => updateRow(idx, { skip: e.target.checked })}
                  title={row.alreadyImported ? "Already in vault" : "Skip this transaction"}
                />

                <div className="plaid-tx-info">
                  <span className="plaid-tx-date">{fmtDate(row.tx.date)}</span>
                  <span className="plaid-tx-name">{row.tx.name}</span>
                  <span className={`plaid-tx-amt ${row.tx.amount < 0 ? "credit" : "debit"}`}>
                    {row.tx.amount < 0 ? "+" : "−"}${Math.abs(row.tx.amount).toFixed(2)}
                  </span>
                  <span className="plaid-tx-bank">
                    {row.tx.institution_name}
                    {row.tx.account_type === "credit" && <em> (CC)</em>}
                  </span>
                </div>

                <div className="plaid-je-meta">
                  <select value={row.voucherType} onChange={(e) => updateRow(idx, { voucherType: e.target.value })} disabled={row.alreadyImported}>
                    {["Receipt", "Payment", "Journal", "Contra"].map((t) => <option key={t}>{t}</option>)}
                  </select>
                  <input
                    type="text"
                    value={row.narration}
                    onChange={(e) => updateRow(idx, { narration: e.target.value })}
                    placeholder="Narration"
                    disabled={row.alreadyImported}
                  />
                  {row.confidence >= 0.8 && !row.alreadyImported && <span className="plaid-confidence-badge">auto</span>}
                  {row.source === "household" && !row.alreadyImported && <span className="plaid-household-badge">household</span>}
                  {row.confidence === 0 && !row.alreadyImported && <span className="plaid-unmatched-badge">needs accounts</span>}
                  {row.alreadyImported && <span className="plaid-exists-badge">in vault</span>}
                </div>

                {!row.alreadyImported && (
                  <div className="plaid-entries">
                    {row.entries.map((e, ei) => (
                      <div key={ei} className="plaid-entry-line">
                        <span className={e.amount < 0 ? "plaid-dr" : "plaid-cr"}>{e.amount < 0 ? "Dr" : "Cr"}</span>
                        <select
                          value={e.accountId}
                          onChange={(ev) => {
                            const acc = data.accounts.find((a) => a.id === +ev.target.value);
                            if (acc) updateEntry(idx, ei, { accountId: acc.id, accountName: acc.name });
                          }}
                        >
                          {data.accounts.filter((a) => a.active !== false).sort((a, b) => a.name.localeCompare(b.name)).map((a) => (
                            <option value={a.id} key={a.id}>{a.name}</option>
                          ))}
                        </select>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={Math.abs(e.amount).toFixed(2)}
                          onChange={(ev) => {
                            const abs = Math.abs(+ev.target.value);
                            updateEntry(idx, ei, { amount: e.amount < 0 ? -abs : abs });
                          }}
                        />
                      </div>
                    ))}
                    {row.entries.length === 0 && <span className="plaid-no-entries">Select accounts manually</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
