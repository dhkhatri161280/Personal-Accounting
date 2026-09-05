"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";

type Mode = "standalone" | "tally";
type Tab = "dashboard" | "voucher" | "daybook" | "ledgers" | "masters" | "reports" | "connector";

type Ledger = {
  id: string;
  name: string;
  group: string;
  opening: number;
};

type Voucher = {
  id: string;
  date: string;
  type: string;
  dr: string;
  cr: string;
  amount: number;
  narration: string;
};

type Book = {
  id: string;
  mode: Mode;
  userId: string;
  companyName: string;
  address: string;
  currency: string;
  fiscalMonth: string;
  backupPath: string;
  ledgers: Ledger[];
  vouchers: Voucher[];
};

const KEY = "fintech-by-dk-generic-clean-v1";

const starterLedgers: Ledger[] = [
  { id: "cash", name: "Cash", group: "Cash/Bank", opening: 0 },
  { id: "bank", name: "Bank Account", group: "Cash/Bank", opening: 0 },
  { id: "capital", name: "Capital Account", group: "Capital", opening: 0 },
  { id: "income", name: "General Income", group: "Income", opening: 0 },
  { id: "expense", name: "General Expense", group: "Expense", opening: 0 },
];

function money(currency: string, value: number) {
  const code = /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    currencyDisplay: "narrowSymbol",
  }).format(Math.abs(value) < 0.005 ? 0 : value);
}

