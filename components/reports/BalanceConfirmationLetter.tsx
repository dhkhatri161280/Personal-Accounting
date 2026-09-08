"use client";
import { useMemo, useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { ledgerBalanceAsOf } from "@/lib/vault-accounting";
import { fmtDate } from "@/lib/format-date";

const SENDER_NAME_KEY = "dk-balconfirm-sender-name";
const SENDER_ADDRESS_KEY = "dk-balconfirm-sender-address";
const RECIPIENT_ADDRESS_KEY_PREFIX = "dk-balconfirm-recipient-address-";

function loadStr(key: string): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(key) || "";
}

// Balance Confirmation Letter -- standard practice for any ledger (bank, loan, sundry
// debtor/creditor, ...): a letter stating the balance per your books as of a date, asking the
// other party to confirm or flag a discrepancy. No PDF library involved -- the letter renders as
// a plain printable view and the browser's own Print dialog (Save as PDF) produces the file,
// matching how this app avoids new dependencies for one-off document needs.
export function BalanceConfirmationLetter({ data, fmt }: { data: Ledger; fmt: (n: number) => string }) {
  const activeAccounts = useMemo(
    () => data.accounts.filter((a) => a.active !== false).slice().sort((a, b) => a.name.localeCompare(b.name)),
    [data.accounts]
  );

  const [accountId, setAccountId] = useState<number | "">("");
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().slice(0, 10));
  const [letterDate, setLetterDate] = useState(new Date().toISOString().slice(0, 10));
  // localStorage-saved override wins if the user has ever typed one in here before; otherwise
  // default from the Company profile (Masters > Settings), which now carries name/address too.
  const [senderName, setSenderName] = useState(loadStr(SENDER_NAME_KEY) || data.company || "");
  const [senderAddress, setSenderAddress] = useState(loadStr(SENDER_ADDRESS_KEY) || data.companyAddress || "");
  const [recipientAddress, setRecipientAddress] = useState("");

  const account = activeAccounts.find((a) => a.id === accountId) || null;

  function selectAccount(id: number | "") {
    setAccountId(id);
    setRecipientAddress(id === "" ? "" : loadStr(RECIPIENT_ADDRESS_KEY_PREFIX + id));
  }

  function persistAndPrint() {
    localStorage.setItem(SENDER_NAME_KEY, senderName);
    localStorage.setItem(SENDER_ADDRESS_KEY, senderAddress);
    if (accountId !== "") localStorage.setItem(RECIPIENT_ADDRESS_KEY_PREFIX + accountId, recipientAddress);
    window.print();
  }

  const balance = account ? ledgerBalanceAsOf(data, account.id, asOfDate) : 0;
  const isDebit = balance >= 0;
  const sideLabel = isDebit ? "Debit" : "Credit";

  return (
    <div className="data-panel">
      <h3>Balance Confirmation Letter</h3>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px" }}>
        Generates a standard confirmation letter stating the balance per your books as of a date, for the other party to confirm.
        Fill in the fields below, then Print / Save as PDF — only the letter itself is printed, not this form.
      </p>

      <div className="bcl-form">
        <label>
          Ledger
          <select value={accountId} onChange={(e) => selectAccount(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Select a ledger…</option>
            {activeAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Balance as of
          <input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
        </label>
        <label>
          Letter date
          <input type="date" value={letterDate} onChange={(e) => setLetterDate(e.target.value)} />
        </label>
        <label>
          Recipient address (optional)
          <textarea rows={2} value={recipientAddress} onChange={(e) => setRecipientAddress(e.target.value)} placeholder="Street, City, State, ZIP" />
        </label>
        <label>
          Your name (sender)
          <input value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="Dignesh Khatri" />
        </label>
        <label>
          Your address (sender)
          <textarea rows={2} value={senderAddress} onChange={(e) => setSenderAddress(e.target.value)} placeholder="Street, City, State, ZIP" />
        </label>
      </div>

      <button type="button" className="tr-refresh-btn" disabled={!account} onClick={persistAndPrint} style={{ margin: "12px 0" }}>
        🖨 Print / Save as PDF
      </button>

      {!account ? (
        <p style={{ opacity: 0.7 }}>Select a ledger above to preview the letter.</p>
      ) : (
        <div className="bcl-preview">
          <div className="bcl-print-area">
            <p className="bcl-date">{fmtDate(letterDate)}</p>
            <p className="bcl-to">
              To,
              <br />
              {account.name}
              {recipientAddress && (
                <>
                  <br />
                  {recipientAddress.split("\n").map((line, i) => (
                    <span key={i}>
                      {line}
                      <br />
                    </span>
                  ))}
                </>
              )}
            </p>
            <p>
              <strong>Subject: Confirmation of Account Balance as on {fmtDate(asOfDate)}</strong>
            </p>
            <p>Dear Sir/Madam,</p>
            <p>
              As per our books of accounts, the balance in your account with us as on <strong>{fmtDate(asOfDate)}</strong> stands at{" "}
              <strong>
                {fmt(Math.abs(balance))} ({sideLabel})
              </strong>
              .
            </p>
            <p>
              Kindly confirm the above balance at your earliest, or inform us of any discrepancy within 15 days from the date of this
              letter. If no response is received within this period, the balance shown above will be deemed confirmed as correct.
            </p>
            <p>Thanking you,</p>
            <p className="bcl-sig">
              For {senderName || "________________"}
              {senderAddress && (
                <>
                  <br />
                  {senderAddress.split("\n").map((line, i) => (
                    <span key={i}>
                      {line}
                      <br />
                    </span>
                  ))}
                </>
              )}
              <br />
              <br />
              <br />
              Authorized Signatory
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
