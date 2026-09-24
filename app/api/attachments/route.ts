import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { requireAccessToken, requireAccessTokenFromHeaderOrQuery } from "@/lib/api-auth";
import { DOCUMENT_MAX_SIZE_BYTES } from "@/lib/document-limits";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

const MAX_SIZE = DOCUMENT_MAX_SIZE_BYTES;

// Uploads one file to R2, keyed by book+voucher so US/India never collide and every attachment
// stays scoped to the voucher it was attached from. Returns just the metadata the client stores
// on Tx.attachments -- the vault blob never holds the file bytes themselves (see lib/vault-types.ts).
export async function POST(request: Request) {
  const denied = requireAccessToken(request, bindings);
  if (denied) return denied;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response("Invalid form data", { status: 400 });
  }
  const file = form.get("file");
  const book = String(form.get("book") || "");
  const txGuid = String(form.get("txGuid") || "");
  // "documents" = a personal document library upload (pay stub, grant agreement, ...), not tied
  // to any voucher -- see lib/vault-types.ts's VaultDocument. Everything else keeps the original
  // txGuid-required voucher-attachment behavior.
  const folder = String(form.get("folder") || "");
  if (!(file instanceof File) || !book || (!txGuid && folder !== "documents")) {
    return new Response("Missing file, book, or txGuid", { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return new Response(`File too large (max ${MAX_SIZE / 1024 / 1024}MB)`, { status: 400 });
  }

  const key =
    folder === "documents"
      ? `${book}/documents/${crypto.randomUUID()}-${file.name}`
      : `${book}/${txGuid}/${crypto.randomUUID()}-${file.name}`;
  try {
    await bindings.ATTACHMENTS.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
    });
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "upload failed"), { status: 503 });
  }

  return Response.json({
    key,
    filename: file.name,
    size: file.size,
    contentType: file.type || "application/octet-stream",
    uploadedAt: new Date().toISOString(),
  });
}

// Streams one attachment back for viewing/downloading. Reached via a plain <a href target="_blank">
// link (VaultApp.tsx), not a fetch() call -- token accepted via query param, see
// requireAccessTokenFromHeaderOrQuery.
export async function GET(request: Request) {
  const denied = requireAccessTokenFromHeaderOrQuery(request, bindings);
  if (denied) return denied;

  const key = new URL(request.url).searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });

  let object: R2ObjectBody | null;
  try {
    object = await bindings.ATTACHMENTS.get(key);
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "read failed"), { status: 503 });
  }
  if (!object) return new Response("Not found", { status: 404 });

  const filename = key.split("/").pop() ?? "attachment";
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": `inline; filename="${filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}

export async function DELETE(request: Request) {
  const denied = requireAccessToken(request, bindings);
  if (denied) return denied;

  const key = new URL(request.url).searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });
  try {
    await bindings.ATTACHMENTS.delete(key);
  } catch (e: any) {
    return new Response("Storage unavailable: " + (e?.message || "delete failed"), { status: 503 });
  }
  return Response.json({ ok: true });
}
