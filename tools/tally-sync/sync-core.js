'use strict';
const crypto = require('crypto'), zlib = require('zlib'), http = require('http');

// ── NORMALISATION ────────────────────────────────────────────────────────────
// norm() is the single source of truth for fingerprinting.
// It decodes XML entities and collapses ALL Unicode dash variants (en-dash,
// em-dash, minus, etc.) to a plain hyphen so that character-encoding
// differences between Tally and the App never cause fingerprint mismatches.
const norm = s => String(s || '')
  .replace(/&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/&amp;/gi, '&')
  .replace(/[‐‑‒–—―−﹘﹣－]/g, '-')
  .replace(/\s+/g, ' ').trim().toLowerCase();

const cents = n => Math.round(Number(n || 0) * 100);

// fp() is the canonical fingerprint.  It intentionally excludes voucher
// number because Tally can re-number on import.
const fp = v => JSON.stringify([
  v.date, norm(v.type), norm(v.narration),
  (v.entries || []).map(e => [norm(e.name || e.accountName), cents(e.amount)])
                   .sort((a, b) => a[0].localeCompare(b[0]))
]);

// Handles old 5-element baselines (before voucher-number was removed from fp).
function normaliseBase(base) {
  if (!base) return '';
  try { const a = JSON.parse(base); if (a.length === 5) { a.splice(2, 1); return JSON.stringify(a); } return base; }
  catch { return base; }
}

// ── CRYPTO ───────────────────────────────────────────────────────────────────
const B   = s => Buffer.from(s, 'base64');
const b64 = b => Buffer.from(b).toString('base64');
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');

function deriveKey(v, p) { return crypto.pbkdf2Sync(p, B(v.salt), v.iterations, 32, 'sha256'); }

function decrypt(v, p) {
  const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(v, p), B(v.iv));
  d.setAuthTag(B(v.tag));
  return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(B(v.ciphertext)), d.final()])).toString('utf8'));
}

function encrypt(data, p) {
  const iv = crypto.randomBytes(12), salt = crypto.randomBytes(16), iterations = 600000;
  const k = crypto.pbkdf2Sync(p, salt, iterations, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(data)));
  const cipher = Buffer.concat([c.update(plain), c.final()]);
  return { version: 1, algorithm: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations,
           salt: b64(salt), iv: b64(iv), tag: b64(c.getAuthTag()), ciphertext: b64(cipher) };
}

