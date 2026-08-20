import { Nav } from "@/components/Nav";
import { VaultApp } from "@/components/VaultApp";
export const dynamic = "force-dynamic";
export default function India() {
  return (
    <main className="shell india-books">
      <Nav book="india" />
      <section className="workspace">
        <VaultApp book="india" />
      </section>
    </main>
  );
}
