"use client";
import { useCallback, useEffect, useState } from "react";
import { usePlaidLink, type PlaidLinkOnSuccess, type PlaidLinkOnSuccessMetadata } from "react-plaid-link";
import type { Ledger, Tx, Account } from "@/lib/vault-types";
import { nextVoucherNumber } from "@/lib/vault-accounting";

// ── Types ──────────────────────────────────────────────────────────────────────

interface PlaidTxRaw {
  transaction_id: string;
  date: string;
  name: string;
  merchant_name?: string;
  amount: number; // Plaid: positive = money OUT, negative = money IN (deposit)
  account_id: string;
  institution_name: string;
  pending?: boolean;
  personal_finance_category?: { primary: string; detailed: string };
}

interface Connection {
  item_id: string;
  institution_name: string;
  institution_id: string;
  connected_at: string;
}

interface EntryDraft {
  accountId: number;
  accountName: string;
  amount: number; // vault convention: negative = debit, positive = credit
}

interface ImportRow {
  plaidTx: PlaidTxRaw;
  skip: boolean;
  alreadyImported: boolean;
  voucherType: string;
  narration: string;
  entries: EntryDraft[];
  confidence: number; // 0–1, 1 = high confidence (payroll template), < 0.5 = needs review
}

interface Props {
  data: Ledger;
  apiUrl: string;
  onSave: (next: Ledger) => Promise<boolean>;
}

// ── Payroll template constants ─────────────────────────────────────────────────

const PAYROLL_PATTERNS = [/nvidia/i, /nviida/i, /adp.*payroll/i, /payroll.*nvidia/i];
const PAYROLL_GROSS = 10_196.67;
const PAYROLL_MEDICAL = 202.50; // Medical ($193.50) + Legal Plan ($9)
const PAYROLL_401K = 813.33;
const PAYROLL_TELEPHONE = 30.00;
const PAYROLL_BASE = PAYROLL_GROSS - PAYROLL_TELEPHONE;

