import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

const ENROLLMENTS_KEY = "teller.enrollments";

type Enrollment = {
  access_token: string;
  user_id: string;
  institution_name: string;
  enrollment_id: string;
  connected_at: string;
};

// Throws on a real storage failure instead of silently returning [] -- DELETE below writes
// back whatever this returns, so a swallowed read failure treated as "no enrollments" would
// wipe out every other already-connected bank on a transient KV hiccup.
async function loadEnrollments(): Promise<Enrollment[]> {
  const raw = await bindings.VAULT.get(ENROLLMENTS_KEY);
  return raw ? JSON.parse(raw) : [];
}

// List enrollments — strips access_token before sending to client
export async function GET() {
  let enrollments: Enrollment[];
  try {
    enrollments = await loadEnrollments();
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "read failed"), { status: 503 });
  }
  return Response.json(
    enrollments.map(({ access_token: _, ...e }) => e)
  );
}

// Remove an enrollment by enrollment_id
export async function DELETE(request: Request) {
  let body: { enrollment_id?: string };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!body.enrollment_id) return new Response("Missing enrollment_id", { status: 400 });

  let enrollments: Enrollment[];
  try {
    enrollments = await loadEnrollments();
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "read failed"), { status: 503 });
  }
  const filtered = enrollments.filter((e) => e.enrollment_id !== body.enrollment_id);
  try {
    await bindings.VAULT.put(ENROLLMENTS_KEY, JSON.stringify(filtered));
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "write failed"), { status: 503 });
  }
  return Response.json({ ok: true, removed: enrollments.length - filtered.length });
}
