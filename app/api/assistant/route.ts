import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";
import { requireAccessToken } from "@/lib/api-auth";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

// Free in-app chat assistant -- Cloudflare Workers AI, not the Anthropic API. Chosen specifically
// because it's genuinely free (10,000 Neurons/day, recurring, and the Free Workers plan has no
// way to pay for overage -- requests just fail past the cap, never a surprise bill) and because
// it's a native Workers binding (env.AI), not an outbound fetch() to a third party -- no API key
// to manage, no TLS/CORS surface at all (unlike the Treasury rate lookup this app tried and had
// to abandon, see lib/fbar.ts's own history).
//
// Stateless and vault-blind by design, same posture as app/api/categorize: the vault is end-to-
// end encrypted and this route never sees decrypted ledger data. The browser (which already has
// the decrypted Ledger in memory after unlock) computes a plain-text summary of whatever's
// relevant and sends THAT as `context` -- this route never reads from KV/D1/R2 for the user's
// financial data, only calls the model with what the client already chose to share.
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const SYSTEM_PROMPT = `You are a helpful assistant embedded in a personal accounting app. You can
see a snapshot of the user's own financial data below (account balances, recent activity, FBAR
status, etc.) -- answer their questions using ONLY that data. If something isn't in the snapshot,
say so plainly instead of guessing or making up a number. You are not a tax or legal advisor --
for anything involving tax filings, legal compliance, or investment decisions, remind the user to
verify with a professional rather than treating your answer as authoritative. Keep answers concise.`;

type ChatMessage = { role: "user" | "assistant"; content: string };

const MAX_MESSAGE_CHARS = 4000;
const MAX_CONTEXT_CHARS = 12000;
const MAX_HISTORY_MESSAGES = 12;

function isChatMessage(v: unknown): v is ChatMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (m.role === "user" || m.role === "assistant") && typeof m.content === "string";
}

export async function POST(request: Request) {
  const denied = requireAccessToken(request, bindings);
  if (denied) return denied;

  let body: { message?: unknown; context?: unknown; history?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return Response.json({ error: "Missing message" }, { status: 400 });
  if (message.length > MAX_MESSAGE_CHARS) {
    return Response.json({ error: `Message too long (max ${MAX_MESSAGE_CHARS} characters)` }, { status: 400 });
  }

  const context = typeof body.context === "string" ? body.context.slice(0, MAX_CONTEXT_CHARS) : "";

  const history = Array.isArray(body.history) ? body.history.filter(isChatMessage).slice(-MAX_HISTORY_MESSAGES) : [];

  const messages = [
    { role: "system", content: context ? `${SYSTEM_PROMPT}\n\n--- Financial data snapshot ---\n${context}` : SYSTEM_PROMPT },
    ...history,
    { role: "user", content: message },
  ];

  try {
    const result = await bindings.AI.run(MODEL, { messages, max_tokens: 1024 });
    const reply = typeof result === "string" ? result : (result as { response?: string }).response;
    if (!reply) return Response.json({ error: "Empty response from model" }, { status: 502 });
    return Response.json({ reply });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A real, expected case on the Free plan: the 10,000 Neurons/day pool is exhausted for
    // today. Surfaced as its own message rather than a generic failure, since it resolves on its
    // own (daily reset) and isn't something retrying or reporting as a bug would help with.
    const quotaExceeded = /neuron|quota|limit/i.test(msg);
    return Response.json(
      { error: quotaExceeded ? "Today's free AI usage limit has been reached -- it resets at midnight UTC." : `AI request failed: ${msg}` },
      { status: quotaExceeded ? 429 : 502 }
    );
  }
}