function isPayroll(tx: PlaidTxRaw) {
  if (tx.amount >= 0) return false; // must be a deposit (money in)
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

// ── GL pattern match from vault history ───────────────────────────────────────

function matchFromHistory(
  tx: PlaidTxRaw,
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

  let bestKey = "";
  let bestScore = 0;
  scores.forEach((s, k) => { if (s > bestScore) { bestScore = s; bestKey = k; } });
  const [dStr, cStr] = bestKey.split(":");
  return { debitId: +dStr, creditId: +cStr, confidence: Math.min(bestScore / 8, 1) };
}

// ── Build draft entries for a Plaid transaction ────────────────────────────────

function buildDraft(tx: PlaidTxRaw, ledger: Ledger): Pick<ImportRow, "entries" | "voucherType" | "narration" | "confidence"> {
  const accounts = ledger.accounts.filter((a) => a.active !== false);
  const netDeposit = Math.abs(tx.amount); // always positive for arithmetic

  // ── NVIDIA payroll template ──
  if (isPayroll(tx)) {
    const salaryAcc = findAcct(accounts, "Salary Income - Nvidia", "Salary Income");
    const telAcc = findAcct(accounts, "Telephone Exps", "Telephone Expenses", "Telephone");
    const taxAcc = findAcct(accounts, "Tax Deduction", "Tax");
    const medAcc = findAcct(accounts, "Health Insurance", "Medical");
    const k401Acc = findAcct(accounts, "401K Investments", "401k");
    const bankAcc = findAcct(accounts, tx.institution_name, "Bank Of America", "Bank of America");

    if (salaryAcc && taxAcc && medAcc && k401Acc && bankAcc) {
      // Tax = Gross − Medical − 401K − NetDeposit (auto-computed)
      const taxAmount = Math.max(0, PAYROLL_GROSS - PAYROLL_MEDICAL - PAYROLL_401K - netDeposit);
      const entries: EntryDraft[] = [
        { accountId: salaryAcc.id, accountName: salaryAcc.name, amount: PAYROLL_BASE }, // Cr base
        ...(telAcc ? [{ accountId: telAcc.id, accountName: telAcc.name, amount: PAYROLL_TELEPHONE }] : []), // Cr telephone
        { accountId: taxAcc.id, accountName: taxAcc.name, amount: -taxAmount }, // Dr tax
        { accountId: medAcc.id, accountName: medAcc.name, amount: -PAYROLL_MEDICAL }, // Dr medical
        { accountId: k401Acc.id, accountName: k401Acc.name, amount: -PAYROLL_401K }, // Dr 401K
        { accountId: bankAcc.id, accountName: bankAcc.name, amount: -netDeposit }, // Dr bank
      ];
      return { entries, voucherType: "Receipt", narration: "Salary Income - Semi Monthly", confidence: 0.95 };
    }
  }

  // ── Pattern match from history ──
  const match = matchFromHistory(tx, ledger);
  if (match) {
    const debitAcc = accounts.find((a) => a.id === match.debitId);
    const creditAcc = accounts.find((a) => a.id === match.creditId);
    if (debitAcc && creditAcc) {
      const amt = Math.abs(tx.amount);
      return {
        entries: [
          { accountId: debitAcc.id, accountName: debitAcc.name, amount: -amt },
          { accountId: creditAcc.id, accountName: creditAcc.name, amount: amt },
        ],
        voucherType: tx.amount < 0 ? "Receipt" : "Payment",
        narration: tx.merchant_name || tx.name,
        confidence: match.confidence,
      };
    }
  }

  // ── No match — return empty scaffold ──
  return {
    entries: [],
    voucherType: tx.amount < 0 ? "Receipt" : "Payment",
    narration: tx.merchant_name || tx.name,
    confidence: 0,
  };
}

// ── Check if already imported (by date + amount + narration pattern) ───────────

function alreadyImported(tx: PlaidTxRaw, ledger: Ledger): boolean {
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

// ── PlaidConnectButton sub-component ──────────────────────────────────────────

function PlaidConnectButton({ onConnected }: { onConnected: (name: string) => void }) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    fetch("/api/plaid/link-token", { method: "POST" })
      .then((r) => r.json())
      .then((d: any) => {
        if (d.link_token) setLinkToken(d.link_token);
        else setError(d.error_message || d.error_code || "Failed to get link token");
      })
      .catch(() => setError("Network error — check Plaid credentials"))
      .finally(() => setLoading(false));
  }, []);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    (publicToken: string | null, metadata: PlaidLinkOnSuccessMetadata) => {
      const name = metadata?.institution?.name || "Bank";
      const id = (metadata?.institution as any)?.institution_id || "";
      fetch("/api/plaid/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ public_token: publicToken, institution_name: name, institution_id: id }),
      }).then((resp) => {
        if (resp.ok) onConnected(name);
        else setError("Token exchange failed");
      });
    },
    [onConnected]
  );

  const { open, ready } = usePlaidLink({ token: linkToken || "", onSuccess });

  if (error) return <span className="plaid-error">{error}</span>;
  if (loading || !linkToken) return <button className="plaid-connect-btn" disabled>Loading…</button>;
  return (
    <button className="plaid-connect-btn" onClick={() => open()} disabled={!ready}>
      + Connect Bank
    </button>
  );
}

// ── Main PlaidImport component ─────────────────────────────────────────────────

