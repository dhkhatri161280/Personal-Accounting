// Seeds a synthetic encrypted vault into the local `vinext dev` server's KV binding, via the
// same PUT /api/vault endpoint production uses (see app/api/vault/route.ts). Uses realistic
// account names/shapes but fake dollar amounts -- safe to commit, never touches the real vault.
//
// Usage: start `npm run dev` in one terminal, then in another:
//   node scripts/seed-local-vault.mjs [--book=india] [--url=http://localhost:3000]
//
// Password for the seeded vault is always "devpass123" (local-only, throwaway).

import { encryptVault } from "../lib/vault-crypto.ts";

const SEED_PASSWORD = "devpass123";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);
const book = args.book === "india" ? "india" : "us";
const baseUrl = args.url || "http://localhost:3000";

const accounts = [
  { id: 1, name: "Bank Of America", parent: "Bank Accounts", category: "Bank", currency: "USD", openingBalance: -12500 },
  { id: 2, name: "Citi Credit Card", parent: "Credit Card", category: "Liability", currency: "USD", openingBalance: 850 },
  { id: 3, name: "AMEX Credit Card", parent: "Credit Card", category: "Liability", currency: "USD", openingBalance: 1200 },
  { id: 4, name: "Charles Schwab", parent: "Investments", category: "Investment", currency: "USD", openingBalance: -5000 },
  { id: 5, name: "Home", parent: "Fixed Assets", category: "Asset", currency: "USD", openingBalance: -750000 },
  { id: 6, name: "Interest on Home Loan", parent: "Indirect Expenses", category: "Expense", currency: "USD", openingBalance: 0 },
  { id: 7, name: "Salary Income", parent: "Direct Incomes", category: "Income", currency: "USD", openingBalance: 0 },
  { id: 8, name: "Other Income", parent: "Indirect Incomes", category: "Income", currency: "USD", openingBalance: 0 },
  { id: 9, name: "Groceries", parent: "Indirect Expenses", category: "Expense", currency: "USD", openingBalance: 0 },
  { id: 10, name: "Dining", parent: "Indirect Expenses", category: "Expense", currency: "USD", openingBalance: 0 },
  { id: 11, name: "Dignesh Khatri", parent: "Capital Account", category: "Capital", currency: "USD", openingBalance: -50000 },
  { id: 12, name: "Profit & Loss A/c", parent: "Current Liabilities", category: "Liability", currency: "USD", openingBalance: 0 },
];

const groups = [
  { name: "Bank Accounts", nature: "Bank" },
  { name: "Credit Card", nature: "Liability" },
  { name: "Investments", nature: "Investment" },
  { name: "Fixed Assets", nature: "Asset" },
  { name: "Capital Account", nature: "Capital" },
  { name: "Current Liabilities", nature: "Liability" },
  { name: "Direct Incomes", nature: "Income" },
  { name: "Indirect Incomes", nature: "Income" },
  { name: "Indirect Expenses", nature: "Expense" },
];

function tx(id, date, number, narration, entries) {
  return {
    id,
    guid: `seed-${id}`,
    date,
    number,
    type: "Journal",
    narration,
    historical: false,
    entries,
  };
}

const transactions = [
  tx(1, "2026-08-01", "1", "August salary", [
    { accountId: 1, accountName: "Bank Of America", amount: -8500 },
    { accountId: 7, accountName: "Salary Income", amount: 8500 },
  ]),
  tx(2, "2026-08-03", "2", "Grocery run", [
    { accountId: 9, accountName: "Groceries", amount: -240.55 },
    { accountId: 2, accountName: "Citi Credit Card", amount: 240.55 },
  ]),
  tx(3, "2026-08-05", "3", "Dinner out", [
    { accountId: 10, accountName: "Dining", amount: -86.2 },
    { accountId: 3, accountName: "AMEX Credit Card", amount: 86.2 },
  ]),
  tx(4, "2026-08-15", "4", "Mortgage Payment (Aug 2026)", [
    { accountId: 5, accountName: "Home", amount: -1850 },
    { accountId: 6, accountName: "Interest on Home Loan", amount: -1884.03 },
    { accountId: 1, accountName: "Bank Of America", amount: 3734.03 },
  ]),
  tx(5, "2026-08-20", "5", "Citi Credit Card Payment", [
    { accountId: 2, accountName: "Citi Credit Card", amount: -240.55 },
    { accountId: 1, accountName: "Bank Of America", amount: 240.55 },
  ]),
];

const ledger = {
  version: 1,
  company: "Seed Household (LOCAL DEV ONLY)",
  currency: "USD",
  createdAt: new Date().toISOString(),
  accounts,
  transactions,
  groups,
  fiscalYearStartMonth: 4,
};

const vault = await encryptVault(ledger, SEED_PASSWORD);
const body = JSON.stringify(vault);

const url = `${baseUrl}/api/vault${book === "india" ? "?book=india" : ""}`;

// Fetch current etag first (PUT requires If-Match when a vault already exists).
let ifMatch;
const head = await fetch(url, { method: "HEAD" });
if (head.ok) ifMatch = head.headers.get("etag") || undefined;

const res = await fetch(url, {
  method: "PUT",
  headers: { "Content-Type": "application/json", ...(ifMatch ? { "If-Match": ifMatch } : {}) },
  body,
});

if (!res.ok) {
  console.error(`Seed failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}

console.log(`Seeded local ${book} vault at ${url}`);
console.log(`Vault password: ${SEED_PASSWORD}`);
