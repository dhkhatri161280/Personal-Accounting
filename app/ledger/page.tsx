import { Nav } from "@/components/Nav";
import { VaultApp } from "@/components/VaultApp";
export const dynamic = "force-dynamic";
export default function Ledger() {
  return (
    <main className="shell us-books">
      <Nav />
      <section className="workspace">
        <VaultApp />
      </section>
    </main>
  );
}
