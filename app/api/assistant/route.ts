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
// end encrypted and this route never sees decrypted ledger data. Phase 2 (tool-calling, see
// lib/assistant-tools.ts) keeps that exactly the same -- this route only ever sees a tool NAME and
// ARGUMENTS the model chose, and relays the already-computed tool RESULT the client sends back; it
// never reads from KV/D1/R2 for the user's financial data and never executes a tool itself.
//
// Phase 1 of this feature built one big text "snapshot" of the user's data and asked the model to
// read, filter, and sum it in its own head -- and kept failing the same way under different names
// (wrong refund signs, dropped vouchers while summing a list, "this fiscal year" silently answered
// from one month's data). Phase 2 replaces that with real tools (lib/assistant-tools.ts) that
// compute exact, already-correct answers in code; the model's only job now is choosing which tool
// to call with what arguments. @cf/meta/llama-3.3-70b-instruct-fp8-fast supports Workers AI's
// function-calling `tools` request parameter and `tool_calls` response field natively (confirmed
// against Cloudflare's own model catalog and function-calling docs before building this).
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const SYSTEM_PROMPT = `You are a helpful assistant embedded in a personal accounting app. You do
NOT have the user's financial data in front of you -- you must call one of the provided tools to
look up anything real (balances, spending, salary, FBAR status). Never guess, estimate, or answer
from general knowledge about what a number might be.

CRITICAL: pick the right tool.
- A specific GL/ledger account is named (e.g. "check the Vehicle Maintenance account") ->
  get_account_ledger. This returns EVERY voucher in that account, regardless of narration.
- A short, specific, capitalized-sounding term that could plausibly BE the name of a real account
  (e.g. "ESPP", "RSU", "401k", "NVDA", "Vehicle Maintenance") -> TRY get_account_ledger FIRST, even
  if the question doesn't say the word "account". If its result says "no account found with that
  name", THEN fall back to search_vouchers. Do not default straight to search_vouchers for a term
  like this -- search_vouchers matches narration OR account name as an OR across ALL accounts, so
  if two unrelated accounts both happen to contain the same word (e.g. one tracking a dollar
  deduction, another tracking a share count or market value), it silently blends numbers from BOTH
  into one nonsensical total. get_account_ledger is exact: one specific account, nothing else.
- A merchant or category is named that is clearly NOT an account name (e.g. "Costco spending",
  "gasoline") -> search_vouchers.
- Salary, paycheck, take-home, or tax-withheld -> get_salary_summary.
- A balance question ("how much is in my bank account", "what's my NVDA balance") ->
  get_account_balances. These are CUMULATIVE since the account opened, NOT a period total --
  never use this tool to answer a "how much did I spend/earn in period X" question.
- FBAR / FinCEN Form 114 (India book only) -> get_fbar_status.

CRITICAL: "calendar year" and "fiscal year" are DIFFERENT periods and are NEVER the same thing --
never say they're "also the same in this case". This app's books run Apr-Mar as the fiscal year,
NOT Jan-Dec. Use the tool's "period" argument to pick the right one: current_fiscal_year/
last_fiscal_year for anything the question calls "fiscal year" or "FY"; current_calendar_year/
last_calendar_year only when the question actually says "calendar year" or names a specific year
number; current_month for "this month"; all_time only when the question says "ever"/"all time"/
"total" with no period named at all. Never compute a date range yourself.

CRITICAL: every tool response that includes a "PRECOMPUTED TOTAL" (or "PRECOMPUTED TOTALS") line
is the ONLY number you may give for that total -- it was already computed correctly, including any
vouchers not shown in the list beneath it. Quote that exact number verbatim. Do NOT add up any
voucher lines yourself, do NOT mention only a subset of them as if that were the complete list, and
do NOT produce a different number from your own arithmetic. The voucher list under a PRECOMPUTED
TOTAL exists only so you can cite a few examples by name/date if asked.

CRITICAL: when a tool's result says "0 matching vouchers found" or "0 vouchers found", say plainly
you didn't find any, and name what you searched for -- never guess or connect it to an unrelated
voucher just because it was posted nearby in time or has a vague narration.

CRITICAL: before answering, reread your own reply and make sure it doesn't contradict itself --
e.g. finding something in one sentence and saying "I didn't find any" in the next.

CRITICAL: never answer a question about the user's own balances, spending, salary, or FBAR status
without calling a tool first -- you have no other source of truth for that, and a plausible-sounding
guess is not an answer. If a tool result starts with 'Tool "..." failed:', or says "Unknown tool" or
"no accountName given" / "no search terms given", that is NOT a real answer -- tell the user that
specific lookup didn't work (in plain terms, not the raw error) rather than inventing a number to
fill the gap, and retry with corrected arguments if the problem is obviously fixable (e.g. you
forgot a required argument).

You are not a tax or legal advisor -- for anything involving tax filings, legal compliance, or
investment decisions, remind the user to verify with a professional rather than treating your
answer as authoritative. Keep answers concise.`;

type ApiMessage = { role: "user" | "assistant" | "tool"; content: string };
type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };
type ToolCall = { name: string; arguments: Record<string, unknown> };

const MAX_MESSAGE_CHARS = 8000; // a tool result can be a sizeable voucher list; generous but still bounded
const MAX_MESSAGES = 40; // a handful of user turns, each possibly expanded into a few tool round-trips
const MAX_TOOLS = 10;

function isApiMessage(v: unknown): v is ApiMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (m.role === "user" || m.role === "assistant" || m.role === "tool") && typeof m.content === "string" && m.content.length <= MAX_MESSAGE_CHARS;
}

function isToolDef(v: unknown): v is ToolDef {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return typeof t.name === "string" && typeof t.description === "string" && typeof t.parameters === "object" && t.parameters !== null;
}

export async function POST(request: Request) {
  const denied = requireAccessToken(request, bindings);
  if (denied) return denied;

  let body: { messages?: unknown; tools?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages.filter(isApiMessage).slice(-MAX_MESSAGES) : [];
  if (!messages.length) return Response.json({ error: "Missing messages" }, { status: 400 });

  const tools = Array.isArray(body.tools) ? body.tools.filter(isToolDef).slice(0, MAX_TOOLS) : [];

  const fullMessages = [{ role: "system", content: SYSTEM_PROMPT }, ...messages];

  try {
    const result = (await bindings.AI.run(MODEL, { messages: fullMessages, tools, max_tokens: 1024 })) as {
      response?: string;
      tool_calls?: unknown;
    };
    // Defensive: only relay tool_calls entries shaped the way this route (and the client's
    // executeTool dispatch) expects -- a malformed entry from the model shouldn't propagate as a
    // crash on either side of the wire.
    const toolCalls = Array.isArray(result.tool_calls)
      ? result.tool_calls.filter((c): c is ToolCall => !!c && typeof c === "object" && typeof (c as ToolCall).name === "string")
      : [];
    if (toolCalls.length) {
      return Response.json({ toolCalls });
    }
    const reply = typeof result === "string" ? result : result.response;
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
