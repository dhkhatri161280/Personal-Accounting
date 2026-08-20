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

async function loadEnrollments(): Promise<Enrollment[]> {
  try {
    const raw = await bindings.VAULT.get(ENROLLMENTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// List enrollments — strips access_token before sending to client
export async function GET() {
  const enrollments = await loadEnrollments();
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

  const enrollments = await loadEnrollments();
  const filtered = enrollments.filter((e) => e.enrollment_id !== body.enrollment_id);
  await bindings.VAULT.put(ENROLLMENTS_KEY, JSON.stringify(filtered));
  return Response.json({ ok: true, removed: enrollments.length - filtered.length });
}
