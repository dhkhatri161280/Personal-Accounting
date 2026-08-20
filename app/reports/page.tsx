import { Nav } from "@/components/Nav";
import { getCategorySummary, getSummary } from "@/lib/accounting";
export const dynamic = "force-dynamic";
export default async function Reports() {
  const [summary, cats] = await Promise.all([getSummary(), getCategorySummary()]);
  return (
    <main className="shell">
      <Nav />
      <section className="workspace">
        <header>
          <div>
            <small>REPORTS</small>
            <h1>Financial overview</h1>
            <p>Live summary from the accounting database</p>
          </div>
        </header>
        <section className="stats">
          <article>
            <span>Accounts</span>
            <strong>{summary.accounts || 0}</strong>
            <small>Imported ledgers</small>
          </article>
          <article>
            <span>Vouchers</span>
            <strong>{summary.vouchers || 0}</strong>
            <small>Complete history</small>
          </article>
          <article>
            <span>Ledger entries</span>
            <strong>{summary.entries || 0}</strong>
            <small>Double-entry postings</small>
          </article>
          <article>
            <span>Coverage</span>
            <strong className="date-stat">{summary.first_date || "—"}</strong>
            <small>through {summary.last_date || "—"}</small>
          </article>
        </section>
        <div className="data-panel">
          <h3>Balances by account type</h3>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Accounts</th>
                <th className="right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {cats.map((c: any) => (
                <tr key={c.category}>
                  <td>
                    <span className="pill">{c.category}</span>
                  </td>
                  <td>{c.accounts}</td>
                  <td className={`right ${c.balance < 0 ? "negative" : ""}`}>
                    {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
                      c.balance || 0
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
