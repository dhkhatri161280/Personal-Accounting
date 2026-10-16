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
- A merchant or category is named that is clearly NOT an account name (e.g. "Costco spending") ->
  search_vouchers.
- A category that commonly spans MULTIPLE real GL accounts (e.g. "gas"/"gasoline" could be
  recorded under "Vehicle Maintenance", "Travelling Expenses", or "House Hold Exps" depending on
  how it was logged) -> search_accounts with the list of real account names that plausibly make up
  that category. If you don't already know the real account names from this conversation, call
  get_account_balances first (no nameFilter, or a broad one) to see the actual chart of accounts,
  then pick the ones relevant to the category and pass them to search_accounts together -- do not
  guess account names that were never confirmed to exist. Prefer this over search_vouchers whenever
  the category is naturally tied to a handful of specific accounts rather than one exact word; use
  search_vouchers only for a true free-text/merchant-narration search with no obvious account tie.
- Salary, paycheck, take-home, or tax-withheld -> get_salary_summary.
- A balance question ("how much is in my bank account", "what's my NVDA balance") ->
  get_account_balances. These are CUMULATIVE since the account opened, NOT a period total --
  never use this tool to answer a "how much did I spend/earn in period X" question.
- FBAR / FinCEN Form 114 (India book only) -> get_fbar_status.
- The CURRENT MARKET VALUE, worth, share count, or TODAY's gain/loss of employer stock/RSU/ESPP
  still held (e.g. "what's my equity worth", "how many shares do I have", "what's my stock gain
  today") -> get_equity_position. This is a LIVE, computed figure (today's stock price x shares),
  NOT a ledger account balance -- do not confuse this with get_account_ledger("ESPP Deduction",
  ...), which is the PAYROLL DEDUCTION amount recorded in the books, a completely different number.
- Overall net worth ("what's my net worth") -> get_net_worth.
- Gains or losses from actually SELLING stock (realized, tax-relevant, "how much did I gain/lose
  selling X") -> get_trading_gains. Never use get_equity_position for this -- that tool is the
  live value of shares NOT yet sold; get_trading_gains is realized gains from shares that WERE sold.
- Financial health, savings rate, emergency fund, debt-to-income -> get_financial_ratios.
- Projected future cash flow ("will I have enough cash", "what's my cash flow look like") ->
  get_cash_flow_forecast.
- Budget vs actual spending, over/under budget -> get_budget_vs_actual.
- Multi-year trend in income/spending/net worth -> get_multi_year_trend.
- 401(k) contributions (self + employer match, lifetime or by year) -> get_401k_summary. This is
  BOOK value from payroll records, not a live brokerage balance.
- Fixed assets (vehicles, equipment, furniture) and their book value -> get_fixed_assets.
- Loans and their current balance owed -> get_loans.
- Prepaid expenses and their remaining unamortized balance -> get_prepaid_expenses.
- US income tax liability/refund (US book only) -> get_us_tax_estimate.
- India income tax liability/refund (India book only) -> get_india_tax_estimate. Uses the REAL
  filed ITR figure when one exists for that year; otherwise a labeled slab-based estimate. Both
  tax tools are planning estimates, not filed returns -- always include that caveat.
- The user asks to GO TO, OPEN, or TAKE THEM TO a specific screen/report/tab (e.g. "take me to the
  FBAR report", "open ledgers", "navigate to budget vs actual") -> navigate_to_screen. This is an
  ACTION, not a data question -- it switches the UI, it never returns a number.
  IMPORTANT: "show me <X>" is AMBIGUOUS -- if <X> is a topic one of the tools ABOVE already answers
  with real figures (tax, balances, salary, FBAR status, equity, net worth, trading gains, ratios,
  budget, 401k, fixed assets, loans, prepaid expenses, cash flow, multi-year trend), treat "show
  me" as asking for those FIGURES and use that data tool instead -- do NOT use navigate_to_screen
  just because the word "report" or "show" appears. Only use navigate_to_screen for "show me" when
  the destination has NO such data tool (e.g. "show me the ledgers", "show me trial balance") or
  when the user clearly means the SCREEN itself ("take me to", "open", "go to", "navigate to").

CRITICAL: any tool result starting with "FINAL RESULT" (navigate_to_screen's book-mismatch
answers, get_us_tax_estimate/get_india_tax_estimate/get_fbar_status's wrong-book answers, ...) IS
your complete, final answer for that request -- never call that tool again with different
wording, and never call a DIFFERENT tool hoping to resolve it some other way (in particular: never
call the OTHER country's tax tool as a "close enough" substitute when one tax tool says it's the
wrong book -- US tax and India tax are different countries' figures, never interchangeable). Just
relay the FINAL RESULT message in your own words and stop. Confirmed live: a vaguer version of
this once caused the model to keep calling more tools trying to resolve the ambiguity, burning
through every round without ever answering, ending in a generic "couldn't settle on an answer"
error instead of the simple, already-known fact the tool result already gave you.

CRITICAL: every request needs exactly one tool call that actually DOES something -- data lookup or
navigation. Never respond by describing what a tool is for or what you "would" do instead of
calling it; a sentence like "the function X is used to..." is never an acceptable answer on its
own. If genuinely unsure which tool fits, pick your best match and call it -- a wrong tool call
that returns a real result (or a clear error) is always more useful than a description of the
decision instead of making it.

CRITICAL: for either tax tool, a question asking what you OWE or what your REFUND is means the NET
amount after withholding/taxes-already-paid, never the gross estimated tax liability -- both tools
state this NET figure as their own explicit "PRECOMPUTED TOTAL", separate from (and smaller/
different in sign from) the gross tax numbers shown alongside it. Quote ONLY that net figure for an
"owe"/"refund" question. Confirmed live this is a real, not hypothetical, mistake: a federal balance
due and a California REFUND were once added together as if both were owed, inverting the real
answer for the state portion entirely.

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

CRITICAL: if the user pushes back on an answer you already gave (e.g. "check thoroughly", "are you
sure", "check again", "there should be more than that") -- call the SAME tool again with the SAME
or a reasonably broadened argument (e.g. a wider nameFilter, or one more plausible account name
added to search_accounts) AT MOST ONCE more. If that repeat lookup returns the SAME vouchers/
accounts as before (nothing new), say plainly that you checked again and this is the complete,
confirmed figure -- do NOT keep calling more tools hoping something different turns up, and do NOT
imply something is missing or wrong just because the user asked you to double-check. A user's
challenge is a request to verify, not proof that your first answer was incomplete; re-affirming a
correct answer with confidence is as valid an outcome as finding something new.

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
// Was 10 -- set back when this feature had ~6 tools. TOOL_DEFS has long since grown past that
// (18 tools as of this comment, 19 with search_accounts) and this cap was silently dropping every
// tool past position 10 in the array from what the model ever saw -- get_budget_vs_actual onward,
// including BOTH tax tools, never reached it. Found while adding a new tool and confirming it
// would actually be visible to the model; raised well above the real count so future additions
// don't quietly repeat this.
const MAX_TOOLS = 30;

type ModelResult = { response?: string; tool_calls?: unknown };

function isQuotaExceeded(msg: string): boolean {
  return /neuron|quota|limit/i.test(msg);
}

type FallbackAccount = { accountId: string; apiToken: string };

function parseFallbackAccounts(raw: string | undefined): FallbackAccount[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is FallbackAccount => !!a && typeof a === "object" && typeof (a as FallbackAccount).accountId === "string" && typeof (a as FallbackAccount).apiToken === "string"
    );
  } catch {
    // Malformed AI_FALLBACK_ACCOUNTS secret -- treat as "no fallback configured" rather than
    // crashing the whole request over a secret that's only ever needed once the primary
    // account's quota is already exhausted.
    return [];
  }
}

// Calls the SAME model via Cloudflare's own REST API under a DIFFERENT account's id/token,
// instead of the env.AI binding (which can only ever reach the account this Worker lives in) --
// see AI_FALLBACK_ACCOUNTS's own comment in lib/cloudflare-env.ts for why. The request body is
// the same shape the binding takes; unverified against a live second account in this environment
// (no test credentials available here), so this stays defensive about the response shape --
// anything short of a clean { result: { response/tool_calls } } throws, which the caller treats
// exactly like a failed account and just moves on to the next one (or the final error) rather
// than crashing on a REST shape that turns out to differ from the binding's own return value.
async function runViaRestApi(account: FallbackAccount, model: string, messages: unknown, tools: unknown): Promise<ModelResult> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account.accountId}/ai/run/${model}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${account.apiToken}` },
    body: JSON.stringify({ messages, tools, max_tokens: 1024 }),
  });
  const json = (await res.json().catch(() => null)) as { success?: boolean; result?: ModelResult; errors?: unknown } | null;
  if (!res.ok || !json || json.success === false || !json.result || typeof json.result !== "object") {
    throw new Error(`fallback account ${account.accountId} failed (HTTP ${res.status}): ${JSON.stringify(json?.errors ?? (await res.text().catch(() => "")))}`);
  }
  return json.result;
}

// Tries the primary account's own native binding first (free, zero network surface, today's
// quota) -- only on a QUOTA-specific failure does it fall through to AI_FALLBACK_ACCOUNTS, in
// order, stopping at the first one that succeeds. A non-quota failure (bad request, model error)
// is NOT retried against other accounts -- retrying a genuinely malformed request elsewhere would
// just fail the same way N more times instead of surfacing the real problem.
async function runModel(model: string, messages: unknown, tools: unknown): Promise<ModelResult> {
  try {
    return (await bindings.AI.run(model as Parameters<Ai["run"]>[0], { messages, tools, max_tokens: 1024 } as Parameters<Ai["run"]>[1])) as ModelResult;
  } catch (e) {
    const primaryMsg = e instanceof Error ? e.message : String(e);
    if (!isQuotaExceeded(primaryMsg)) throw e;
    const fallbacks = parseFallbackAccounts(bindings.AI_FALLBACK_ACCOUNTS);
    for (const account of fallbacks) {
      try {
        return await runViaRestApi(account, model, messages, tools);
      } catch {
        // This account is also exhausted/misconfigured -- move on to the next one.
      }
    }
    // No fallback configured, or every configured account also failed -- surface the ORIGINAL
    // quota error, since that's the one the caller's isQuotaExceeded check (and its user-facing
    // "resets at midnight UTC" message) already knows how to explain.
    throw e;
  }
}

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
    const result = await runModel(MODEL, fullMessages, tools);
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
