import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

// Stateless by design: the vault is end-to-end encrypted and this route never sees decrypted
// data. The client sends whatever transaction + candidate-account context it wants considered;
// this route just calls the LLM and returns a suggestion, same shape every other buildDraft()
// fallback already returns (see components/vault/PlaidImport.tsx).
type CategorizeRequest = {
  transaction: { name: string; merchant_name?: string; amount: number; date: string; institution_name: string };
  candidateAccounts: { id: number; name: string; parent: string }[];
};

type CategorizeResult = { debitAccountId: number; creditAccountId: number; narration: string; confidence: number; reasoning?: string };

function isValidResult(e: unknown, validIds: Set<number>): e is CategorizeResult {
  if (!e || typeof e !== "object") return false;
  const w = e as Record<string, unknown>;
  if (typeof w.debitAccountId !== "number" || !validIds.has(w.debitAccountId)) return false;
  if (typeof w.creditAccountId !== "number" || !validIds.has(w.creditAccountId)) return false;
  if (w.debitAccountId === w.creditAccountId) return false;
  if (typeof w.narration !== "string" || !w.narration.trim()) return false;
  if (typeof w.confidence !== "number" || w.confidence < 0 || w.confidence > 1) return false;
  return true;
}

export async function POST(request: Request) {
  const apiKey = bindings.GROQ_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "GROQ_API_KEY not configured. Run: npx wrangler secret put GROQ_API_KEY --config wrangler.biometric.json" }, { status: 503 });
  }

  let body: CategorizeRequest;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const { transaction: tx, candidateAccounts } = body;
  if (!tx || !Array.isArray(candidateAccounts) || candidateAccounts.length < 2) {
    return new Response("Missing transaction or candidateAccounts", { status: 400 });
  }
  const validIds = new Set(candidateAccounts.map((a) => a.id));

  const accountList = candidateAccounts.map((a) => `${a.id}: ${a.name} (${a.parent})`).join("\n");
  const moneyDirection = tx.amount > 0 ? "money OUT of the bank (an expense/payment)" : "money IN to the bank (income/a deposit)";

  const prompt = `You are categorizing one personal bank transaction into a double-entry ledger.

TRANSACTION: "${tx.merchant_name || tx.name}" on ${tx.date}, $${Math.abs(tx.amount).toFixed(2)}, from ${tx.institution_name}. This is ${moneyDirection}.

CANDIDATE LEDGER ACCOUNTS (id: name (parent group)):
${accountList}

TASK: Pick the single most likely debit account id and credit account id from the list above (vault convention: Dr = negative, the account that decreases; Cr = positive, the account that increases -- for an expense, Dr the expense account and Cr the bank; for a deposit, Dr the bank and Cr the income account). Also write a short, natural narration (a few words, not the raw bank text) and a confidence 0-1 for how sure you are given only the merchant name and amount.

Return ONLY a JSON object: { "debitAccountId": number, "creditAccountId": number, "narration": "string", "confidence": number, "reasoning": "one short sentence" }

No markdown. No explanation outside the JSON. Both ids MUST be from the candidate list above.`;

  const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      max_tokens: 512,
      messages: [
        { role: "system", content: "You are a bookkeeping assistant. Return only a single valid JSON object, no markdown, no explanation." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    }),
  });

  if (!groqRes.ok) {
    const err = await groqRes.text();
    return Response.json({ error: `Groq API error: ${err}` }, { status: 502 });
  }

  const groqJson = (await groqRes.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const rawText = groqJson?.choices?.[0]?.message?.content ?? "";

  try {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object in response");
    const parsed = JSON.parse(match[0]) as unknown;
    if (!isValidResult(parsed, validIds)) throw new Error("Invalid or out-of-candidate-list result");
    return Response.json(parsed);
  } catch (e) {
    return Response.json({ error: `Parse error: ${String(e)}`, raw: rawText.slice(0, 500) }, { status: 502 });
  }
}
