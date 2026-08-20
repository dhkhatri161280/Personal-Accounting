import { env } from "cloudflare:workers";
export type Account = {
  id: number;
  name: string;
  parent_name: string | null;
  category: string;
  currency: string;
  opening_balance: number;
  balance: number;
};
export type Transaction = {
  id: number;
  transaction_date: string;
  voucher_number: string | null;
  voucher_type: string;
  narration: string | null;
  is_historical: number;
  entry_count: number;
  total: number;
};
export type CategorySummary = { category: string; accounts: number; balance: number };
export async function getAccounts(): Promise<Account[]> {
  const r = await env.DB.prepare(
    `SELECT a.id,a.name,a.parent_name,a.category,a.currency,a.opening_balance,COALESCE(SUM(e.amount),0)+a.opening_balance balance FROM accounts a LEFT JOIN entries e ON e.account_id=a.id GROUP BY a.id ORDER BY a.category,a.name`
  ).all();
  return r.results as Account[];
}
export async function getTransactions(limit = 100): Promise<Transaction[]> {
  const r = await env.DB.prepare(
    `SELECT v.id,v.transaction_date,v.voucher_number,v.voucher_type,v.narration,v.is_historical,COUNT(e.id) entry_count,SUM(ABS(e.amount))/2 total FROM vouchers v LEFT JOIN entries e ON e.voucher_id=v.id GROUP BY v.id ORDER BY v.transaction_date DESC,v.id DESC LIMIT ?`
  )
    .bind(limit)
    .all();
  return r.results as Transaction[];
}
export async function getSummary(): Promise<Record<string, number | string | null>> {
  const r = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM accounts) accounts,(SELECT COUNT(*) FROM vouchers) vouchers,(SELECT COUNT(*) FROM entries) entries,(SELECT MIN(transaction_date) FROM vouchers) first_date,(SELECT MAX(transaction_date) FROM vouchers) last_date`
  ).first();
  return r as Record<string, number | string | null>;
}
export async function getCategorySummary(): Promise<CategorySummary[]> {
  const r = await env.DB.prepare(
    `SELECT a.category,COUNT(DISTINCT a.id) accounts,COALESCE(SUM(e.amount),0)+SUM(DISTINCT a.opening_balance) balance FROM accounts a LEFT JOIN entries e ON e.account_id=a.id GROUP BY a.category ORDER BY a.category`
  ).all();
  return r.results as CategorySummary[];
}