export function PlaidImport({ data, onSave }: Props) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [status, setStatus] = useState("");
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);

  function reloadConnections() {
    fetch("/api/plaid/connections")
      .then((r) => r.json())
      .then((cs: unknown) => setConnections(cs as Connection[]))
      .catch(() => {});
  }

  useEffect(() => { reloadConnections(); }, []);

  async function fetchTransactions() {
    setFetching(true);
    setStatus("Fetching transactions from connected banks…");
    try {
      const r = await fetch("/api/plaid/transactions");
      const { transactions, errors } = (await r.json()) as { transactions: PlaidTxRaw[]; errors: string[] };
      if (errors?.length) setStatus(`Partial fetch — ${errors.join(", ")}`);
      else setStatus("");
      const draftRows: ImportRow[] = transactions
        .filter((t) => !t.pending)
        .map((tx) => {
          const draft = buildDraft(tx, data);
          return {
            plaidTx: tx,
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

  async function disconnect(item_id: string) {
    await fetch("/api/plaid/connections", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id }),
    });
    reloadConnections();
  }

  function updateRow(idx: number, patch: Partial<ImportRow>) {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function updateEntry(rowIdx: number, eIdx: number, patch: Partial<EntryDraft>) {
    setRows((rs) =>
      rs.map((r, i) =>
        i !== rowIdx
          ? r
          : { ...r, entries: r.entries.map((e, j) => (j === eIdx ? { ...e, ...patch } : e)) }
      )
    );
  }

  async function saveSelected() {
    const toSave = rows.filter((r) => !r.skip && !r.alreadyImported && r.entries.length >= 2);
    if (!toSave.length) { setStatus("Nothing to save."); return; }
    setSaving(true);
    setStatus(`Saving ${toSave.length} voucher(s)…`);
    const newTxs: Tx[] = toSave.map((r) => ({
      id: data.transactions.length + 1,
      guid: crypto.randomUUID(),
      syncStatus: "pending" as const,
      date: r.plaidTx.date,
      number: "",
      type: r.voucherType,
      narration: r.narration,
      historical: false,
      cancelled: false,
      entries: r.entries,
    }));
    const next: Ledger = { ...data, transactions: [...data.transactions, ...newTxs] };
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

  return (
    <div className="plaid-import-panel">
      {/* Connected banks */}
      <div className="plaid-banks-row">
        <strong>Connected banks</strong>
        {connections.length === 0 ? (
          <span className="plaid-none">None connected yet</span>
        ) : (
          connections.map((c) => (
            <span key={c.item_id} className="plaid-bank-chip">
              {c.institution_name}
              <button onClick={() => disconnect(c.item_id)} title="Disconnect">×</button>
            </span>
          ))
        )}
        <PlaidConnectButton onConnected={(name) => { setStatus(`${name} connected!`); reloadConnections(); }} />
        {connections.length > 0 && (
          <button className="plaid-fetch-btn" onClick={fetchTransactions} disabled={fetching}>
            {fetching ? "Loading…" : "Fetch Transactions"}
          </button>
        )}
      </div>

      {status && <div className="plaid-status">{status}</div>}

      {/* Import review queue */}
      {rows.length > 0 && (
        <>
          <div className="plaid-queue-toolbar">
            <span>{toImport.length} transaction(s) to import ({rows.filter((r) => r.alreadyImported).length} already in vault)</span>
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
                key={row.plaidTx.transaction_id}
                className={[
                  "plaid-queue-row",
                  row.alreadyImported ? "plaid-row-exists" : "",
                  row.skip && !row.alreadyImported ? "plaid-row-skipped" : "",
                  row.confidence >= 0.8 ? "plaid-row-confident" : row.confidence === 0 ? "plaid-row-unmatched" : "",
                ].filter(Boolean).join(" ")}
              >
                {/* Skip checkbox */}
                <input
                  type="checkbox"
                  checked={row.skip || row.alreadyImported}
                  disabled={row.alreadyImported}
                  onChange={(e) => updateRow(idx, { skip: e.target.checked })}
                  title={row.alreadyImported ? "Already in vault" : "Skip this transaction"}
                />

                {/* Transaction info */}
                <div className="plaid-tx-info">
                  <span className="plaid-tx-date">{row.plaidTx.date}</span>
                  <span className="plaid-tx-name">{row.plaidTx.name}</span>
                  <span className={`plaid-tx-amt ${row.plaidTx.amount < 0 ? "credit" : "debit"}`}>
                    {row.plaidTx.amount < 0 ? "+" : "−"}${Math.abs(row.plaidTx.amount).toFixed(2)}
                  </span>
                  <span className="plaid-tx-bank">{row.plaidTx.institution_name}</span>
                </div>

                {/* JE narration & type */}
                <div className="plaid-je-meta">
                  <select
                    value={row.voucherType}
                    onChange={(e) => updateRow(idx, { voucherType: e.target.value })}
                    disabled={row.alreadyImported}
                  >
                    {["Receipt", "Payment", "Journal", "Contra"].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={row.narration}
                    onChange={(e) => updateRow(idx, { narration: e.target.value })}
                    placeholder="Narration"
                    disabled={row.alreadyImported}
                  />
                  {row.confidence >= 0.8 && !row.alreadyImported && (
                    <span className="plaid-confidence-badge">auto</span>
                  )}
                  {row.confidence === 0 && !row.alreadyImported && (
                    <span className="plaid-unmatched-badge">needs accounts</span>
                  )}
                  {row.alreadyImported && <span className="plaid-exists-badge">in vault</span>}
                </div>

                {/* JE entries */}
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
                    {row.entries.length === 0 && (
                      <span className="plaid-no-entries">Select accounts manually</span>
                    )}
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
