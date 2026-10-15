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
see a snapshot of the user's own financial data below (account balances, this month's vouchers,
FBAR status, etc.) -- answer their questions using ONLY that data.

CRITICAL: when asked about a specific merchant, category, or kind of spending (e.g. "Costco",
"gasoline", "groceries"), search the voucher list for ones whose narration actually names it.
NEVER treat a voucher as a match just because its narration is vague, blank, generic (e.g. a bare
"C-STORE TRANS" or "POS Purchase" with no further description), or merely posted near another
matching voucher in time -- those are NOT evidence of what it actually was. If you find zero
vouchers that clearly match, say plainly "I didn't find any vouchers matching that" and list what
you searched, rather than guessing which unrelated voucher might be related. A wrong confident
answer about someone's real money is worse than an honest "I don't know."

CRITICAL: when asked to check a specific ACCOUNT (e.g. "check the Vehicle Maintenance account"),
each voucher line below ends with "[accounts: ...]" naming every account it actually posted to --
that is the ONLY way to know which account a voucher belongs to, so match against that list
exactly, not against narration text or a guess. Before answering, reread the voucher(s) you're
about to cite in the SAME reply and make sure your answer doesn't contradict what you just said
about them one sentence earlier -- a reply that finds a voucher in one sentence and says "I didn't
find any" in the next is worse than either answer alone.

CRITICAL: "calendar year" and "fiscal year" are DIFFERENT periods and are NEVER the same thing --
never say they're "also the same in this case" or otherwise treat them as interchangeable, even if
today's date happens to fall in both. If a "Calendar-year-to-date (CY...)" salary summary is
present, it covers Jan-Dec of the current calendar year ONLY -- use it for a question that actually
says "calendar year" or a specific year number, not "fiscal year". If a "Fiscal-year-to-date (FY...)"
salary summary is present, it covers the books' own Apr-Mar fiscal year (it states the exact FY and
date range in its own label) -- use THIS one, not the calendar-year one, whenever the question says
"fiscal year" or "FY". The two will usually be different numbers; if only one of the two sections is
present for what the question actually asked about, say plainly you don't have the other one, rather
than substituting it silently.

CRITICAL: the "All vouchers THIS CALENDAR MONTH ONLY" list below covers ONLY the current calendar
month -- it never contains anything from an earlier or later month, even if a fiscal year, quarter,
or other month is named in the question. The salary summaries above (if present) are the one
exception to that -- each covers its own whole year as labeled, not just this month.
If a "Fiscal-year search" section is ALSO present below, it covers the WHOLE CURRENT FISCAL YEAR
(it states the exact FY and date range at the top of that section) -- not just this month, but also
NOT every year the vault has ever had data for -- that matched the specific words in the user's own
question. If the question asks about a period OTHER than the current fiscal year (a specific past
year, "all time", "last year"), that section still does NOT cover it -- say plainly you only have
the current fiscal year's search results and this month's full list, and can't total that different
period. Only when NO "Fiscal-year search" section is present, and the question needs data wider
than the current month, should you say plainly that you only have this month's data on file --
never silently answer a wide-period question using just the current month's list as if it covered
the whole period asked about.

CRITICAL: a "Fiscal-year search" section's "PRECOMPUTED TOTAL" line is the ONLY number you may give
for that total -- it was already computed correctly over every real matching voucher, including any
that aren't shown in the voucher list below it. Quote that exact number verbatim. Do NOT add up the
voucher lines yourself, do NOT mention only a subset of them as if that were the complete list, and
do NOT produce a different number from your own arithmetic -- re-deriving the total yourself is how
a real matching voucher gets silently dropped and the total comes out wrong. The voucher list under
a PRECOMPUTED TOTAL is there only so you can cite a few examples by name/date if asked, never to
recompute the total.

When summing a spending total across several vouchers, pay close attention to each one's sign and
any "REFUND" note -- a negative amount or a REFUND note means that voucher is money coming back,
and must be SUBTRACTED from the total, never added as if it were a purchase.

You are not a tax or legal advisor -- for anything involving tax filings, legal compliance, or
investment decisions, remind the user to verify with a professional rather than treating your
answer as authoritative. Keep answers concise.`;

type ChatMessage = { role: "user" | "assistant"; content: string };

const MAX_MESSAGE_CHARS = 4000;
// Raised from an earlier 12000 -- a full current-month voucher list (lib/assistant-context.ts's
// own fix for the same incident this system prompt change addresses) can run well past that on a
// high-volume month, and silently truncating it here would cut the list off mid-month with no
// signal to the model that it's incomplete -- exactly the kind of gap that caused a wrong answer
// in the first place. Llama 3.3 70B's own context window has plenty of headroom for this.
const MAX_CONTEXT_CHARS = 60000;
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
