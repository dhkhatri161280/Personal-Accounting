import { PWAServiceWorkerRegister } from "@/components/PWARegister";
import { GrApp } from "@/components/GrApp";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
export const dynamic = "force-dynamic";
export default function GR() {
  return (
    <main className="shell gr-books">
      <PWAServiceWorkerRegister />
      <section className="workspace">
        <AppErrorBoundary>
          <GrApp />
        </AppErrorBoundary>
      </section>
    </main>
  );
}