// ── XML HELPERS ──────────────────────────────────────────────────────────────
function dec(s) { return String(s || '').replace(/&amp;/g,'&').replace(/&apos;/g,"'").replace(/&quot;/g,'"').replace(/&#4;\s*/g,'').trim(); }
function tag(b, n) { const m = b.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${n}>`, 'i')); return dec(m ? m[1] : ''); }

function parse(xml) {
  return [...xml.matchAll(/<VOUCHER(?:\s[^>]*)?>([\s\S]*?)<\/VOUCHER>/gi)].map(m => {
    const b = m[1], raw = tag(b, 'DATE');
    const entries = [...b.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/gi)]
      .map(e => ({ name: tag(e[1], 'LEDGERNAME'), amount: Number(tag(e[1], 'AMOUNT') || 0) }));
    return { guid: tag(b, 'GUID'), masterId: Number(tag(b, 'MASTERID') || 0),
             date: raw.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
             type: tag(b, 'VOUCHERTYPENAME'), number: tag(b, 'VOUCHERNUMBER'),
             narration: tag(b, 'NARRATION'), entries,
             cancelled: tag(b, 'ISCANCELLED') === 'Yes' };
  });
}

// ── TALLY HTTP ───────────────────────────────────────────────────────────────
function post(xml, port) {
  return new Promise((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port, method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(xml) } },
      r => { const a = []; r.on('data', x => a.push(x)); r.on('end', () => resolve(Buffer.concat(a).toString('utf8'))); });
    q.setTimeout(90000, () => q.destroy(Error('Tally timed out')));
    q.on('error', reject);
    q.end(xml);
  });
}

// ── TALLY XML BUILDERS ───────────────────────────────────────────────────────
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function createXml(c) {
  const lines = c.entries.map(e =>
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(e.accountName)}</LEDGERNAME><ISDEEMEDPOSITIVE>${Number(e.amount) < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${Number(e.amount).toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`
  ).join('');
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER><BODY><DESC></DESC><DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER ACTION="Create" VCHTYPE="${esc(c.type)}"><DATE>${c.date.replace(/-/g,'')}</DATE><GUID>${esc(c.tallyGuid||c.guid)}</GUID><NARRATION>${esc(c.narration)}</NARRATION><VOUCHERTYPENAME>${esc(c.type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(c.number)}</VOUCHERNUMBER><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE>${lines}</VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
}

function deleteXml(t) {
  const [y, m, d] = t.date.split('-');
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER><BODY><DESC></DESC><DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER DATE="${Number(d)}-${MONTHS[Number(m)-1]}-${y}" TAGNAME="Voucher Number" TAGVALUE="${esc(t.number)}" VCHTYPE="${esc(t.type)}" ACTION="Delete"></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
}

function alterXml(c, t) {
  const [y, m, d] = c.date.split('-');
  const td = `${Number(d)}-${MONTHS[Number(m)-1]}-${y}`;
  const lines = c.entries.map(e =>
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(e.accountName)}</LEDGERNAME><ISDEEMEDPOSITIVE>${Number(e.amount) < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${Number(e.amount).toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`
  ).join('');
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER><BODY><DESC></DESC><DATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER DATE="${td}" TAGNAME="MASTER ID" TAGVALUE="${t.masterId}" ACTION="Alter" VCHTYPE="${esc(c.type)}"><DATE>${c.date.replace(/-/g,'')}</DATE><NARRATION>${esc(c.narration)}</NARRATION><VOUCHERTYPENAME>${esc(c.type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(c.number)}</VOUCHERNUMBER><ISCANCELLED>No</ISCANCELLED><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE>${lines}</VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
}

// ── CLOUD VAULT ──────────────────────────────────────────────────────────────
const SITE = 'https://personal-ledger-dk.digneshkhatri.workers.dev';

async function load(auth, pw, book) {
  const url = SITE + '/api/vault' + (book === 'india' ? '?book=india' : '');
  const r = await fetch(url, { headers: { Authorization: auth } });
  if (!r.ok) throw Error('Cloud HTTP ' + r.status);
  const raw = await r.text();
  return { url, raw, etag: '"' + crypto.createHash('sha256').update(raw).digest('hex') + '"',
           vault: decrypt(JSON.parse(raw), pw) };
}

// ── ENTRY RULE VALIDATION ────────────────────────────────────────────────────
function validateEntryRules(v, accounts) {
  const errors = [], entries = Array.isArray(v && v.entries) ? v.entries : [];
  const byId   = new Map((accounts || []).map(a => [Number(a.id), a]));
  const byName = new Map((accounts || []).map(a => [norm(a.name), a]));
  const resolved = entries.map(e => byId.get(Number(e.accountId)) || byName.get(norm(e.accountName || e.name)));
  const isBank = a => a && /^(bank accounts|bank od a\/c|cash-in-hand)$/.test(norm(a.parent || a.group || a.category));
  const type = norm(v && v.type);
  if (entries.length < 2) errors.push('at least two ledger lines are required');
  if (entries.reduce((n, e) => n + cents(e.amount), 0) !== 0) errors.push('debits and credits must balance');
  if (resolved.some(a => !a)) errors.push('a ledger does not exist');
  if (resolved.some(a => a && a.active === false)) errors.push('an inactive ledger is used');
  const lines = entries.map((e, i) => ({ amount: cents(e.amount), bank: isBank(resolved[i]) }));
  if (type === 'payment' && !lines.some(x => x.amount > 0 && x.bank)) errors.push('Payment requires Bank or Cash on credit side');
  if (type === 'receipt' && !lines.some(x => x.amount < 0 && x.bank)) errors.push('Receipt requires Bank or Cash on debit side');
  if (type === 'contra'  && lines.some(x => !x.bank)) errors.push('Contra permits only Bank, Bank OD, or Cash');
  if (type === 'journal' && lines.some(x =>  x.bank)) errors.push('Journal cannot contain Bank, Bank OD, or Cash');
  return errors;
}

module.exports = {
  norm, cents, fp, normaliseBase,
  B, b64, esc, decrypt, encrypt,
  dec, tag, parse,
  post, createXml, deleteXml, alterXml,
  load, validateEntryRules, SITE
};
