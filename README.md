# FinTech by DK

A personal double-entry accounting app — Tally-style ledgers and vouchers, bank sync, equity
(RSU/ESPP) tracking, and a built-in US tax estimate engine — running as a single Next.js app
deployed to Cloudflare Workers.

Live at [personal-ledger-dk.digneshkhatri.workers.dev](https://personal-ledger-dk.digneshkhatri.workers.dev).

## Features

**Core ledger**
- Daybook, Ledgers, Masters (chart of accounts/groups), and a New Voucher entry form
- Double-entry bookkeeping with configurable account groups and voucher types
- Two-way sync with Tally (XML) for books also maintained in Tally

**Reports**
- Trial Balance, Balance Sheet, Cash Flow, Income & Expenditure, Reconciliation, Trash
- Equity — RSU vesting schedules and ESPP purchases, with live price lookup and realized
  gain/loss tracking
- Trading — open/closed positions and a watchlist
- Tax — payroll import from Excel, editable per-period paystub data, and a US federal + California
  state tax estimate engine (standard vs. itemized deduction, capital gains netting, RSU/ESPP sale
  classification)

**Bank & brokerage sync**
- Plaid and Teller integrations for automatic transaction import and payroll deposit matching

**Security**
- Client-side encrypted vault (password-derived key; nothing sensitive is stored in plaintext)
- WebAuthn/biometric unlock as a convenience layer on top of the password

**Multiple books**
- Separate ledgers for different accounting needs (US personal book, an India book, and a
  second personal ledger), each with its own Cloudflare Worker deployment

## Tech stack

- [Next.js](https://nextjs.org/) via [vinext](https://www.npmjs.com/package/vinext), React 19, TypeScript
- Deployed on [Cloudflare Workers](https://workers.cloudflare.com/) with KV (encrypted vault storage) and D1 (via Drizzle ORM)
- Tailwind CSS for styling, plus a hand-rolled design system (`app/globals.css`)

## Getting started

```bash
npm install
npm run dev
```

Other scripts:

```bash
npm run typecheck   # tsc --noEmit
npm run build        # typecheck + vinext build
npm run lint          # eslint
npm run format        # prettier --write
npm test              # build + rendered-HTML smoke test
```

## Deployment

Each book has its own Wrangler config and Cloudflare Worker:

```bash
npx wrangler deploy --config wrangler.biometric.json  # personal-ledger-dk (US book)
npx wrangler deploy --config wrangler.generic.json     # secondary book
```

Cloudflare bindings (KV namespace for the vault, D1 database, Plaid/Teller API secrets) are
configured per-environment via `wrangler secret put` and the `wrangler.*.json` files — see those
files for the exact binding names.

## Disclaimer

The tax estimate engine (`lib/tax-usa-*.ts`, `lib/tax-ca-*.ts`, `lib/tax-classify.ts`,
`lib/tax-deductions.ts`) produces **estimates only** — not tax advice. It covers federal and
California state income tax at a simplified level (no AMT, NIIT, or full state-specific
adjustments) and should not be relied on in place of a tax professional or filing software.
