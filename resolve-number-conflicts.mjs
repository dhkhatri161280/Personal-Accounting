// resolve-number-conflicts.mjs
// Called by unattended-coordinator.mjs when number-only conflicts are detected.
// Receives conflict pairs via PL_CONFLICT_PAIRS env (JSON array from coordinator's
// preview text parse) — no Tally fetch needed. Updates App vault: sets each
// conflicting voucher's number to Tally's authoritative number and marks it synced.
//
// Root cause this fixes: App renumbers vouchers when new ones are inserted
// mid-sequence; Tally keeps the original number it was assigned → drift.

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const book = String(process.argv[2] || '').toLowerCase();
if (!['us', 'india'].includes(book)) throw Error('Book must be us or india');

const site = 'https://personal-ledger-dk.digneshkhatri.workers.dev';
const now = new Date(), fy = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
const start = `${fy}-04-01`, end = `${fy + 1}-03-31`;

const B   = s => Buffer.from(s, 'base64');
const b64 = b => Buffer.from(b).toString('base64');
const norm = s => String(s || '').trim().toLowerCase();
const cents = n => Math.round(Number(n || 0) * 100);

function decryptVault(v, p) {
  const k = crypto.pbkdf2Sync(p, B(v.salt), v.iterations, 32, 'sha256');
  const d = crypto.createDecipheriv('aes-256-gcm', k, B(v.iv));
  d.setAuthTag(B(v.tag));
  return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(B(v.ciphertext)), d.final()])).toString('utf8'));
}
function encryptVault(data, p) {
  const iv = crypto.randomBytes(12), salt = crypto.randomBytes(16), iterations = 600000;
  const k = crypto.pbkdf2Sync(p, salt, iterations, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(data)));
  const cipher = Buffer.concat([c.update(plain), c.final()]);
  return { version: 1, algorithm: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations, salt: b64(salt), iv: b64(iv), tag: b64(c.getAuthTag()), ciphertext: b64(cipher) };
}
function sortedEntries(v) {
  return (v.entries || []).map(e => [norm(e.name || e.accountName), cents(e.amount)]).sort((a, b) => a[0].localeCompare(b[0]));
}

(async () => {
  const sitePw  = process.env.PL_SITE_PASSWORD || '';
  const vaultPw = process.env.PL_VAULT_PASSWORD || '';
  if (!sitePw || !vaultPw) throw Error('PL_SITE_PASSWORD and PL_VAULT_PASSWORD must be set');

  // PL_CONFLICT_PAIRS must be provided by the coordinator
  if (!process.env.PL_CONFLICT_PAIRS) throw Error('PL_CONFLICT_PAIRS not set — run via unattended-coordinator.mjs');
  const conflictPairs = JSON.parse(process.env.PL_CONFLICT_PAIRS);

  const auth     = 'Basic ' + Buffer.from('manual-one-edit:' + sitePw).toString('base64');
  const vaultUrl = site + '/api/vault' + (book === 'india' ? '?book=india' : '');

  const vaultResp = await fetch(vaultUrl, { headers: { Authorization: auth } });
  if (!vaultResp.ok) throw Error('Vault fetch failed: HTTP ' + vaultResp.status);
  const raw  = await vaultResp.text();
  const etag = '"' + crypto.createHash('sha256').update(raw).digest('hex') + '"';
  const vault = decryptVault(JSON.parse(raw), vaultPw);
  const cloudVouchers = vault.transactions.filter(x => !x.deleted && x.date >= start && x.date <= end);

  let resolved = 0, unresolvable = 0;

  for (const pair of conflictPairs) {
    const appV = cloudVouchers.find(v =>
      v.date === pair.date &&
      norm(v.type) === norm(pair.type) &&
      String(v.number) === String(pair.appNumber) &&
      norm(v.narration) === norm(pair.narration)
    );
    if (!appV) {
      console.log(`NOT FOUND in vault: ${pair.date} | ${pair.type} #${pair.appNumber} | ${pair.narration}`);
      unresolvable++;
      continue;
    }
    appV.number          = pair.tallyNumber;
    appV.syncFingerprint = JSON.stringify([appV.date, norm(appV.type), String(pair.tallyNumber), norm(appV.narration), sortedEntries(appV)]);
    appV.syncStatus      = 'synced';
    appV.lastSyncedAt    = new Date().toISOString();
    console.log(`NUMBER CONFLICT RESOLVED: ${pair.date} | ${pair.type} | ${pair.narration}`);
    console.log(`  App #${pair.appNumber} → Tally #${pair.tallyNumber}`);
    resolved++;
  }

  if (resolved === 0 && unresolvable === 0) { console.log('No conflicts found — nothing to do.'); process.exit(0); }
  if (resolved === 0) { console.log(`${unresolvable} conflict(s) could not be matched in vault.`); process.exit(1); }

  const ts     = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(__dirname, `encrypted-${book}-vault-before-number-resolve-${ts}.json`);
  fs.writeFileSync(backup, raw);
  console.log(`Backup: ${backup}`);

  const body = JSON.stringify(encryptVault(vault, vaultPw));
  const put  = await fetch(vaultUrl, { method: 'PUT', headers: { Authorization: auth, 'Content-Type': 'application/json', 'If-Match': etag }, body });
  if (!put.ok) throw Error('Vault update rejected: HTTP ' + put.status + ' ' + await put.text());

  console.log(`SUCCESS: ${resolved} number-only conflict(s) resolved in App vault.`);
  if (unresolvable) console.log(`WARNING: ${unresolvable} conflict(s) could not be matched — manual review required.`);
})().catch(e => { console.error('ERROR:', e.message); process.exitCode = 1; });
