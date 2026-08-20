const fs = require("fs");

const p = "components/VaultApp.tsx";
let s = fs.readFileSync(p, "utf8");

fs.copyFileSync(
  p,
  p + ".backup-getSyncState-" + new Date().toISOString().replace(/[:.]/g, "-")
);

function findFunctionEnd(text, functionStart) {
  const brace = text.indexOf("{", functionStart);
  if (brace < 0) throw new Error("Could not find opening brace");

  let depth = 0;
  let quote = "";
  let escape = false;

  for (let i = brace; i < text.length; i++) {
    const c = text[i];

    if (quote) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === quote) quote = "";
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }

    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }

  throw new Error("Could not find function end");
}

const sig = "function getSyncState(data:Ledger|null){";
const start = s.indexOf(sig);
if (start < 0) throw new Error("getSyncState not found");

const end = findFunctionEnd(s, start);

const fn =
  'function getSyncState(data:Ledger|null,book:"us"|"india"="us"){' +
  "const anyData=data as any;" +
  "const health=anyData?.syncHealth?.[book]||anyData?.syncHealth;" +
  "const age=health?.lastCheckedAt?Date.now()-Date.parse(health.lastCheckedAt):Infinity;" +
  "const fresh=Number.isFinite(age)&&age<5*60*1000;" +
  "const tx=data?.transactions||[],accounts=data?.accounts||[],groups=(data as any)?.groups||[];" +
  "const localErrors=tx.filter(isVoucherSyncError).length+accounts.filter(isMasterSyncError).length+groups.filter(isMasterSyncError).length;" +
  "const localPending=tx.filter(isVoucherPendingSync).length+accounts.filter(isMasterPendingSync).length+groups.filter(isMasterPendingSync).length;" +
  "const conflicts=Number(health?.conflicts||0);" +
  "const tallyToApp=Number(health?.tallyToApp||0);" +
  "const appToTally=Number(health?.appToTally||0);" +
  "const errors=conflicts+Number(health?.errors||0)+localErrors;" +
  "const pending=tallyToApp+appToTally+localPending;" +
  'if(health?.status==="error"||errors>0)return{tone:"error",label:String(errors||1)+" sync issue"+((errors||1)===1?"":"s")};' +
  'if(!fresh||health?.status==="pending"||pending>0)return{tone:"pending",label:fresh?String(pending||1)+" pending sync":"Sync status pending"};' +
  'return{tone:"success",label:"Sync successful"}' +
  "}";

s = s.slice(0, start) + fn + s.slice(end);

s = s.replace(
  /const syncState\s*=\s*getSyncState\(data\)/,
  "const syncState=getSyncState(data,book)"
);

s = s.replace(
  /\.\.\.\(editTx\?\{tallyGuid:editTx\.tallyGuid,syncFingerprint:editTx\.syncFingerprint,syncStatus:editTx\.syncStatus,lastSyncedAt:editTx\.lastSyncedAt\}:\{\}\),/,
  '...(editTx?{tallyGuid:editTx.tallyGuid,syncFingerprint:editTx.syncFingerprint,syncStatus:"pending",lastSyncedAt:undefined}:{syncStatus:"pending",lastSyncedAt:undefined}),'
);

s = s.replace(/setInterval\(check,\s*30000\)/, "setInterval(check,10000)");

fs.writeFileSync(p, s, "utf8");
console.log("patched getSyncState");