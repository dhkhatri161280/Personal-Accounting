"use client";
import { useMemo, useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { ledgerBalanceAsOf } from "@/lib/vault-accounting";
import { fmtDate, todayLocalIso } from "@/lib/format-date";

const SENDER_NAME_KEY = "dk-balconfirm-sender-name";
const SENDER_ADDRESS_KEY = "dk-balconfirm-sender-address";
const RECIPIENT_ADDRESS_KEY_PREFIX = "dk-balconfirm-recipient-address-";
const RECIPIENT_EMAIL_KEY_PREFIX = "dk-balconfirm-recipient-email-";
const GREETING_KEY_PREFIX = "dk-balconfirm-greeting-";
const EMAIL_GREETING_KEY_PREFIX = "dk-balconfirm-email-greeting-";
const MOVEMENT_LABEL_KEY_PREFIX = "dk-balconfirm-movement-label-";

function loadStr(key: string): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(key) || "";
}

// Balance Confirmation Letter -- standard practice for any ledger (bank, loan, sundry
// debtor/creditor, ...): a letter stating the balance per your books as of a date, asking the
// other party to confirm or flag a discrepancy. The letter still renders as a plain printable
// view for the browser's own Print dialog, but also offers a real PDF download (jsPDF, client-
// side only, no server round-trip) since the email flow below needs an actual file to attach,
// not just a print-to-PDF the user has to remember to do first.
export function BalanceConfirmationLetter({ data, fmt }: { data: Ledger; fmt: (n: number) => string }) {
  const activeAccounts = useMemo(
    () => data.accounts.filter((a) => a.active !== false).slice().sort((a, b) => a.name.localeCompare(b.name)),
    [data.accounts]
  );

  const [accountId, setAccountId] = useState<number | "">("");
  const [asOfDate, setAsOfDate] = useState(todayLocalIso());
  const [letterDate, setLetterDate] = useState(todayLocalIso());
  // Optional -- only needed to generate the "Balance as on X / Less: repaid / Balance as on Y"
  // email summary below. Leaving it blank skips that breakdown (the printed letter itself never
  // needed a period, only a single as-of balance).
  const [periodStartDate, setPeriodStartDate] = useState("");
  // localStorage-saved override wins if the user has ever typed one in here before; otherwise
  // default from the Company profile (Masters > Settings), which now carries name/address too.
  const [senderName, setSenderName] = useState(loadStr(SENDER_NAME_KEY) || data.company || "");
  const [senderAddress, setSenderAddress] = useState(loadStr(SENDER_ADDRESS_KEY) || data.companyAddress || "");
  const [recipientAddress, setRecipientAddress] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  // Editable rather than auto-derived from the ledger name -- a ledger can be a bank/loan account
  // ("Dear Sir/Madam" fits) or a sundry debtor/creditor that's an actual person ("Dear Mr. Khatri"
  // fits better), and this app has no reliable way to tell those apart or infer an honorific from
  // a name string. Defaulting to the generic form and letting the user override it per letter
  // keeps this correct for both cases instead of guessing.
  const [greeting, setGreeting] = useState("Dear Sir/Madam,");
  // Separate from the formal letter greeting above -- an email to someone you know is usually
  // informal ("Bhavinbhai,") where the printed/attached letter itself stays formal.
  const [emailGreeting, setEmailGreeting] = useState("");
  const [movementLabel, setMovementLabel] = useState("");

  const account = activeAccounts.find((a) => a.id === accountId) || null;

  // Address/email default from this ledger's own Masters record (Masters > Ledgers) the first
  // time it's used here; a per-letter localStorage override (once you've edited it here before)
  // always wins over the master value, and editing it here never writes back to Masters.
  function selectAccount(id: number | "") {
    setAccountId(id);
    const master = id === "" ? null : activeAccounts.find((a) => a.id === id) || null;
    setRecipientAddress(id === "" ? "" : loadStr(RECIPIENT_ADDRESS_KEY_PREFIX + id) || master?.address || "");
    setRecipientEmail(id === "" ? "" : loadStr(RECIPIENT_EMAIL_KEY_PREFIX + id) || master?.email || "");
    setGreeting(id === "" ? "Dear Sir/Madam," : loadStr(GREETING_KEY_PREFIX + id) || "Dear Sir/Madam,");
    setEmailGreeting(id === "" ? "" : loadStr(EMAIL_GREETING_KEY_PREFIX + id));
    setMovementLabel(id === "" ? "" : loadStr(MOVEMENT_LABEL_KEY_PREFIX + id));
  }

  function persistFields() {
    localStorage.setItem(SENDER_NAME_KEY, senderName);
    localStorage.setItem(SENDER_ADDRESS_KEY, senderAddress);
    if (accountId === "") return;
    localStorage.setItem(GREETING_KEY_PREFIX + accountId, greeting);
    localStorage.setItem(RECIPIENT_ADDRESS_KEY_PREFIX + accountId, recipientAddress);
    localStorage.setItem(RECIPIENT_EMAIL_KEY_PREFIX + accountId, recipientEmail);
    localStorage.setItem(EMAIL_GREETING_KEY_PREFIX + accountId, emailGreeting);
    localStorage.setItem(MOVEMENT_LABEL_KEY_PREFIX + accountId, movementLabel);
  }

  function persistAndPrint() {
    persistFields();
    window.print();
  }

  const balance = account ? ledgerBalanceAsOf(data, account.id, asOfDate) : 0;
  const isDebit = balance >= 0;
  const sideLabel = isDebit ? "Debit" : "Credit";
  const openingBalance = account && periodStartDate ? ledgerBalanceAsOf(data, account.id, periodStartDate) : null;
  // Same-signed "amount that changed hands" between the two dates -- positive means the ledger's
  // balance shrank (a repayment, from this book's point of view), negative means it grew (more
  // was extended). Only meaningful once openingBalance exists (periodStartDate is set).
  const movement = openingBalance !== null ? Math.abs(openingBalance) - Math.abs(balance) : null;
  const balanceGrew = movement !== null && movement < 0;
  // "Less:"/"Add:" has to track the actual arithmetic (opening -+ this = closing), not just
  // whatever wording the user picks for the line below it -- a custom label like "Amount Paid to
  // X" doesn't tell you which direction the number moves, and showing "Less:" next to a balance
  // that went UP would make the walk not add up (confirmed live: exactly this looked wrong when
  // the balance grew but the section still said "Less:").
  const movementWord = balanceGrew ? "Add:" : "Less:";
  const defaultMovementLabel = movement !== null && account ? (balanceGrew ? `Additional amount to ${account.name}` : `Repaid by ${account.name}`) : "";

  const signatureLines = [
    `For ${senderName || "________________"}`,
    "",
    "",
    "",
    "Authorized Signatory",
    ...(senderAddress ? ["Address:", ...senderAddress.split("\n")] : []),
  ];

  // Plain-text summary matching the user's own established email style for this kind of letter --
  // an informal greeting, "please find attached", then an opening/less-repaid/closing balance
  // walk when a period start date is given, or just the single as-of balance otherwise.
  const emailBodyText = useMemo(() => {
    if (!account) return "";
    const lines: string[] = [];
    if (emailGreeting) lines.push(emailGreeting, "");
    lines.push(`Please find attached Account Confirmation as on ${fmtDate(asOfDate)}.`, "");
    if (openingBalance !== null) {
      lines.push(`Balance as on ${fmtDate(periodStartDate)} -\t\t${fmt(Math.abs(openingBalance))}`, "");
      lines.push(movementWord, "");
      lines.push(`${movementLabel || defaultMovementLabel}\t-\t\t${fmt(Math.abs(movement || 0))}`, "");
      lines.push(`Balance as on ${fmtDate(asOfDate)} -\t\t${fmt(Math.abs(balance))}`, "");
    } else {
      lines.push(`Balance as on ${fmtDate(asOfDate)} -\t\t${fmt(Math.abs(balance))} (${sideLabel})`, "");
    }
    lines.push("Thanks,");
    lines.push(senderName ? senderName.split(" ")[0] : "");
    return lines.join("\n");
  }, [account, emailGreeting, asOfDate, periodStartDate, openingBalance, movement, movementWord, movementLabel, defaultMovementLabel, balance, sideLabel, senderName, fmt]);

  async function copyEmailText() {
    try {
      await navigator.clipboard.writeText(emailBodyText);
    } catch {
      // Clipboard permission can be denied in some browser contexts -- the textarea below still
      // shows the full text either way, so the user can select-and-copy manually as a fallback.
    }
  }

  async function downloadPdf() {
    if (!account) return;
    persistFields();
    // Loaded on demand (not a top-level import) so jsPDF -- and its optional html2canvas/dompurify
    // dependants -- only enter the bundle when this letter's PDF is actually requested, instead of
    // on every load of the vault app.
    const { default: jsPDF } = await import("jspdf");
    const doc = new jsPDF({ unit: "pt", format: "letter" });
    const marginX = 56, pageWidth = 612, pageHeight = 792, maxWidth = pageWidth - marginX * 2, lineGap = 15;
    let y = 56;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    // jsPDF's built-in "helvetica" is one of the 14 standard PDF fonts -- WinAnsi-encoded, so it
    // has no glyph for ₹ (U+20B9) or most other non-Latin-1 currency symbols. Passing one through
    // renders as garbled/mis-spaced text (confirmed live: "₹2,65,000.00" came out as a stray
    // superscript mark followed by letter-spaced digits). Embedding a Unicode font just to fix one
    // symbol is a lot of added weight for this one-off document, so the PDF-only amount formatter
    // below swaps ₹ for the plain-ASCII "Rs." prefix instead -- same fallback the user's own
    // plain-text emails already use for this exact reason. The on-screen preview and print view
    // keep the real fmt()/₹ output; only text fed into jsPDF goes through this.
    const pdfAmt = (n: number) => fmt(n).replace(/₹/g, "Rs. ").replace(/\s+/g, " ").trim();

    function ensureRoom(next = lineGap) {
      if (y + next > pageHeight - 56) {
        doc.addPage();
        y = 56;
      }
    }
    function para(text: string, opts?: { bold?: boolean; center?: boolean; gapAfter?: number }) {
      doc.setFont("helvetica", opts?.bold ? "bold" : "normal");
      const lines = doc.splitTextToSize(text, maxWidth) as string[];
      for (const line of lines) {
        ensureRoom();
        if (opts?.center) doc.text(line, pageWidth / 2, y, { align: "center" });
        else doc.text(line, marginX, y);
        y += lineGap;
      }
      y += opts?.gapAfter ?? 10;
    }

    para(fmtDate(letterDate));
    para(`To,\n${account.name}${recipientAddress ? "\n" + recipientAddress : ""}`);
    para(`Subject: Confirmation of Account Balance as on ${fmtDate(asOfDate)}`, { bold: true });
    para(greeting || "Dear Sir/Madam,");
    para(
      `As per our books of accounts, the balance in your account with us as on ${fmtDate(asOfDate)} stands at ${pdfAmt(Math.abs(balance))} (${sideLabel}).`
    );
    para(
      "Kindly confirm the correctness of the above balance by signing the confirmation slip below and returning it to us at your earliest convenience. If there are any discrepancies, please inform us within 15 days from the date of this letter."
    );
    para("If no response or objection is received within this period, the balance shown above will be deemed accepted and confirmed as correct.");
    para("Thanking you,", { gapAfter: 20 });
    para(signatureLines.join("\n"), { gapAfter: 24 });

    ensureRoom(20);
    doc.setLineDashPattern([3, 3], 0);
    doc.line(marginX, y, pageWidth - marginX, y);
    doc.setLineDashPattern([], 0);
    y += 24;

    para("CONFIRMATION SLIP (To be returned to the sender)", { bold: true, center: true });
    para(
      `I/We hereby confirm that the balance of ${pdfAmt(Math.abs(balance))} (${sideLabel}) as on ${fmtDate(asOfDate)} in my/our account with ${senderName || "________________"} is correct.`
    );
    para("Signature: ______________________", { gapAfter: 20 });
    para(`Name: ${account.name}`, { gapAfter: 20 });
    para("Date: __________________________");

    doc.save(`Balance Confirmation - ${account.name} - ${asOfDate}.pdf`);
  }

  return (
    <div className="data-panel">
      <h3>Balance Confirmation Letter</h3>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 10px" }}>
        Generates a standard confirmation letter stating the balance per your books as of a date, for the other party to confirm.
        Fill in the fields below, then download the PDF and copy the email text to send manually.
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
          Balance from (optional, for email summary)
          <input type="date" value={periodStartDate} onChange={(e) => setPeriodStartDate(e.target.value)} />
        </label>
        <label>
          Recipient address (optional)
          <textarea rows={2} value={recipientAddress} onChange={(e) => setRecipientAddress(e.target.value)} placeholder="Street, City, State, ZIP" />
        </label>
        <label>
          Recipient email (optional)
          <input type="email" value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} placeholder="name@example.com" />
        </label>
        <label>
          Greeting (letter)
          <input value={greeting} onChange={(e) => setGreeting(e.target.value)} placeholder="Dear Sir/Madam," />
        </label>
        <label>
          Greeting (email)
          <input value={emailGreeting} onChange={(e) => setEmailGreeting(e.target.value)} placeholder="Bhavinbhai," />
        </label>
        {openingBalance !== null && (
          <label>
            Movement label (email)
            <input value={movementLabel} onChange={(e) => setMovementLabel(e.target.value)} placeholder={defaultMovementLabel} />
          </label>
        )}
        <label>
          Your name (sender)
          <input value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="Dignesh Khatri" />
        </label>
        <label>
          Your address (sender)
          <textarea rows={2} value={senderAddress} onChange={(e) => setSenderAddress(e.target.value)} placeholder="Street, City, State, ZIP" />
        </label>
      </div>

      <div className="bcl-actions">
        <button type="button" className="tr-refresh-btn" disabled={!account} onClick={downloadPdf}>
          ⬇ Download PDF
        </button>
        <button type="button" className="tr-refresh-btn" disabled={!account} onClick={persistAndPrint}>
          🖨 Print
        </button>
      </div>

      {!account ? (
        <p style={{ opacity: 0.7 }}>Select a ledger above to preview the letter.</p>
      ) : (
        <>
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
              <p>{greeting || "Dear Sir/Madam,"}</p>
              <p>
                As per our books of accounts, the balance in your account with us as on <strong>{fmtDate(asOfDate)}</strong> stands at{" "}
                <strong>
                  {fmt(Math.abs(balance))} ({sideLabel})
                </strong>
                .
              </p>
              <p>
                Kindly confirm the correctness of the above balance by signing the confirmation slip below and returning it to us at your
                earliest convenience. If there are any discrepancies, please inform us within 15 days from the date of this letter.
              </p>
              <p>
                If no response or objection is received within this period, the balance shown above will be deemed accepted and confirmed
                as correct.
              </p>
              <p>Thanking you,</p>
              <p className="bcl-sig">
                For {senderName || "________________"}
                <br />
                <br />
                <br />
                Authorized Signatory
                {senderAddress && (
                  <>
                    <br />
                    Address:
                    <br />
                    {senderAddress.split("\n").map((line, i) => (
                      <span key={i}>
                        {line}
                        <br />
                      </span>
                    ))}
                  </>
                )}
              </p>
              <div className="bcl-slip">
                <p className="bcl-slip-title">CONFIRMATION SLIP (To be returned to the sender)</p>
                <p>
                  I/We hereby confirm that the balance of{" "}
                  <strong>
                    {fmt(Math.abs(balance))} ({sideLabel})
                  </strong>{" "}
                  as on <strong>{fmtDate(asOfDate)}</strong> in my/our account with {senderName || "________________"} is correct.
                </p>
                <p className="bcl-slip-line">Signature: ______________________</p>
                <p className="bcl-slip-line">Name: {account.name}</p>
                <p className="bcl-slip-line">Date: __________________________</p>
              </div>
            </div>
          </div>

          <div className="bcl-email-box">
            <div className="bcl-email-box-head">
              <h4>Email body text</h4>
              <button type="button" className="tr-refresh-btn" onClick={copyEmailText}>
                📋 Copy
              </button>
            </div>
            <textarea readOnly rows={10} value={emailBodyText} onClick={(e) => (e.target as HTMLTextAreaElement).select()} />
          </div>
        </>
      )}
    </div>
  );
}
