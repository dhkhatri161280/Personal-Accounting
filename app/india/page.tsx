import { PWARegister } from "@/components/PWARegister";
import { VaultApp } from "@/components/VaultApp";
export const dynamic = "force-dynamic";
export default function India() {
  return (
    <main className="shell india-books">
      <PWARegister />
      <section className="workspace">
        <VaultApp book="india" />
      </section>
    </main>
  );
}
