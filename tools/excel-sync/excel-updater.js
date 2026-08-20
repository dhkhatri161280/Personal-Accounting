'use strict';
// excel-updater.js — computes cell changes from the US vault and writes them
// to pending-changes.json for the PowerShell wrapper to apply via Excel COM.
//
// Usage (called by run-excel-updater.ps1):
//   node excel-updater.js                  — fetch vault, compute, write JSON
//   node excel-updater.js --dry-run        — fetch vault, compute, print summary only
//   node excel-updater.js --inspect        — dump sheet structure (no vault fetch)

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const zlib   = require('zlib');
const XLSX   = require('xlsx');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const EXCEL_PATH   = 'C:\\Users\\dikhatri\\OneDrive - NVIDIA Corporation\\Nvidia\\Dignesh\\Personal Finance USA_C.xls';
const CHANGES_PATH = path.join(__dirname, 'pending-changes.json');
const VAULT_URL    = 'https://personal-ledger-dk.digneshkhatri.workers.dev/api/vault';
const VAULT_USER   = 'master-sync';

// Excel label → vault account name (only the exceptions; House Hold handled dynamically)
const EXCEL_TO_VAULT_NAME = {
  'Salary - Nvidia':    'Salary Income - Nvidia',
  'Salary - Tech M':    'Salary Income - TechM',
  'Salary - Accrete':   'Salary Income - Accrete',
  'Salary - Acnovate':  'Salary Income - Acnovate',
  'Salary - Katerra':   'Salary Income - Katerra',
  'Salary - RCS':       'Salary Income - RCS',
  // Outflow rows
  'Int Home Loan':      'Interest on Home Loan',
  'Twanshu Fee':        'Twanshu Class Fee',
  'Insurance - Home':   'Home Insurance',
  'Vehicle Maint.':     'Vehicle Maintenance',
  'Electric & Gas':     'Electric & Gas Expenses',
  'Telephone':          'Telephone Exps',
  'Rent':               'Rent Exps',
  'Internet':           'Internet Exps',
  'Water':              'Water Charges',
  'India Transfer':     'India Fund Transfer',
  'India Income':       'India Fund Income',
  'Kumon Fee':          'Kumons Fee',
  // Inflow rows (reimbursements / asset recoveries)
  'Insurance - Auto R': 'Vehicle Insurance',
  'Travelling R':       'Travelling Expenses',
  'Electric Goods R':   'Electronic Goods',
  'Furniture R':        'Furniture Purchase',
  'Modem / Mobile':     'Mobile Purchase',
  // More Cash Flow outflow labels
  'Medical Exps':       'Medical Expenses',
  'India Fund Trf':     'India Fund Transfer',
  // Insurance - Health handled in EXCEL_TO_MULTI_VAULT_NAMES (includes Legal Plan)
  'Insurance - Auto':   'Vehicle Insurance',
  'Deposit / House':    'Home',
  'Television':         'Television Purchase',
  'Tax Ded':            'Tax Deduction',
  'Costco Member':      'Membership Fee',
  'Electric Goods':     'Electronic Goods',
  'Furniture':          'Furniture Purchase',
  'Mobile':             'Mobile Purchase',
  'Modem':              'Modem Purchase',
  'Roku':               '401K Investments',
  // Inflow / liability rows
  'PG & E':             'PG & E Deposit',
  'Prasanna':           'Prasanna Havinal',
  'Salary - Refund':    'Tax Refund',
};

// Multi-account rows: one Excel label aggregates multiple vault accounts (summed).
// These take priority over EXCEL_TO_VAULT_NAME for the same label.
const EXCEL_TO_MULTI_VAULT_NAMES = {
  // Housing Maint includes HOA, Waste Management, and Water Charges
  'Housing Maint.': ['Housing Maintenance', 'HOA - Helsing Group', 'Waste Management', 'Water Charges'],
  // Health Insurance includes the employer Legal Plan benefit
  'Insurance - Health': ['Health Insurance', 'Legal Plan - Nvidia'],
  // Credit Card Redemption includes Other Income
  'Credit Card Red': ['Credit Card Redemption', 'Other Income'],
};

// House Hold accounts are named per-month: "House Hold Exps - Jul 26"
const _HH_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function houseHoldAccountName(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `House Hold Exps - ${_HH_MONTHS[m - 1]} ${String(y).slice(-2)}`;
}
// Returns true for Excel Cash Flow labels that represent the House Hold account (inflow or outflow)
const isHouseHoldLabel = label => { const n = norm(label); return n === 'House Hold' || n === 'House Hold Exps'; };

// Vault category strings for Dr-normal accounts (assets) — negate raw Cr-positive vault value for display
const ASSET_CATEGORY_RE = /^(asset|bank|cash|investment)$/i;

// ─── CRYPTO ──────────────────────────────────────────────────────────────────

const b64dec = s => Buffer.from(s, 'base64');

