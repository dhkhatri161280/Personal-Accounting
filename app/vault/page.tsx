import { PWAServiceWorkerRegister } from "@/components/PWARegister";
import { VaultApp } from "@/components/VaultApp";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
export const dynamic = "force-dynamic";
export default function Vault() {
  return (
    <main className="shell us-books">
      <PWAServiceWorkerRegister />
      <section className="workspace">
        <AppErrorBoundary>
          <VaultApp />
        </AppErrorBoundary>
      </section>
    </main>
  );
}
