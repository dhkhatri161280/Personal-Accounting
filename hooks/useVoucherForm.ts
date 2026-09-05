import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { voucherEntrySchema, type VoucherEntryFormValues } from "@/lib/voucher-entry-schema";
import { validateVoucher } from "@/lib/voucher-validation";
import type { Account, Ledger, Tx, VoucherLineDraft } from "@/lib/vault-types";
import {
  blankVoucherLines,
  draftLinesFromTx,
  centsOf,
  fiscalYearOf,
  nextVoucherNumber,
  nextTransactionIds,
  cleanText,
  isPeriodClosed,
} from "@/lib/vault-accounting";

export function autoBalance(lines: VoucherLineDraft[], changedIndex: number): VoucherLineDraft[] {
  const last = lines.length - 1;
  if (lines.length < 2) return lines;
  if (lines.length === 2) {
    // 2-line: mirror the typed amount to the other line
    const other = changedIndex === 0 ? 1 : 0;
    return lines.map((row, i) => (i === other ? { ...row, amount: lines[changedIndex].amount } : row));
  }
  // Multi-line: auto-compute last line as running balance when any non-last line changes
  if (changedIndex === last) return lines;
  let drSum = 0, crSum = 0;
  for (let i = 0; i < last; i++) {
    const a = Math.abs(Number(lines[i].amount) || 0);
    if (lines[i].side === "debit") drSum += a;
    else crSum += a;
  }
  const diff = drSum - crSum;
  const newSide: "debit" | "credit" = diff >= 0 ? "credit" : "debit";
  const newAmt = Math.abs(diff);
  return lines.map((row, i) =>
    i === last ? { ...row, side: newSide, amount: newAmt > 0.005 ? newAmt.toFixed(2) : "" } : row
  );
}

