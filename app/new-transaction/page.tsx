import { Nav } from "@/components/Nav";
import { TransactionForm } from "@/components/TransactionForm";
import { getAccounts } from "@/lib/accounting";
export const dynamic = "force-dynamic";
export default async function NewTransaction() {
  const accounts = await getAccounts();
  return (
    <main className="shell">
      <Nav />
      <section className="workspace">
        <header>
          <div>
            <small>NEW ENTRY</small>
            <h1>Record transaction</h1>
            <p>Every entry posts equal debit and credit amounts.</p>
          </div>
        </header>
        <div className="data-panel form-panel">
          <TransactionForm accounts={accounts} />
        </div>
      </section>
    </main>
  );
}
