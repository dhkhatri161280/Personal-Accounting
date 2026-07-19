import { Nav } from "@/components/Nav";
import { GrApp } from "@/components/GrApp";
export const dynamic = "force-dynamic";
export default function GR() {
  return (
    <main className="shell gr-books">
      <Nav book="gr" />
      <section className="workspace">
        <GrApp />
      </section>
    </main>
  );
}
