import { env } from "cloudflare:workers";
import type { AppBindings } from "@/lib/cloudflare-env";

const bindings = env as unknown as AppBindings;
export const dynamic = "force-dynamic";

const ENROLLMENTS_KEY = "teller.enrollments";
const TELLER_BASE = "https://api.teller.io";

type Enrollment = {
  access_token: string;
  institution_name: string;
  enrollment_id: string;
};

type TellerAccount = {
  id: string;
  name: string;
  type: string; // "depository" | "credit"
  subtype: string; // "checking" | "savings" | "credit_card" etc.
  institution: { name: string };
  enrollment_id: string;
};

type TellerTransaction = {
  id: string;
  account_id: string;
  date: string;
  description: string;
  amount: string; // Teller uses strings: negative = money OUT, positive = money IN
  status: string;
  type: string;
  details?: {
    category?: string;
    counterparty?: { name?: string; type?: string };
  };
};

function tellerFetch(url: string, accessToken: string): Promise<Response> {
  const auth = "Basic " + btoa(accessToken + ":");
  // If TELLER_CERT binding is configured, use it for mTLS
  if (bindings.TELLER_CERT) {
    return bindings.TELLER_CERT.fetch(url, {
      headers: { Authorization: auth },
    });
  }
  // Fallback (sandbox/dev without cert — Teller may still work for test enrollments)
  return fetch(url, { headers: { Authorization: auth } });
}

export async function GET(request: Request) {
  let enrollments: Enrollment[] = [];
  try {
    const raw = await bindings.VAULT.get(ENROLLMENTS_KEY);
    if (raw) enrollments = JSON.parse(raw);
  } catch {}

  if (enrollments.length === 0) {
    return Response.json({ transactions: [], accounts: [], errors: [] });
  }

  const url = new URL(request.url);
  const fromDate = url.searchParams.get("from") ||
    new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const allTransactions: unknown[] = [];
  const allAccounts: unknown[] = [];
  const errors: string[] = [];

  await Promise.all(
    enrollments.map(async (enrollment) => {
      try {
        // 1. Fetch accounts for this enrollment
        const acctResp = await tellerFetch(`${TELLER_BASE}/accounts`, enrollment.access_token);
        if (!acctResp.ok) {
          const err = (await acctResp.json()) as { error?: { message?: string } };
          errors.push(`${enrollment.institution_name}: ${err.error?.message || "accounts fetch failed"}`);
          return;
        }
        const accounts = (await acctResp.json()) as TellerAccount[];

        for (const account of accounts) {
          allAccounts.push({
            ...account,
            institution_name: enrollment.institution_name,
          });

          // 2. Fetch transactions for each account
          const txResp = await tellerFetch(
            `${TELLER_BASE}/accounts/${account.id}/transactions?from_id=&count=500`,
            enrollment.access_token
          );
          if (!txResp.ok) continue;

          const txs = (await txResp.json()) as TellerTransaction[];
          for (const tx of txs) {
            if (tx.status !== "posted") continue;
            if (tx.date < fromDate) continue;

            // Normalise to our internal format:
            // Teller: negative amount = money OUT (expense/payment from your account)
            //         positive amount = money IN  (deposit/credit to your account)
            // Our convention (matching Plaid): positive = OUT, negative = IN
            const normalisedAmount = -parseFloat(tx.amount);

            allTransactions.push({
              transaction_id: tx.id,
              account_id: tx.account_id,
              date: tx.date,
              name: tx.description,
              merchant_name: tx.details?.counterparty?.name || null,
              amount: normalisedAmount,
              institution_name: enrollment.institution_name,
              account_type: account.type, // "depository" | "credit"
              account_subtype: account.subtype,
              pending: false,
              personal_finance_category: tx.details?.category
                ? { primary: tx.details.category, detailed: tx.details.category }
                : undefined,
            });
          }
        }
      } catch (e: any) {
        errors.push(`${enrollment.institution_name}: ${e.message}`);
      }
    })
  );

  // Sort newest first
  (allTransactions as any[]).sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  return Response.json({ transactions: allTransactions, accounts: allAccounts, errors });
}
