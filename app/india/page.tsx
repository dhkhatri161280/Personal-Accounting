import { PWAServiceWorkerRegister } from "@/components/PWARegister";
import { VaultApp } from "@/components/VaultApp";
export const dynamic = "force-dynamic";
export default function India() {
  return (
    <main className="shell india-books">
      <PWAServiceWorkerRegister />
      <section className="workspace">
        <VaultApp book="india" />
      </section>
    </main>
  );
}
