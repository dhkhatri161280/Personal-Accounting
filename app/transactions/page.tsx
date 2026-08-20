import { Nav } from "@/components/Nav";
import { getTransactions } from "@/lib/accounting";
export const dynamic = "force-dynamic";
export default async function Transactions() {
  const rows = await getTransactions(500);
  return (
    <main className="shell">
      <Nav />
      <section className="workspace">
        <header>
          <div>
            <small>TRANSACTIONS</small>
            <h1>Transaction history</h1>
            <p>Latest {rows.length} vouchers from your complete books</p>
          </div>
          <a className="action" href="/new-transaction">
            + New transaction
          </a>
        </header>
        <div className="data-panel">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Voucher</th>
                <th>Type</th>
                <th>Narration</th>
                <th className="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={r.id}>
                  <td>{r.transaction_date}</td>
                  <td>{r.voucher_number || "—"}</td>
                  <td>
                    <span className="pill">{r.voucher_type}</span>
                  </td>
                  <td>{r.narration || "—"}</td>
                  <td className="right">
                    {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
                      r.total || 0
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
