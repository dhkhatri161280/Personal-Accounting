const fs = require("fs");
const path = require("path");

const tsxPath = path.join(process.cwd(), "components", "VaultApp.tsx");
if (!fs.existsSync(tsxPath)) throw new Error("components/VaultApp.tsx not found");

let s = fs.readFileSync(tsxPath, "utf8");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.copyFileSync(tsxPath, `${tsxPath}.backup-clean-sync-${stamp}`);

function replaceFunction(src, name, replacement) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`function ${name} not found`);

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

    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }

    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) {
        return src.slice(0, start) + replacement + src.slice(i + 1);
      }
    }
  }

  throw new Error(`function ${name} end not found`);
}

const cleanGetSyncState = `function getSyncState(data:Ledger|null,book:"us"|"india"="us",remoteSyncHealth:any=null){const tx=(data?.transactions||[]) as any[],accounts=((data as any)?.accounts||[]) as any[],groups=((data as any)?.groups||[]) as any[],rows=[...tx,...accounts,...groups];const st=(x:any)=>String(x?.syncStatus||"").toLowerCase();const fp=(x:any)=>String(x?.syncFingerprint||"");const localErrors=rows.filter((x:any)=>st(x)==="error").length;const localPending=rows.filter((x:any)=>{const status=st(x),finger=fp(x);if(status==="error")return false;if(x?.deleted&&status!=="synced")return true;if(finger.startsWith("app-change-"))return true;if(status==="pending"&&!x?.tallyGuid)return true;return false}).length;if(localErrors)return{tone:"error",label:String(localErrors)+" sync issue"+(localErrors===1?"":"s")};if(localPending)return{tone:"pending",label:String(localPending)+" item"+(localPending===1?"":"s")+" pending sync"};const h=remoteSyncHealth||((data as any)?.syncHealth?.[book])||((data as any)?.syncHealth);const status=String(h?.status||"").toLowerCase();const tallyToApp=Number(h?.tallyToApp||0),appToTally=Number(h?.appToTally||0),conflicts=Number(h?.conflicts||0),errors=Number(h?.errors||0);const checked=h?.lastCheckedAt?Date.parse(h.lastCheckedAt):NaN;const fresh=Number.isFinite(checked)&&Date.now()-checked<10*60*1000;if(h&&fresh&&(status==="error"||errors>0||conflicts>0))return{tone:"error",label:String(errors+conflicts||1)+" sync issue"+((errors+conflicts)===1?"":"s")};if(h&&fresh&&(status==="pending"||tallyToApp>0||appToTally>0))return{tone:"pending",label:String(tallyToApp+appToTally||1)+" item"+((tallyToApp+appToTally)===1?"":"s")+" pending sync"};if(h&&!fresh)return{tone:"pending",label:"Sync status waiting for latest run"};return{tone:"success",label:"Sync successful"}}`;

s = replaceFunction(s, "getSyncState", cleanGetSyncState);

s = s.replace(/getSyncState\(data\)/g, "getSyncState(data,book,remoteSyncHealth)");
s = s.replace(/getSyncState\(data,\s*book\)/g, "getSyncState(data,book,remoteSyncHealth)");
s = s.replace(/setInterval\((check|refresh|loadSyncStatus),\s*30000\)/g, "setInterval($1,10000)");

let duplicateCount = 0;
s = s.replace(/(syncStatus\s*:\s*"pending"\s*,\s*)(syncFingerprint\s*:[^{}]*?)(syncStatus\s*:\s*"pending"\s*,\s*)/g, function(_, a, b) {
  duplicateCount++;
  return a + b;
});

fs.writeFileSync(tsxPath, s, "utf8");

console.log("Clean sync status logic applied.");
console.log("Duplicate syncStatus removed:", duplicateCount);
console.log("Backup:", `${tsxPath}.backup-clean-sync-${stamp}`);