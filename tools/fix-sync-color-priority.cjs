const fs = require("fs");
const path = require("path");

const tsxPath = path.join(process.cwd(), "components", "VaultApp.tsx");
let s = fs.readFileSync(tsxPath, "utf8");
const backup = `${tsxPath}.backup-sync-color-priority-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(tsxPath, backup);

function replaceFunction(src, name, replacement) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`${name} not found`);
  const open = src.indexOf("{", start);
  let depth = 0, quote = null, esc = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) return src.slice(0, start) + replacement + src.slice(i + 1);
  }
  throw new Error(`${name} end not found`);
}

const fn = `function getSyncState(data:Ledger|null,book:"us"|"india"="us",remoteSyncHealth:any=null){const tx=(data?.transactions||[]) as any[],accounts=((data as any)?.accounts||[]) as any[],groups=((data as any)?.groups||[]) as any[],rows=[...tx,...accounts,...groups];const h=remoteSyncHealth||((data as any)?.syncHealth?.[book])||((data as any)?.syncHealth);const status=String(h?.status||"").toLowerCase();const tallyToApp=Number(h?.tallyToApp||0),appToTally=Number(h?.appToTally||0),conflicts=Number(h?.conflicts||0),errors=Number(h?.errors||0);const checked=h?.lastCheckedAt?Date.parse(h.lastCheckedAt):NaN;const fresh=Number.isFinite(checked)&&Date.now()-checked<10*60*1000;const st=(x:any)=>String(x?.syncStatus||"").toLowerCase();const fp=(x:any)=>String(x?.syncFingerprint||"");const fpTime=(x:any)=>{const m=fp(x).match(/^app-change-(\\\\d+)/);return m?Number(m[1]):NaN};const localPendingNewer=rows.some((x:any)=>{const t=fpTime(x);return fp(x).startsWith("app-change-")&&(!fresh||!Number.isFinite(checked)||t>checked)});const localErrorNewer=rows.some((x:any)=>st(x)==="error"&&localPendingNewer);if(fresh&&(status==="error"||errors>0||conflicts>0))return{tone:"error",label:String(errors+conflicts||1)+" sync issue"+((errors+conflicts)===1?"":"s")};if(fresh&&(status==="pending"||tallyToApp>0||appToTally>0))return{tone:"pending",label:String(tallyToApp+appToTally||1)+" item"+((tallyToApp+appToTally)===1?"":"s")+" pending sync"};if(fresh&&status==="success"&&tallyToApp===0&&appToTally===0&&conflicts===0&&errors===0&&!localPendingNewer&&!localErrorNewer)return{tone:"success",label:"Sync successful"};if(localPendingNewer)return{tone:"pending",label:"App change pending sync"};if(h&&!fresh)return{tone:"pending",label:"Sync status waiting for latest run"};return{tone:"success",label:"Sync successful"}}`;

s = replaceFunction(s, "getSyncState", fn);
s = s.replace(/getSyncState\(data\)/g, "getSyncState(data,book,remoteSyncHealth)");
s = s.replace(/getSyncState\(data,\s*book\)/g, "getSyncState(data,book,remoteSyncHealth)");

fs.writeFileSync(tsxPath, s, "utf8");
console.log("Fixed sync color priority.");
console.log("Backup:", backup);