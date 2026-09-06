import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

// Total bytes + object count across the whole attachments bucket (both books share one bucket,
// keyed by book/txGuid/... -- see app/api/attachments/route.ts). R2 has no single "bucket size"
// call, so this lists every object and sums size -- cheap for a personal ledger's attachment
// count, paginated defensively in case that ever changes.
export async function GET() {
  let totalBytes = 0;
  let objectCount = 0;
  let cursor: string | undefined;
  try {
    do {
      const page = await bindings.ATTACHMENTS.list({ cursor, limit: 1000 });
      for (const obj of page.objects) totalBytes += obj.size;
      objectCount += page.objects.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (e: any) {
    return Response.json({ error: "Storage unavailable: " + (e?.message || "list failed") }, { status: 503 });
  }
  return Response.json({ totalBytes, objectCount });
}
