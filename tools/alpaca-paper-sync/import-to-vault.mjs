#!/usr/bin/env node
// Reads the standalone Alpaca paper-trading bot's own trades.csv (trade_log.py's append-only
// audit trail -- see that project's README) and writes it straight into the encrypted US-book
// vault's `alpacaPaperTrades` field, replacing a manual Masters -> Paper Trading file-picker
// upload. This script is meant to run ON THE MACHINE where the bot itself runs (the personal
// laptop, not this work machine) -- trades.csv never leaves that machine except as the handful
// of fields below, pushed straight to the vault over the same API the app itself uses.
//
// Reuses the SAME proven crypto/load/PUT primitives as tools/tally-sync (../tally-sync/sync-core.js),
// same reasoning as ../amex-benefits/import-to-vault.mjs and ../costco-receipts/import-to-vault.mjs.
//
// parseTradesCsv/mergeAlpacaPaperTrades below are a deliberately faithful, field-by-field port of
// lib/alpaca-paper.ts's parseAlpacaPaperTradesUpload/mergeAlpacaPaperTrades -- a standalone Node
// script can't import that TypeScript module directly. Same two-copies-of-one-truth risk already
// documented in ../amex-benefits/import-to-vault.mjs: any future change to those TS functions must
// be mirrored here by hand.
//
// Usage: node import-to-vault.mjs
// Requires PL_SITE_PASSWORD, PL_VAULT_PASSWORD (the "us-vault" one), PL_ACCESS_CODE, and
// ALPACA_TRADES_CSV (full path to the bot's trades.csv) in the environment -- see
// import-to-vault.ps1, which reads the passwords from DPAPI secret files (set up once on
// WHICHEVER machine runs this script -- DPAPI secrets don't carry over between machines, so this
// needs its own one-time setup even though it reuses the tally-sync naming convention).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { load, encrypt } = require("../tally-sync/sync-core.js");

// ── Faithful ports of lib/alpaca-paper.ts (see header comment) ─────────────────────────────────

// Minimal CSV line splitter -- handles double-quoted fields (csv.DictWriter's QUOTE_MINIMAL only
// quotes a field that itself contains a comma/quote/newline, which none of trade_log.py's fields
// ever do in practice, but this stays correct if that ever changes).
function splitCsvLine(line) {
  const out = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseTradesCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const required of ["timestamp", "ticker", "action", "qty", "price", "order_id", "status"]) {
    if (!(required in idx)) throw new Error(`trades.csv is missing the "${required}" column -- is this really trade_log.py's own file?`);
  }
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const action = cols[idx.action] === "SELL" ? "SELL" : "BUY";
    return {
      timestamp: cols[idx.timestamp] || new Date().toISOString(),
      ticker: cols[idx.ticker] || "",
      action,
      qty: Number(cols[idx.qty]) || 0,
      price: Number(cols[idx.price]) || 0,
      orderId: cols[idx.order_id] || "",
      status: cols[idx.status] || "",
    };
  }).filter((t) => t.orderId && t.ticker);
}

// Dedupes by orderId, incoming (presumably newer) wins -- trades.csv is append-only and a
// re-import should always reflect its latest status for an order (e.g. ACCEPTED -> FILLED).
function mergeAlpacaPaperTrades(existing, incoming) {
  const byId = new Map(existing.map((t) => [t.orderId, t]));
  for (const t of incoming) byId.set(t.orderId, t);
  return [...byId.values()].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const sitePw = process.env.PL_SITE_PASSWORD || "", vaultPw = process.env.PL_VAULT_PASSWORD || "";
  const accessToken = process.env.PL_ACCESS_CODE || "";
  const csvPath = process.env.ALPACA_TRADES_CSV || "";
  if (!sitePw || !vaultPw) throw new Error("Passwords were not supplied -- run via import-to-vault.ps1.");
  if (!accessToken) throw new Error("PL_ACCESS_CODE not set -- required for /api/vault writes.");
  if (!csvPath) throw new Error("ALPACA_TRADES_CSV not set -- point it at the trading bot's own trades.csv (see import-to-vault.ps1).");
  if (!existsSync(csvPath)) {
    console.log(`Nothing to import -- ${csvPath} doesn't exist yet (the bot hasn't submitted any orders).`);
    return;
  }
  const auth = "Basic " + Buffer.from("manual-alpaca-paper-import:" + sitePw).toString("base64");

  const incoming = parseTradesCsv(readFileSync(csvPath, "utf8"));
  if (incoming.length === 0) {
    console.log("Nothing to import -- trades.csv has a header but no rows yet.");
    return;
  }

  const state = await load(auth, vaultPw, "us");
  const existing = state.vault.alpacaPaperTrades || [];
  const merged = mergeAlpacaPaperTrades(existing, incoming);
  const added = merged.length - existing.length;
  // Full content comparison, not just length -- re-running this for orders already on file
  // refreshes their status (e.g. ACCEPTED -> FILLED) under the SAME orderId, so length alone
  // wouldn't catch it (same reasoning as amex-benefits' own import).
  const unchanged = JSON.stringify(merged) === JSON.stringify(existing);
  if (unchanged) {
    console.log("Nothing new -- vault already matches trades.csv exactly.");
    return;
  }

  const backup = join(__dirname, `encrypted-us-vault-before-paper-trade-import-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(backup, state.raw);

  state.vault.alpacaPaperTrades = merged;
  const body = JSON.stringify(encrypt(state.vault, vaultPw));
  const put = await fetch(state.url, {
    method: "PUT",
    headers: { Authorization: auth, "Content-Type": "application/json", "If-Match": state.etag, "x-dk-access-token": accessToken },
    body,
  });
  if (!put.ok) throw new Error("Cloud update rejected HTTP " + put.status + " " + (await put.text()));

  console.log(`SUCCESS: ${added} new paper trade order(s) (${merged.length} total) written directly to the vault.`);
  console.log("Encrypted backup: " + backup);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exitCode = 1;
});
