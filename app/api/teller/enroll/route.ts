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

// Called after Teller Connect succeeds — stores the enrollment access token
export async function POST(request: Request) {
  let body: { access_token?: string; user_id?: string; institution_name?: string; enrollment_id?: string };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { access_token, user_id, institution_name, enrollment_id } = body;
  if (!access_token || !enrollment_id) {
    return new Response("Missing access_token or enrollment_id", { status: 400 });
  }

  let enrollments = await loadEnrollments();
  // Replace if same enrollment already exists
  enrollments = enrollments.filter((e) => e.enrollment_id !== enrollment_id);
  enrollments.push({
    access_token,
    user_id: user_id || "",
    institution_name: institution_name || "Bank",
    enrollment_id,
    connected_at: new Date().toISOString(),
  });

  try {
    await bindings.VAULT.put(ENROLLMENTS_KEY, JSON.stringify(enrollments));
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "write failed"), { status: 503 });
  }
  return Response.json({ ok: true, institution_name: institution_name || "Bank" });
}
