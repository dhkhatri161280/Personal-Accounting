import { Nav } from "@/components/Nav";
import { GrApp } from "@/components/GrApp";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
export const dynamic = "force-dynamic";
export default function GR() {
  return (
    <main className="shell gr-books">
      <Nav book="gr" />
      <section className="workspace">
        <AppErrorBoundary>
          <GrApp />
        </AppErrorBoundary>
      </section>
    </main>
  );
}