function dmy(value: string) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : value;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function id() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function Home() {
  const [ready, setReady] = useState(false);
  const [book, setBook] = useState<Book | null>(null);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [mode, setMode] = useState<Mode>("standalone");
  const [message, setMessage] = useState("");

  const [voucher, setVoucher] = useState({
    date: today(),
    type: "Payment",
    dr: "General Expense",
    cr: "Bank Account",
    amount: "",
    narration: "",
  });

  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has("clean")) {
        localStorage.removeItem(KEY);
        url.search = "";
        url.searchParams.set("fresh", Date.now().toString());
        window.history.replaceState(null, "", url.toString());
      }

      const saved = localStorage.getItem(KEY);
      if (saved) setBook(JSON.parse(saved));
    } catch {
      localStorage.removeItem(KEY);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (book) localStorage.setItem(KEY, JSON.stringify(book));
  }, [book, ready]);

  const totals = useMemo(() => {
    if (!book) return { income: 0, expense: 0, cash: 0 };
    let income = 0;
    let expense = 0;
    let cash = 0;

    for (const v of book.vouchers) {
      const drLedger = book.ledgers.find((l) => l.name === v.dr);
      const crLedger = book.ledgers.find((l) => l.name === v.cr);

      if (crLedger?.group === "Income") income += v.amount;
      if (drLedger?.group === "Expense") expense += v.amount;

      if (drLedger?.group === "Cash/Bank") cash += v.amount;
      if (crLedger?.group === "Cash/Bank") cash -= v.amount;
    }

    return { income, expense, cash };
  }, [book]);

  function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const userId = String(form.get("userId") || "").trim();
    const password = String(form.get("password") || "");
    const confirm = String(form.get("confirm") || "");
    const companyName = String(form.get("companyName") || "").trim();
    const backupPath = String(form.get("backupPath") || "").trim();

    if (!userId) return setMessage("Enter user ID or email.");
    if (password.length < 4) return setMessage("Password must be at least 4 characters.");
    if (password !== confirm) return setMessage("Password and confirm password must match.");
    if (mode === "standalone" && !companyName) return setMessage("Enter company name.");
    if (mode === "tally" && !backupPath) return setMessage("Enter Tally backup folder path.");

    const next: Book = {
      id: id(),
      mode,
      userId,
      companyName: mode === "tally" ? companyName || "Tally Migration" : companyName,
      address: String(form.get("address") || "").trim(),
      currency:
        String(form.get("currency") || "USD")
          .trim()
          .toUpperCase() || "USD",
      fiscalMonth: String(form.get("fiscalMonth") || "January"),
      backupPath,
      ledgers: starterLedgers,
      vouchers: [],
    };

    setBook(next);
    setTab(mode === "tally" ? "connector" : "dashboard");
    setMessage(
      mode === "tally"
        ? "Migration workspace created. Connector setup is next."
        : "Standalone workspace created."
    );
  }

  function saveVoucher(event: FormEvent) {
    event.preventDefault();
    if (!book) return;

    const amount = Number(voucher.amount);
    if (!amount || amount <= 0) return setMessage("Enter voucher amount.");
    if (voucher.dr === voucher.cr) return setMessage("Debit and credit ledger must be different.");

    const next: Voucher = {
      id: id(),
      date: voucher.date,
      type: voucher.type,
      dr: voucher.dr,
      cr: voucher.cr,
      amount,
      narration: voucher.narration,
    };

    setBook({ ...book, vouchers: [next, ...book.vouchers] });
    setVoucher({ ...voucher, amount: "", narration: "" });
    setTab("reports");
    setMessage("Voucher saved and reports refreshed.");
  }

  function addLedger(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!book) return;

    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") || "").trim();
    const group = String(form.get("group") || "Expense");

    if (!name) return setMessage("Enter ledger name.");
    if (book.ledgers.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
      return setMessage("Ledger already exists.");
    }

    setBook({ ...book, ledgers: [...book.ledgers, { id: id(), name, group, opening: 0 }] });
    event.currentTarget.reset();
    setMessage("Ledger created.");
  }

  if (!ready) return <div className="page">Loading...</div>;

  if (!book) {
    return (
      <main className="page">
        <Style />
        <section className="brand">
          <div className="logo">
            <span>D</span>
            <span>K</span>
          </div>
          <h1>
            FinTech by DK <b>Finance ERP</b>
          </h1>
        </section>

        <section className="setup">
          <div>
            <small>FINTECH BY DK - START</small>
            <h2>Start your books</h2>
            <p>Choose one option. The app asks only for what is needed.</p>
          </div>

          <div className="modes">
            <button
              className={mode === "standalone" ? "mode selected" : "mode"}
              onClick={() => setMode("standalone")}
            >
              <strong>Standalone</strong>
              <span>Create a company and use the ERP directly.</span>
            </button>
            <button
              className={mode === "tally" ? "mode tally selected" : "mode tally"}
              onClick={() => setMode("tally")}
            >
              <strong>Tally Migration</strong>
              <span>Enter only the backup folder path. Connector will read the data.</span>
            </button>
          </div>

          <form className="form-card" onSubmit={createWorkspace}>
            <label>
              User ID / email
              <input name="userId" placeholder="name@example.com" />
            </label>
            <label>
              Password
              <input name="password" type="password" />
            </label>
            <label>
              Confirm password
              <input name="confirm" type="password" />
            </label>

            {mode === "standalone" ? (
              <>
                <label>
                  Company name
                  <input name="companyName" placeholder="My Company Books" />
                </label>
                <label>
                  Address
                  <input name="address" placeholder="Optional" />
                </label>
                <label>
                  Currency
                  <input name="currency" defaultValue="USD" />
                </label>
              </>
            ) : (
              <>
                <label>
                  Workspace name
                  <input name="companyName" placeholder="Optional until import" />
                </label>
                <label className="wide">
                  Tally backup folder path
                  <input name="backupPath" placeholder="G:\\My Drive\\Tally App\\Data\\10010" />
                </label>
                <label>
                  Currency
                  <input name="currency" defaultValue="USD" />
                </label>
              </>
            )}

            <label>
              Financial year starts
              <select name="fiscalMonth" defaultValue="January">
                {["January", "April", "July", "October"].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>

            <div className="submit-row">
              <button className="primary">
                {mode === "tally" ? "Start Tally Migration" : "Create Standalone ERP"}
              </button>
              <span>{message}</span>
            </div>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <Style />
      <header className="app-head">
        <div className="logo">
          <span>D</span>
          <span>K</span>
        </div>
        <div>
          <small>FINTECH BY DK - GENERIC FINANCE ERP</small>
          <h1>{book.companyName}</h1>
          <p>
            {book.mode === "tally" ? "Tally Migration" : "Standalone ERP"} | {book.currency} |{" "}
            {book.ledgers.length} ledgers | {book.vouchers.length} vouchers
          </p>
        </div>
        <button
          onClick={() => {
            localStorage.removeItem(KEY);
            setBook(null);
          }}
        >
          Reset
        </button>
      </header>

      <nav className="tabs">
        {(["dashboard", "voucher", "daybook", "ledgers", "masters", "reports"] as Tab[]).map(
          (t) => (
            <button key={t} className={tab === t ? "selected" : ""} onClick={() => setTab(t)}>
              {t === "voucher" ? "New Voucher" : t[0].toUpperCase() + t.slice(1)}
            </button>
          )
        )}
        {book.mode === "tally" && (
          <button
            className={tab === "connector" ? "selected" : ""}
            onClick={() => setTab("connector")}
          >
            Connector
          </button>
        )}
      </nav>

      <section className="period">
        <strong>Financial period</strong>
        <span>
          FY 2026 ({book.fiscalMonth} 2026 - {book.fiscalMonth} 2027)
        </span>
        <em>Opening + period activity = closing</em>
      </section>

      {message && <div className="notice">{message}</div>}

      {tab === "dashboard" && (
        <section className="cards">
          <Card
            title="Cash and Bank"
            value={money(book.currency, totals.cash)}
            note="Closing position"
          />
          <Card title="Income" value={money(book.currency, totals.income)} note="Current period" />
          <Card
            title="Expense"
            value={money(book.currency, totals.expense)}
            note="Current period"
          />
          <Card title="Vouchers" value={String(book.vouchers.length)} note="Saved vouchers" />
        </section>
      )}

      {tab === "voucher" && (
        <form className="work-card voucher" onSubmit={saveVoucher}>
          <h2>New Voucher</h2>
          <label>
            Date
            <input
              type="date"
              value={voucher.date}
              onChange={(e) => setVoucher({ ...voucher, date: e.target.value })}
            />
          </label>
          <label>
            Type
            <select
              value={voucher.type}
              onChange={(e) => setVoucher({ ...voucher, type: e.target.value })}
            >
              <option>Payment</option>
              <option>Receipt</option>
              <option>Contra</option>
              <option>Journal</option>
            </select>
          </label>
          <label>
            Debit ledger
            <select
              value={voucher.dr}
              onChange={(e) => setVoucher({ ...voucher, dr: e.target.value })}
            >
              {book.ledgers.map((l) => (
                <option key={l.id}>{l.name}</option>
              ))}
            </select>
          </label>
          <label>
            Credit ledger
            <select
              value={voucher.cr}
              onChange={(e) => setVoucher({ ...voucher, cr: e.target.value })}
            >
              {book.ledgers.map((l) => (
                <option key={l.id}>{l.name}</option>
              ))}
            </select>
          </label>
          <label>
            Amount
            <input
              value={voucher.amount}
              onChange={(e) => setVoucher({ ...voucher, amount: e.target.value })}
            />
          </label>
          <label className="wide">
            Narration
            <input
              value={voucher.narration}
              onChange={(e) => setVoucher({ ...voucher, narration: e.target.value })}
            />
          </label>
          <button className="primary">Save Voucher and View Reports</button>
        </form>
      )}

      {tab === "masters" && (
        <form className="work-card" onSubmit={addLedger}>
          <h2>Create Ledger</h2>
          <label>
            Ledger name
            <input name="name" />
          </label>
          <label>
            Group
            <select name="group">
              <option>Cash/Bank</option>
              <option>Capital</option>
              <option>Income</option>
              <option>Expense</option>
              <option>Asset</option>
              <option>Liability</option>
            </select>
          </label>
          <button className="primary">Create Ledger</button>
        </form>
      )}

      {(tab === "ledgers" || tab === "daybook" || tab === "reports") && (
        <section className="work-card">
          <h2>{tab === "ledgers" ? "Ledgers" : tab === "daybook" ? "Day Book" : "Reports"}</h2>
          {tab === "ledgers" && (
            <Table
              rows={book.ledgers.map((l) => [l.name, l.group, money(book.currency, l.opening)])}
            />
          )}
          {tab === "daybook" && (
            <Table
              rows={book.vouchers.map((v) => [
                dmy(v.date),
                v.type,
                v.dr,
                v.cr,
                money(book.currency, v.amount),
                v.narration,
              ])}
            />
          )}
          {tab === "reports" && (
            <Table
              rows={[
                ["Income", money(book.currency, totals.income)],
                ["Expense", money(book.currency, totals.expense)],
                ["Profit / Loss", money(book.currency, totals.income - totals.expense)],
                ["Cash and Bank", money(book.currency, totals.cash)],
              ]}
            />
          )}
        </section>
      )}

      {tab === "connector" && (
        <section className="work-card">
          <h2>Tally Migration Connector</h2>
          <p>
            Backup folder saved: <strong>{book.backupPath || "Not entered"}</strong>
          </p>
          <p>
            The next version will package the Windows connector install behind one button. For now
            this workspace is safe and no longer crashes.
          </p>
        </section>
      )}
    </main>
  );
}

function Card({ title, value, note }: { title: string; value: string; note: string }) {
  return (
    <article className="card">
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function Table({ rows }: { rows: string[][] }) {
  if (!rows.length) return <p>No records yet.</p>;
  return (
    <table>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Style() {
  return (
    <style>{`
    *{box-sizing:border-box}body{margin:0;background:#eef8ff;color:#082044;font-family:Arial,sans-serif}.page{min-height:100vh;padding:24px 32px}.brand{height:140px;background:#dff3e7;margin:-24px -32px 24px;display:flex;align-items:center;justify-content:center;gap:18px}.logo{width:58px;height:58px;border-radius:14px;background:white;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:22px;box-shadow:0 8px 20px #0001}.logo span:first-child{color:#a75b00}.logo span:last-child{color:#06498f}.brand h1{font-size:28px;margin:0}.brand b{color:#9a5a00;font-size:18px}.setup,.app-head,.work-card,.period,.notice{max-width:1180px;margin:0 auto 14px}.setup small,.app-head small{color:#7689a5;font-weight:900;letter-spacing:.15em}.setup h2,.app-head h1{font-size:30px;margin:12px 0 8px}.setup p,.app-head p{color:#516987}.modes{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:18px 0}.mode{border:2px solid #79b3ff;background:#f1f8ff;border-radius:14px;padding:20px;text-align:left;cursor:pointer}.mode strong{display:block;font-size:23px;margin-bottom:10px}.mode span{font-size:14px;color:#365678}.mode.tally{border-color:#f0b044;background:#fff4de}.mode.selected{box-shadow:0 0 0 3px #2f6fed22}.form-card,.work-card{background:white;border:1px solid #cfe0f2;border-radius:14px;padding:18px;display:grid;grid-template-columns:1fr 1fr;gap:12px}.form-card label,.work-card label{font-weight:800;font-size:13px}.wide{grid-column:1/-1}input,select{width:100%;margin-top:6px;border:1px solid #c6d8ea;border-radius:10px;padding:11px;font-size:15px;background:#fbfdff}.submit-row{grid-column:1/-1;display:flex;align-items:center;gap:16px}.primary{background:#2f6fed;color:white;border:0;border-radius:10px;padding:13px 18px;font-size:16px;font-weight:900;cursor:pointer}button{border:1px solid #cfe0f2;background:white;border-radius:10px;padding:12px 16px;font-weight:900;cursor:pointer}.app-head{display:flex;align-items:center;gap:16px}.app-head>div:nth-child(2){flex:1}.tabs{max-width:1180px;margin:0 auto 14px;display:grid;grid-template-columns:repeat(7,1fr);gap:10px}.tabs .selected{background:#132746;color:white}.period{background:white;border:1px solid #cfe0f2;border-radius:12px;padding:14px 18px;display:flex;gap:20px;align-items:center}.period span{font-size:20px}.period em{margin-left:auto;color:#516987;font-style:normal}.notice{background:#fff7df;border:1px solid #e8c46b;border-radius:12px;padding:13px 16px;font-weight:800;color:#825300}.cards{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.card{background:white;border:1px solid #cfe0f2;border-radius:14px;padding:22px}.card span{color:#516987}.card strong{display:block;font-size:28px;margin:14px 0}.card small{color:#1b5db8}.voucher{grid-template-columns:repeat(2,1fr)}.voucher h2,.work-card h2{grid-column:1/-1;margin:0 0 8px}.work-card table{width:100%;border-collapse:collapse;grid-column:1/-1}.work-card td{border-bottom:1px solid #dce8f5;padding:12px}.work-card p{grid-column:1/-1;color:#516987;font-size:16px}@media(max-width:900px){.page{padding:16px}.brand{margin:-16px -16px 16px}.modes,.form-card,.work-card,.cards{grid-template-columns:1fr}.tabs{grid-template-columns:1fr 1fr}.period{display:block}.period span{display:block;margin-top:8px}.period em{display:block;margin-top:8px}.app-head{align-items:flex-start}.app-head h1{font-size:24px}}
  `}</style>
  );
}