// Everything behind the New/Edit/Copy voucher form: the dynamic debit/credit line array (plus
// its autoBalance side effect), the RHF-managed scalar fields (type/date/narration -- see
// lib/voucher-entry-schema.ts for why the line array itself isn't RHF-managed), the inline
// "create ledger from voucher" flow, and the add()/editVoucher()/copyVoucher()/startNewVoucher()
// handlers that used to live directly in components/VaultApp.tsx. Pulled out purely to shrink
// that file -- no behavior changed; every accounting rule still funnels through
// lib/voucher-validation.js's validateVoucher() exactly as before.
export function useVoucherForm({
  data,
  save,
  setTab,
  setStatus,
  setSelected,
  setSelectedVoucher,
}: {
  data: Ledger | null;
  save: (next: Ledger, destination?: string, exemptFromPeriodCheck?: Set<string>) => Promise<boolean>;
  setTab: (t: string) => void;
  setStatus: (s: string) => void;
  setSelected: (n: number | null) => void;
  setSelectedVoucher: (t: Tx | null) => void;
}) {
  const [copyTx, setCopyTx] = useState<Tx | null>(null),
    [editTx, setEditTx] = useState<Tx | null>(null),
    [newVoucherType, setNewVoucherType] = useState<string | null>(null),
    [newVoucherMenuOpen, setNewVoucherMenuOpen] = useState(false),
    [inlineLedgerSide, setInlineLedgerSide] = useState<"debit" | "credit" | null>(null),
    [voucherLines, setVoucherLines] = useState<VoucherLineDraft[]>(blankVoucherLines()),
    // Mirrors the (uncontrolled) voucher-form date input so each ledger line's balance display
    // can recompute "as of" the date currently entered, Tally-style -- kept separate from the
    // input's own defaultValue/form submission so the date field itself doesn't need to become
    // a fully controlled input just for this.
    [voucherDate, setVoucherDate] = useState<string>(() => new Date().toISOString().slice(0, 10));

  // Voucher entry form's scalar fields (type/date/narration) only -- see lib/voucher-entry-schema.ts
  // for why the debit/credit line array is deliberately excluded from this.
  const voucherForm = useForm<VoucherEntryFormValues>({
    resolver: zodResolver(
      voucherEntrySchema(data?.voucherTypes || ["Payment", "Receipt", "Contra", "Journal"])
    ),
    defaultValues: { type: "Payment", date: new Date().toISOString().slice(0, 10), narration: "" },
  });

  async function createLedgerInsideVoucher(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!data) return;
    if (!inlineLedgerSide) return;
    const form = new FormData(e.currentTarget),
      name = String(form.get("name") || "")
        .trim()
        .replace(/\s+/g, " "),
      parent = String(form.get("parent") || ""),
      currency = String(form.get("currency") || data.currency),
      amount = Math.abs(Number(form.get("opening") || 0)),
      side = String(form.get("side") || "Dr");
    if (!name || !parent) {
      setStatus("Enter a ledger name and select its account group.");
      return;
    }
    if (data.accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      setStatus(`Ledger ${name} already exists. Select it from the voucher instead.`);
      return;
    }
    const nature =
        (data.groups || []).find((g) => g.name === parent)?.nature ||
        (/^bank accounts$/i.test(parent)
          ? "Bank"
          : /^cash-in-hand$/i.test(parent)
            ? "Cash"
            : /^investments$/i.test(parent)
              ? "Investment"
              : /income/i.test(parent)
                ? "Income"
                : /expense|purchase/i.test(parent)
                  ? "Expense"
                  : /capital/i.test(parent)
                    ? "Capital"
                    : /liabilit|creditor|loan/i.test(parent)
                      ? "Liability"
                      : "Asset"),
      id = Math.max(0, ...data.accounts.map((a) => a.id)) + 1,
      account: Account = {
        id,
        name,
        parent,
        category: nature,
        currency,
        openingBalance: side === "Dr" ? -amount : amount,
        active: true,
        masterSyncStatus: "pending",
        masterFingerprint: "app-change-" + Date.now(),
      },
      next = { ...data, accounts: [...data.accounts, account] };
    if (!(await save(next, "new"))) return;
    setInlineLedgerSide(null);
    setStatus(
      `Created ledger ${name}. It is selected for this voucher and pending Tally synchronization.`
    );
    setVoucherLines((lines) => [
      ...lines,
      { id: crypto.randomUUID(), side: inlineLedgerSide, accountId: String(id), amount: "" },
    ]);
  }

  // Returns whether the edit form actually opened -- callers (the voucher detail popup) must
  // check this before closing themselves. Previously the popup closed unconditionally on click,
  // so any of the guards below returning early left the user looking at whatever was behind the
  // popup with no visible explanation of why nothing happened.
  function editVoucher(t: Tx): boolean {
    if (data && isPeriodClosed(data.closedPeriods, t.date)) {
      setStatus(`This voucher is dated in a closed period (${t.date}) and cannot be edited. Reopen the period in Masters → Periods first.`);
      return false;
    }
    if (t.cancelled) {
      setStatus("Cancelled vouchers are audit-only and cannot be edited.");
      return false;
    }
    if (!t.entries.some((e) => e.amount < 0) || !t.entries.some((e) => e.amount > 0)) {
      setStatus("This voucher does not contain both debit and credit lines.");
      return false;
    }
    setVoucherLines(draftLinesFromTx(t));
    setVoucherDate(t.date);
    voucherForm.reset({ type: t.type, date: t.date, narration: cleanText(t.narration || "") });
    setEditTx(t);
    setCopyTx(null);
    setSelected(null);
    setTab("new");
    setStatus("Editing existing voucher. Review changes carefully before updating.");
    return true;
  }

  // Same "caller must check the return value before closing" contract as editVoucher above.
  function copyVoucher(t: Tx): boolean {
    if (!t.entries.some((e) => e.amount < 0) || !t.entries.some((e) => e.amount > 0)) {
      setStatus("This voucher does not contain both debit and credit lines.");
      return false;
    }
    setVoucherLines(draftLinesFromTx(t));
    setVoucherDate(t.date);
    voucherForm.reset({ type: t.type, date: t.date, narration: cleanText(t.narration || "") });
    setCopyTx(t);
    setEditTx(null);
    setSelected(null);
    setTab("new");
    setStatus(
      "Voucher copied with all ledger lines. Change any field, then save as a new voucher."
    );
    return true;
  }

  async function add(values: VoucherEntryFormValues) {
    if (!data) return;
    const byId = new Map(data.accounts.map((a) => [a.id, a.name])),
      entries = voucherLines
        .map((line) => {
          const accountId = Number(line.accountId),
            amount = Math.abs(Number(line.amount || 0));
          return {
            accountId,
            accountName: byId.get(accountId) || "",
            amount: line.side === "debit" ? -amount : amount,
          };
        })
        .filter((e) => e.accountId && centsOf(e.amount) !== 0),
      debitTotal = entries.filter((e) => e.amount < 0).reduce((s, e) => s - e.amount, 0),
      creditTotal = entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
    if (entries.length < 2) {
      setStatus("Enter at least two voucher lines.");
      return;
    }
    if (!debitTotal || !creditTotal) {
      setStatus("Voucher must contain both debit and credit lines.");
      return;
    }
    if (centsOf(debitTotal) !== centsOf(creditTotal)) {
      setStatus("Debit total and credit total must be equal.");
      return;
    }
    const type = values.type,
      date = values.date;
    const tx: Tx = {
      id: editTx?.id || nextTransactionIds(data.transactions, 1)[0],
      guid: editTx?.guid || crypto.randomUUID(),
      ...(editTx
        ? {
            tallyGuid: editTx.tallyGuid,
            syncFingerprint: editTx.syncFingerprint || `app-change-${Date.now()}`,
            lastSyncedAt: undefined,
            createdAt: editTx.createdAt,  // preserve original creation time on edits
          }
        : { createdAt: new Date().toISOString() }),
      syncStatus: "pending",
      date,
      number:
        editTx && editTx.type === type && fiscalYearOf(editTx.date) === fiscalYearOf(date)
          ? editTx.number
          : nextVoucherNumber(data, type, date, editTx?.guid),
      type,
      narration: values.narration,
      historical: editTx?.historical || false,
      cancelled: editTx?.cancelled || false,
      entries,
    };
    const validation = validateVoucher(tx, data.accounts);
    if (!validation.valid) {
      setStatus(validation.errors.join(" "));
      return;
    }
    const nextTransactions = editTx
      ? data.transactions.map((t) => (t.guid === editTx.guid ? tx : t))
      : [...data.transactions, tx];
    if (await save({ ...data, transactions: nextTransactions })) {
      setCopyTx(null);
      setEditTx(null);
      setVoucherLines(blankVoucherLines());
    }
  }

  const startNewVoucher = (type?: string) => {
    setEditTx(null);
    setCopyTx(null);
    setSelected(null);
    setSelectedVoucher(null);
    setNewVoucherType(type || null);
    setNewVoucherMenuOpen(false);
    const today = new Date().toISOString().slice(0, 10);
    setVoucherDate(today);
    voucherForm.reset({ type: type || "Payment", date: today, narration: "" });
    setTab("new");
    setStatus("");
  };

  const voucherDebitDraftTotal = voucherLines
      .filter((l) => l.side === "debit")
      .reduce((s, l) => s + Math.abs(Number(l.amount || 0)), 0),
    voucherCreditDraftTotal = voucherLines
      .filter((l) => l.side === "credit")
      .reduce((s, l) => s + Math.abs(Number(l.amount || 0)), 0);

  return {
    copyTx,
    setCopyTx,
    editTx,
    setEditTx,
    newVoucherType,
    setNewVoucherType,
    newVoucherMenuOpen,
    setNewVoucherMenuOpen,
    inlineLedgerSide,
    setInlineLedgerSide,
    voucherLines,
    setVoucherLines,
    voucherDate,
    setVoucherDate,
    voucherForm,
    createLedgerInsideVoucher,
    editVoucher,
    copyVoucher,
    add,
    startNewVoucher,
    voucherDebitDraftTotal,
    voucherCreditDraftTotal,
  };
}