function vaultDecrypt(envelope, password) {
  const key = crypto.pbkdf2Sync(password, b64dec(envelope.salt), envelope.iterations, 32, 'sha256');
  const dec = crypto.createDecipheriv('aes-256-gcm', key, b64dec(envelope.iv));
  dec.setAuthTag(b64dec(envelope.tag));
  return JSON.parse(zlib.gunzipSync(Buffer.concat([dec.update(b64dec(envelope.ciphertext)), dec.final()])).toString('utf8'));
}

// ─── NAME HELPERS ─────────────────────────────────────────────────────────────

const norm = s => String(s || '').trim().replace(/\s+/g, ' ');
const excelToVaultName = label => EXCEL_TO_VAULT_NAME[norm(label)] ?? norm(label);

// ─── DATE / FY HELPERS ───────────────────────────────────────────────────────

function parseFYStr(fy) {
  const m = fy.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const sy = +m[1];
  return { fyEndDate: `${sy + 1}-03-31` };
}

function serialToYM(serial) {
  const adj = serial >= 60 ? serial - 1 : serial;
  const d = new Date(Date.UTC(1900, 0, 1) + (adj - 1) * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ─── VAULT ───────────────────────────────────────────────────────────────────

async function fetchVault() {
  const sp = process.env.PL_SITE_PASSWORD;
  const vp = process.env.PL_VAULT_PASSWORD;
  if (!sp || !vp) throw new Error('PL_SITE_PASSWORD and PL_VAULT_PASSWORD must be set');
  const auth = 'Basic ' + Buffer.from(`${VAULT_USER}:${sp}`).toString('base64');
  process.stdout.write('Fetching vault... ');
  const res = await fetch(VAULT_URL, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`Vault HTTP ${res.status}: ${await res.text()}`);
  const envelope = await res.json();
  process.stdout.write('decrypting... ');
  const vault = vaultDecrypt(envelope, vp);
  console.log(`done. Accounts: ${vault.accounts.length}, Transactions: ${vault.transactions.length}`);
  return vault;
}

// ─── BALANCE COMPUTATIONS ────────────────────────────────────────────────────

const ALL_FYS = ['2016-17','2017-18','2018-19','2019-20','2020-21',
                 '2021-22','2022-23','2023-24','2024-25','2025-26','2026-27'];

function computeClosingBalances(vault) {
  const txns = vault.transactions.filter(t => !t.deleted).sort((a, b) => a.date.localeCompare(b.date));
  const result = new Map(vault.accounts.map(a => [a.id, new Map()]));
  const fyEnds = ALL_FYS.map(fy => ({ fy, end: parseFYStr(fy).fyEndDate }));
  let txIdx = 0;
  const cumulative = new Map(vault.accounts.map(a => [a.id, 0]));
  for (const { fy, end } of fyEnds) {
    while (txIdx < txns.length && txns[txIdx].date <= end) {
      for (const e of txns[txIdx].entries)
        cumulative.set(e.accountId, (cumulative.get(e.accountId) ?? 0) + e.amount);
      txIdx++;
    }
    for (const a of vault.accounts)
      result.get(a.id).set(fy, (a.openingBalance ?? 0) + (cumulative.get(a.id) ?? 0));
  }
  return result;
}

function computeMonthlyFlows(vault) {
  // Returns Map<accountId, Map<ym, {inflow, outflow}>>
  // inflow = sum of Cr entries (positive vault amounts)
  // outflow = sum of Dr entries (negative vault amounts, stored as positive)
  const result = new Map(vault.accounts.map(a => [a.id, new Map()]));
  for (const tx of vault.transactions) {
    if (tx.deleted) continue;
    const ym = tx.date.slice(0, 7);
    for (const e of tx.entries) {
      const m = result.get(e.accountId);
      if (!m) continue;
      if (!m.has(ym)) m.set(ym, { inflow: 0, outflow: 0 });
      const rec = m.get(ym);
      if (e.amount > 0) rec.inflow += e.amount;
      else rec.outflow += -e.amount;
    }
  }
  return result;
}

function computeLifetimeTotals(vault) {
  const result = new Map(vault.accounts.map(a => [a.id, { incoming: 0, outgoing: 0 }]));
  for (const tx of vault.transactions) {
    if (tx.deleted) continue;
    for (const e of tx.entries) {
      const r = result.get(e.accountId);
      if (!r) continue;
      if (e.amount > 0) r.incoming += e.amount; else r.outgoing += -e.amount;
    }
  }
  return result;
}

function toDisplayAmount(account, rawBalance) {
  return round2(Math.abs(rawBalance));
}

const round2 = v => Math.round(v * 100) / 100;

// ─── XLSX HELPERS (read-only — structure discovery only) ──────────────────────

const sheetRange  = ws => XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
const cellRef     = (r, c) => XLSX.utils.encode_cell({ r, c });
const cellText    = (ws, r, c) => { const cell = ws[cellRef(r, c)]; return cell ? norm(String(cell.w ?? cell.v ?? '')) : ''; };
const cellNumeric = (ws, r, c) => { const cell = ws[cellRef(r, c)]; return (cell && cell.t === 'n') ? cell.v : null; };

// ─── CHANGE RECORDER ─────────────────────────────────────────────────────────
// row and col are 0-indexed (SheetJS). COM needs 1-indexed → add 1 here.

function record(changes, sheet, r, c, value) {
  const v = round2(value);
  if (!isFinite(v)) return;
  changes.push({ sheet, row: r + 1, col: c + 1, value: v });
}

// ─── FY SHEET ─────────────────────────────────────────────────────────────────

function collectFYSheet(ws, sheetName, accountByVaultName, balances, changes) {
  const range = sheetRange(ws);
  for (let r = range.s.r; r <= range.e.r; r++) {
    // Liabilities: name in col B (1) → amount in col C (2)
    const liabLabel = cellText(ws, r, 1);
    if (liabLabel) {
      const acct = accountByVaultName.get(excelToVaultName(liabLabel));
      if (acct) {
        const raw = balances.get(acct.id)?.get(sheetName);
        if (raw !== undefined) record(changes, sheetName, r, 2, toDisplayAmount(acct, raw));
      }
    }
    // Assets: name in col E (4) → amount in col F (5)
    const assetLabel = cellText(ws, r, 4);
    if (assetLabel) {
      const acct = accountByVaultName.get(excelToVaultName(assetLabel));
      if (acct) {
        const raw = balances.get(acct.id)?.get(sheetName);
        if (raw !== undefined) record(changes, sheetName, r, 5, toDisplayAmount(acct, raw));
      }
    }
  }
}

// ─── CONSOLIDATED ─────────────────────────────────────────────────────────────

function collectConsolidated(ws, accountByVaultName, balances, changes) {
  const range = sheetRange(ws);
  const fyRe  = /^(\d{4})-(\d{2})$/;
  const liabFyCols = new Map();
  const assetFyCols = new Map();

  for (let r = 0; r <= Math.min(4, range.e.r); r++) {
    for (let c = 2; c <= 13; c++) {
      const t = cellText(ws, r, c);
      if (fyRe.test(t)) liabFyCols.set(t, c);
    }
    for (let c = 14; c <= Math.min(26, range.e.c); c++) {
      const t = cellText(ws, r, c);
      if (fyRe.test(t)) assetFyCols.set(t, c);
    }
  }

  if (!liabFyCols.size) [...ALL_FYS].reverse().forEach((fy, i) => { if (i < 11) liabFyCols.set(fy, 2 + i); });
  if (!assetFyCols.size) [...ALL_FYS].reverse().forEach((fy, i) => { if (i < 11) assetFyCols.set(fy, 14 + i); });

  function writeRow(r, nameCol, fyCols) {
    const label = cellText(ws, r, nameCol);
    if (!label) return;
    const acct = accountByVaultName.get(excelToVaultName(label));
    if (!acct) return;
    const fyMap = balances.get(acct.id);
    if (!fyMap) return;
    for (const [fy, col] of fyCols) {
      const raw = fyMap.get(fy);
      if (raw !== undefined) record(changes, 'Consolidated', r, col, toDisplayAmount(acct, raw));
    }
  }

  for (let r = range.s.r; r <= range.e.r; r++) {
    writeRow(r, 1,  liabFyCols);  // col B → C-M
    writeRow(r, 13, assetFyCols); // col N → O-Y
  }
}

// ─── CASH FLOW ────────────────────────────────────────────────────────────────

function collectCashFlow(ws, accountByVaultName, monthlyFlows, changes, currentYM) {
  const range = sheetRange(ws);
  const monthColMap = new Map();

  for (let c = range.s.c; c <= range.e.c; c++) {
    const v = cellNumeric(ws, 1, c); // row 2 = index 1
    if (v !== null && v > 40000 && v < 60000) {
      const ym = serialToYM(v);
      // Only update current month — never overwrite historical data
      if (ym !== currentYM) continue;
      if (!monthColMap.has(ym)) monthColMap.set(ym, c);
    }
  }

  if (!monthColMap.size) { console.log('  Cash Flow: no month columns found — skipping'); return; }

  // Find section boundaries — start from row 30 to skip any header "Cash Outflow" labels
  let outflowStartRow = Infinity;
  let savingsSummaryStartRow = Infinity;
  for (let r = 30; r <= range.e.r; r++) {
    const hdr = norm(cellText(ws, r, 0)) || norm(cellText(ws, r, 1));
    if (outflowStartRow === Infinity && hdr === 'Cash Outflow') outflowStartRow = r;
    if (savingsSummaryStartRow === Infinity && hdr === 'Savings Summary') savingsSummaryStartRow = r;
    if (outflowStartRow !== Infinity && savingsSummaryStartRow !== Infinity) break;
  }
  console.log(`  Cash Flow: outflow starts row ${outflowStartRow + 1}, savings summary starts row ${savingsSummaryStartRow + 1}`);

  // Pre-scan inflow section to find accounts that have a partner inflow row.
  // Those accounts use Dr-only on outflow side (refund already captured on inflow side).
  const inflowAccountIds = new Set();
  for (let r = 11; r < outflowStartRow; r++) {
    const lbl = cellText(ws, r, 0) || cellText(ws, r, 1);
    if (!lbl || isHouseHoldLabel(lbl)) continue;
    const a = accountByVaultName.get(excelToVaultName(lbl));
    if (a) inflowAccountIds.add(a.id);
  }

  const unmatchedLabels = [];
  for (let r = 11; r < savingsSummaryStartRow; r++) {
    const label = cellText(ws, r, 0) || cellText(ws, r, 1);
    if (!label) continue;
    const isOutflow = r >= outflowStartRow;

    if (isHouseHoldLabel(label)) {
      // Each month column uses its own vault account: "House Hold Exps - Jul 26"
      for (const [ym, col] of monthColMap) {
        const hhAcct = accountByVaultName.get(houseHoldAccountName(ym));
        if (!hhAcct) continue;
        const fMap = monthlyFlows.get(hhAcct.id);
        const flows = fMap ? fMap.get(ym) : null;
        const val = flows ? (isOutflow ? flows.outflow : flows.inflow) : 0;
        const cell = ws[cellRef(r, col)];
        if (cell && cell.f !== undefined) continue;
        if (val === 0 && !cell) continue;
        record(changes, 'Cash Flow', r, col, val);
      }
      continue;
    }

    const multiNames = EXCEL_TO_MULTI_VAULT_NAMES[norm(label)];
    if (multiNames) {
      // Aggregate multiple vault accounts into this one Excel row
      for (const [ym, col] of monthColMap) {
        let total = 0;
        for (const vname of multiNames) {
          const a = accountByVaultName.get(vname);
          if (!a) { console.log(`  Cash Flow: multi-vault "${vname}" not found in vault (row ${r + 1} "${label}")`); continue; }
          const f = monthlyFlows.get(a.id)?.get(ym);
          if (!f) continue;
          const hasInflowRow = inflowAccountIds.has(a.id);
          total += isOutflow
            ? (hasInflowRow ? f.outflow : f.outflow - f.inflow)
            : f.inflow;
        }
        const cell = ws[cellRef(r, col)];
        if (cell && cell.f !== undefined) continue;
        if (total === 0) continue; // never write 0 — leave cell as-is
        record(changes, 'Cash Flow', r, col, total);
      }
      continue;
    }

    const acct = accountByVaultName.get(excelToVaultName(label));
    if (!acct) { unmatchedLabels.push({ r, label }); continue; }
    const fMap = monthlyFlows.get(acct.id);
    if (!fMap) continue;
    for (const [ym, col] of monthColMap) {
      const flows = fMap.get(ym);
      // Inflow rows: Cr-only.
      // Outflow rows: net Dr (outflow - inflow) UNLESS this account also has an inflow row
      // (in which case the Cr is already captured there, so show Dr-only).
      const hasInflowRow = inflowAccountIds.has(acct.id);
      const val = flows ? (isOutflow
        ? (hasInflowRow ? flows.outflow : flows.outflow - flows.inflow)
        : flows.inflow) : 0;
      const cell = ws[cellRef(r, col)];
      if (cell && cell.f !== undefined) continue;
      if (val === 0) continue; // never write 0 — leave cell as-is
      record(changes, 'Cash Flow', r, col, val);
    }
  }
  if (unmatchedLabels.length) {
    console.log(`  Cash Flow: ${unmatchedLabels.length} row label(s) not found in vault (skipped):`);
    for (const { r, label } of unmatchedLabels)
      console.log(`    Row ${r + 1}: "${label}"`);
  }
}

// ─── 2026-27 P&L MONTHLY ROWS ────────────────────────────────────────────────
// Writes House Hold Exps monthly amounts (Dr net per month) to the P&L section.
// Month rows are labelled "April-26", "May-26" ... "March-27" in col B.

function collectCurrentFYPL(ws, fyStartYear, accountByVaultName, monthlyFlows, changes, sheetName, currentYM) {
  const range = sheetRange(ws);

  // All FY months Apr→Mar; only those up to currentYM are "completed"
  const allFYMonths = [
    `${fyStartYear}-04`, `${fyStartYear}-05`, `${fyStartYear}-06`,
    `${fyStartYear}-07`, `${fyStartYear}-08`, `${fyStartYear}-09`,
    `${fyStartYear}-10`, `${fyStartYear}-11`, `${fyStartYear}-12`,
    `${fyStartYear + 1}-01`, `${fyStartYear + 1}-02`, `${fyStartYear + 1}-03`,
  ];
  const fyYMs = allFYMonths.filter(ym => ym <= currentYM);

  // Sum inflow or outflow for one or more vault account names across all FY months to date
  function fyTotal(vaultNames, side) {
    let total = 0;
    for (const vname of (Array.isArray(vaultNames) ? vaultNames : [vaultNames])) {
      const acct = accountByVaultName.get(vname);
      if (!acct) { console.log(`  ${sheetName} P&L: vault account "${vname}" not found`); continue; }
      const fMap = monthlyFlows.get(acct.id);
      if (!fMap) continue;
      for (const ym of fyYMs) { const f = fMap.get(ym); if (f) total += f[side]; }
    }
    return round2(total);
  }

  // ── House Hold Exps: one row per month, col C (idx 2), monthly Dr net ──────
  const fyMonths = [
    { label: `April-${String(fyStartYear).slice(-2)}`,        ym: `${fyStartYear}-04` },
    { label: `May-${String(fyStartYear).slice(-2)}`,          ym: `${fyStartYear}-05` },
    { label: `June-${String(fyStartYear).slice(-2)}`,         ym: `${fyStartYear}-06` },
    { label: `July-${String(fyStartYear).slice(-2)}`,         ym: `${fyStartYear}-07` },
    { label: `August-${String(fyStartYear).slice(-2)}`,       ym: `${fyStartYear}-08` },
    { label: `September-${String(fyStartYear).slice(-2)}`,    ym: `${fyStartYear}-09` },
    { label: `October-${String(fyStartYear).slice(-2)}`,      ym: `${fyStartYear}-10` },
    { label: `November-${String(fyStartYear).slice(-2)}`,     ym: `${fyStartYear}-11` },
    { label: `December-${String(fyStartYear).slice(-2)}`,     ym: `${fyStartYear}-12` },
    { label: `January-${String(fyStartYear + 1).slice(-2)}`,  ym: `${fyStartYear + 1}-01` },
    { label: `February-${String(fyStartYear + 1).slice(-2)}`, ym: `${fyStartYear + 1}-02` },
    { label: `March-${String(fyStartYear + 1).slice(-2)}`,    ym: `${fyStartYear + 1}-03` },
  ];
  const monthRowMap = new Map(); // ym → row index (0-based)
  for (let r = range.s.r; r <= range.e.r; r++) {
    const txt = norm(cellText(ws, r, 1));
    for (const fm of fyMonths) {
      if (txt === fm.label) { monthRowMap.set(fm.ym, r); break; }
    }
  }

  // Only write the current month's House Hold row — previous months already have correct values
  let hhWritten = 0;
  const curMonthRow = monthRowMap.get(currentYM);
  if (curMonthRow !== undefined) {
    const hhName = houseHoldAccountName(currentYM);
    const hhAcct = accountByVaultName.get(hhName);
    if (!hhAcct) {
      console.log(`  ${sheetName} P&L: "${hhName}" not found in vault — skipping`);
    } else {
      const fMap = monthlyFlows.get(hhAcct.id);
      const f = fMap ? fMap.get(currentYM) : null;
      const netDr = f ? round2(Math.max(0, f.outflow - f.inflow)) : 0;
      const cell = ws[cellRef(curMonthRow, 2)];
      if (!(cell && cell.f !== undefined) && netDr !== 0) {
        record(changes, sheetName, curMonthRow, 2, netDr);
        hhWritten++;
      }
    }
  }
  console.log(`  ${sheetName} P&L House Hold Exps: ${hhWritten} monthly cell(s) to update`);

  // ── FY-cumulative Dr rows (Indirect Expenses), col C (idx 2) ───────────────
  // Label matched against col B (idx 1). All are manual cells — no formula check.
  // Amount = FY-to-date net Dr (outflow - inflow, floored at 0) across vault accounts.
  const drCumulRows = [
    { excelLabel: 'Electric Burning Exps',   vaultNames: ['Electric & Gas Expenses'] },
    { excelLabel: 'Interest on Housing Loan', vaultNames: ['Interest on Home Loan'] },
    { excelLabel: 'Income Tax Expenses',      vaultNames: ['Tax Deduction'] },
    { excelLabel: 'Health Insurance',         vaultNames: ['Health Insurance'] },
    // Internet and Telephone share one row in P&L
    { excelLabel: 'Telephone Exps',           vaultNames: ['Telephone Exps', 'Internet Exps'] },
    { excelLabel: 'Travelling Exps',          vaultNames: ['Travelling Expenses'] },
    { excelLabel: 'Twanshu School Fee',       vaultNames: ['Twanshu Class Fee'] },
    // HOA + Waste Management + Water Charges all go into House Rent Management row
    { excelLabel: 'House Rent Management',    vaultNames: ['HOA - Helsing Group', 'Waste Management', 'Water Charges'] },
    { excelLabel: 'Vehicle Maintenance',      vaultNames: ['Vehicle Maintenance'] },
    { excelLabel: 'Vehicle Insurance',        vaultNames: ['Vehicle Insurance'] },
    { excelLabel: 'Membership Fee',           vaultNames: ['Membership Fee'] },
    { excelLabel: 'Rent Expenses',            vaultNames: ['Rent Exps'] },
    { excelLabel: 'India Fund Transfer',      vaultNames: ['India Fund Transfer'] },
    { excelLabel: 'Medical Expenses',         vaultNames: ['Medical Expenses'] },
    // H1B Visa Fee and Legal Plan - Nvidia share one row
    { excelLabel: 'H1B Visa Fee',             vaultNames: ['H1B Visa Fee', 'Legal Plan - Nvidia'] },
    { excelLabel: 'Birthday Gift',            vaultNames: ['Birthday Gift'] },
  ];

  // ── FY-cumulative Cr rows (Income), col F (idx 5) ──────────────────────────
  // Label matched against col E (idx 4). All are manual cells — no formula check.
  // Amount = FY-to-date inflow across vault accounts.
  const crCumulRows = [
    // Salary from Nvidia (Direct Income)
    { excelLabel: 'Salary from Nvidia', vaultNames: ['Salary Income - Nvidia'] },
    // Other Income, Credit Card Redemption, and Tax Refund combined in one row
    { excelLabel: 'Other Income', vaultNames: ['Other Income', 'Credit Card Redemption', 'Tax Refund'] },
  ];

  // Helpers: FY net Dr (expense rows) and FY net Cr (income rows)
  function fyNetDr(vaultNames) {
    let totalIn = 0, totalOut = 0;
    for (const vname of vaultNames) {
      const acct = accountByVaultName.get(vname);
      if (!acct) { console.log(`  ${sheetName} P&L: vault account "${vname}" not found`); continue; }
      const fMap = monthlyFlows.get(acct.id);
      if (!fMap) continue;
      for (const ym of fyYMs) { const f = fMap.get(ym); if (f) { totalIn += f.inflow; totalOut += f.outflow; } }
    }
    return round2(Math.max(0, totalOut - totalIn));
  }
  function fyNetCr(vaultNames) {
    let totalIn = 0, totalOut = 0;
    for (const vname of vaultNames) {
      const acct = accountByVaultName.get(vname);
      if (!acct) { console.log(`  ${sheetName} P&L: vault account "${vname}" not found`); continue; }
      const fMap = monthlyFlows.get(acct.id);
      if (!fMap) continue;
      for (const ym of fyYMs) { const f = fMap.get(ym); if (f) { totalIn += f.inflow; totalOut += f.outflow; } }
    }
    return round2(Math.max(0, totalIn - totalOut));
  }

  // Find P&L section boundaries: starts at "PROFIT & LOSS" header, ends before "Cash Flow"
  let plStart = -1, plEnd = range.e.r;
  for (let r = range.s.r; r <= range.e.r; r++) {
    const t = norm(cellText(ws, r, 1)).toUpperCase();
    if (plStart === -1 && t.includes('PROFIT')) plStart = r;
    if (plStart !== -1 && t === 'CASH FLOW') { plEnd = r - 1; break; }
  }
  if (plStart === -1) plStart = range.s.r;

  let extraWritten = 0;
  for (let r = plStart; r <= plEnd; r++) {
    const drLbl = norm(cellText(ws, r, 1)); // col B
    const crLbl = norm(cellText(ws, r, 4)); // col E

    for (const { excelLabel, vaultNames } of drCumulRows) {
      if (drLbl === excelLabel) {
        const val = fyNetDr(vaultNames);
        if (val === 0) continue;
        record(changes, sheetName, r, 2, val);
        extraWritten++;
      }
    }

    for (const { excelLabel, vaultNames } of crCumulRows) {
      if (crLbl === excelLabel) {
        const val = fyNetCr(vaultNames);
        if (val === 0) continue;
        record(changes, sheetName, r, 5, val);
        extraWritten++;
      }
    }
  }
  if (extraWritten) console.log(`  ${sheetName} P&L extra rows: ${extraWritten} cell(s) to update`);
}

// ─── BALANCE SHEET ───────────────────────────────────────────────────────────
// Direct cell mapping — row/col are 0-indexed (SheetJS). Col C = 2, Col F = 5.
// Uses closing balance for the current FY (openingBal + all transactions to date).
// Special case: F8 (Electronic Goods) = vault total − current F14 value.

function collectBalanceSheet(ws, accountByVaultName, balances, changes, sheetName) {
  // negate=false (liability side, col C): use Math.abs — Cr-normal accounts show positive
  // negate=true  (asset side, col F):    use -raw    — Dr-normal assets show positive,
  //                                                     Cr-normal liabilities (e.g. credit cards) show negative
  function bsVal(vaultNames, negate) {
    let total = 0;
    for (const vname of (Array.isArray(vaultNames) ? vaultNames : [vaultNames])) {
      const acct = accountByVaultName.get(vname);
      if (!acct) { console.log(`  ${sheetName} BS: vault account "${vname}" not found`); continue; }
      const raw = balances.get(acct.id)?.get(sheetName);
      if (raw === undefined) { console.log(`  ${sheetName} BS: no balance for "${vname}"`); continue; }
      total += negate ? -raw : Math.abs(raw);
    }
    return round2(total);
  }

  // Read current F14 value (Refrigerator — kept as-is, subtracted from Electronic Goods total)
  const f14Val = cellNumeric(ws, 13, 5) ?? 0;

  // negate: false = liability side (col C), true = asset side (col F)
  const bsCells = [
    // ── Liabilities (col C = idx 2) — negate: false ──
    { r: 6,  c: 2, negate: false, vaultNames: ['Dignesh Khatri'] },
    // C8 = formula (P&L Deficit) — intentionally omitted
    { r: 13, c: 2, negate: false, vaultNames: ['CCU Home Loan'] },
    // ── Fixed Assets (col F = idx 5) — negate: true ──
    { r: 7,  c: 5, negate: true, vaultNames: ['Electronic Goods'], special: 'subtract-f14' },
    { r: 8,  c: 5, negate: true, vaultNames: ['Furniture Purchase'] },
    { r: 10, c: 5, negate: true, vaultNames: ['Nissan Rogue Sport'] },
    { r: 11, c: 5, negate: true, vaultNames: ['Tesla Model Y'] },
    { r: 12, c: 5, negate: true, vaultNames: ['Mobile Purchase'] },
    // F14 (row 13) = keep as-is — intentionally omitted
    { r: 14, c: 5, negate: true, vaultNames: ['Home'] },
    { r: 15, c: 5, negate: true, vaultNames: ['Television Purchase'] },
    { r: 16, c: 5, negate: true, vaultNames: ['Home Mortgage'] },
    // ── Investments (col F) — negate: true ──
    { r: 24, c: 5, negate: true, vaultNames: ['View at Canyon Investment'] },
    { r: 25, c: 5, negate: true, vaultNames: ['401K Investments', 'ESPP Deduction'] },
    // ── Cash & Bank (col F) — negate: true ──
    { r: 34, c: 5, negate: true, vaultNames: ['Charles Schwab'] },
    { r: 35, c: 5, negate: true, vaultNames: ['Chase Bank'] },
    // Credit cards: Cr balance = liability → -raw = negative on asset side
    { r: 37, c: 5, negate: true, vaultNames: ['AMEX Credit Card', 'Citi Credit Card', 'Credit Card - BOfA'] },
    { r: 38, c: 5, negate: true, vaultNames: ['Bank Of America', 'Savings Account'] },
  ];

  let written = 0;
  for (const { r, c, negate, vaultNames, special } of bsCells) {
    let val = bsVal(vaultNames, negate);
    if (special === 'subtract-f14') val = round2(val - f14Val);
    if (val === 0) continue;
    record(changes, sheetName, r, c, val);
    written++;
  }
  console.log(`  ${sheetName} Balance Sheet: ${written} cell(s) to update`);
}

// ─── FUNDING ──────────────────────────────────────────────────────────────────

function collectFunding(ws, accountByVaultName, lifetimeTotals, changes) {
  const range = sheetRange(ws);

  function tryRow(r, nameCol, inCol, outCol) {
    const label = cellText(ws, r, nameCol);
    if (!label) return;
    const acct = accountByVaultName.get(excelToVaultName(label));
    if (!acct) return;
    const totals = lifetimeTotals.get(acct.id);
    if (!totals) return;
    record(changes, 'Funding', r, inCol,  totals.incoming);
    record(changes, 'Funding', r, outCol, totals.outgoing);
  }

  for (let r = range.s.r; r <= range.e.r; r++) {
    tryRow(r, 1, 2, 3); // left:  B=name, C=incoming, D=outgoing
    tryRow(r, 4, 5, 6); // right: E=name, F=incoming, G=outgoing
  }
}

// ─── INSPECT MODE ─────────────────────────────────────────────────────────────

function inspectWorkbook(wb, targetSheet) {
  const names = targetSheet ? wb.SheetNames.filter(n => n === targetSheet) : wb.SheetNames;
  if (targetSheet && !names.length) { console.log(`Sheet "${targetSheet}" not found. Available: ${wb.SheetNames.join(', ')}`); return; }
  console.log(`\nWorkbook: ${wb.SheetNames.length} sheets\n`);
  for (const name of names) {
    const ws = wb.Sheets[name];
    const range = sheetRange(ws);
    console.log(`┌─ "${name}"  ${ws['!ref']}`);
    const maxR = targetSheet ? range.e.r : Math.min(range.e.r, range.s.r + 14);
    const maxC = Math.min(range.e.c, range.s.c + 9);
    for (let r = range.s.r; r <= maxR; r++) {
      const row = [`R${r + 1}`.padEnd(4)];
      for (let c = range.s.c; c <= maxC; c++) {
        const cell = ws[cellRef(r, c)];
        let v = '';
        if (cell) { if (cell.f) v = '=<formula>'; else if (cell.w) v = cell.w; else if (cell.v !== undefined) v = String(cell.v); }
        row.push(v.slice(0, 16).padEnd(17));
      }
      console.log('│ ' + row.join(' '));
    }
    console.log(`└─ (${range.e.r - range.s.r + 1} rows × ${range.e.c - range.s.c + 1} cols)\n`);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const args      = process.argv.slice(2);
    const dryRun    = args.includes('--dry-run');
    const inspectOnly = args.includes('--inspect');

    const excelPath = args.find(a => /\.xls[x]?$/i.test(a)) ?? EXCEL_PATH;
    if (!fs.existsSync(excelPath)) throw new Error(`Excel file not found: ${excelPath}`);

    console.log(`Reading structure: ${path.basename(excelPath)}`);
    // Read-only — SheetJS used only to discover row/col positions
    const wb = XLSX.readFile(excelPath, { cellFormula: true, sheetStubs: true });

    if (inspectOnly) { const targetSheet = args.find(a => !a.startsWith('--')); inspectWorkbook(wb, targetSheet); return; }

    if (args.includes('--accounts')) {
      // List all vault accounts + their July 2026 net activity
      const vault2 = await fetchVault();
      const flows2 = computeMonthlyFlows(vault2);
      const _now2 = new Date();
      const curYM2 = `${_now2.getFullYear()}-${String(_now2.getMonth() + 1).padStart(2, '0')}`;
      console.log(`\nAll vault accounts with ${curYM2} activity:\n`);
      for (const a of vault2.accounts) {
        const f = flows2.get(a.id)?.get(curYM2);
        if (f && (f.inflow || f.outflow))
          console.log(`  [${a.category ?? 'no-cat'}] "${a.name}"  in=${f.inflow.toFixed(2)}  out=${f.outflow.toFixed(2)}`);
      }
      console.log(`\nAll vault accounts (all 211):\n`);
      for (const a of vault2.accounts)
        console.log(`  "${a.name}"  [${a.category ?? 'no-cat'}]`);
      return;
    }

    const vault          = await fetchVault();
    const balances       = computeClosingBalances(vault);
    const monthlyFlows   = computeMonthlyFlows(vault);
    const lifetimeTotals = computeLifetimeTotals(vault);

    const accountByVaultName = new Map(vault.accounts.map(a => [norm(a.name), a]));
    const fyRe = /^(\d{4})-(\d{2})$/;

    const changes = [];

    // Determine the current Indian FY (Apr 1 – Mar 31)
    const now = new Date();
    const fyStartYear = (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
    const currentFY = `${fyStartYear}-${String(fyStartYear + 1).slice(-2)}`;
    const currentYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    console.log(`Current FY: ${currentFY}, Current Month: ${currentYM}`);

    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const before = changes.length;

      if (sheetName === 'Cash Flow') {
        // Primary data store — inflow rows get Cr amounts, outflow rows get Dr amounts.
        // Only the current month column is updated — historical months are never touched.
        collectCashFlow(ws, accountByVaultName, monthlyFlows, changes, currentYM);
      } else if (sheetName === currentFY) {
        collectBalanceSheet(ws, accountByVaultName, balances, changes, sheetName);
        collectCurrentFYPL(ws, fyStartYear, accountByVaultName, monthlyFlows, changes, sheetName, currentYM);
      } else {
        console.log(`  ${sheetName}: skipped`);
        continue;
      }

      console.log(`  ${sheetName}: ${changes.length - before} cell(s) to update`);
    }

    if (dryRun) {
      console.log(`\nDRY RUN — ${changes.length} cell(s) identified. No changes written.`);
      // Print non-zero Cash Flow changes grouped by account row
      const cfWs = wb.Sheets['Cash Flow'];
      const nonZero = changes.filter(ch => ch.value !== 0);
      // Always print all FY sheet changes in full
      const fyChanges = nonZero.filter(ch => ch.sheet !== 'Cash Flow');
      if (fyChanges.length) {
        console.log(`\n${currentFY} closing balances (${fyChanges.length} non-zero cells):`);
        for (const ch of fyChanges)
          console.log(`  ${ch.sheet}!${XLSX.utils.encode_cell({ r: ch.row - 1, c: ch.col - 1 })} = ${ch.value}`);
      }

      // Show ALL changes for current month (July 2026)
      const curYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const curMonthChanges = changes.filter(ch => ch.sheet === 'Cash Flow' && ch._ym === curYM);
      // Tag changes with YM for filtering (need to re-derive from col)
      // Instead find what col = curYM
      const cfWsLocal = wb.Sheets['Cash Flow'];
      let curMonthCol = -1;
      if (cfWsLocal) {
        const r2 = sheetRange(cfWsLocal);
        for (let c = r2.s.c; c <= r2.e.c; c++) {
          const v = cellNumeric(cfWsLocal, 1, c);
          if (v !== null && v > 40000 && v < 60000 && serialToYM(v) === curYM) { curMonthCol = c; break; }
        }
      }
      const curMonthChangesFiltered = curMonthCol >= 0
        ? changes.filter(ch => ch.sheet === 'Cash Flow' && ch.col === curMonthCol + 1)
        : [];
      console.log(`\nCash Flow changes for ${curYM} (${curMonthChangesFiltered.length} cells, col ${curMonthCol >= 0 ? XLSX.utils.encode_col(curMonthCol) : '?'}):`);
      for (const ch of curMonthChangesFiltered) {
        const label = cfWsLocal ? (cellText(cfWsLocal, ch.row - 1, 0) || cellText(cfWsLocal, ch.row - 1, 1)) : '';
        console.log(`  Row ${ch.row} [${label || '?'}] = ${ch.value}`);
      }

      // Sample of all Cash Flow non-zero changes
      const cfNonZero = nonZero.filter(ch => ch.sheet === 'Cash Flow');
      console.log(`\nCash Flow all non-zero: ${cfNonZero.length} of ${changes.filter(c=>c.sheet==='Cash Flow').length} total (historical + current)`);
      return;
    }

    // Write changes JSON for PowerShell COM step
    fs.writeFileSync(CHANGES_PATH, JSON.stringify({ excelPath, changes }, null, 0));
    console.log(`\nChanges written to: ${CHANGES_PATH}`);
    console.log(`Total: ${changes.length} cell(s) to apply via Excel COM`);

  } catch (err) {
    console.error('\nERROR:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exitCode = 1;
  }
})();
