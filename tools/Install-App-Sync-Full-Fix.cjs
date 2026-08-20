const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "components", "VaultApp.tsx");
if (!fs.existsSync(file)) throw new Error("components/VaultApp.tsx not found");

let s = fs.readFileSync(file, "utf8");
fs.copyFileSync(file, file + ".backup-full-sync-" + new Date().toISOString().replace(/[:.]/g, "-"));

function replaceFunction(src, name, body) {
  const sig = "function " + name;
  const start = src.indexOf(sig);
  if (start < 0) throw new Error(name + " not found");
  const brace = src.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth++;
    if (src[i] === "}") depth--;
    if (depth === 0) return src.slice(0, start) + body + src.slice(i + 1);
  }
  throw new Error(name + " end not found");
}

const getSyncState = `function getSyncState(data:any,book:"us"|"india"="us"){
  const health:any = (remoteSyncHealth && remoteSyncHealth.book===book) ? remoteSyncHealth : null;
  const tx = data?.transactions || [];
  const accounts = data?.accounts || [];
  const groups = (data as any)?.groups || [];

  const isPendingValue = (v:any) => ["pending","queued","app-to-tally","tally-to-app"].includes(String(v||"").toLowerCase());
  const isErrorValue = (v:any) => ["error","failed","conflict","blocked"].includes(String(v||"").toLowerCase());

  const localPending =
    tx.filter((t:any)=>isPendingValue(t.syncStatus)||t.deleted===true||t.deletePending===true||t.syncDeletePending===true).length +
    accounts.filter((a:any)=>isPendingValue(a.syncStatus)||isPendingValue(a.masterSyncStatus)||a.deleted===true||a.deletePending===true).length +
    groups.filter((g:any)=>isPendingValue(g.syncStatus)||isPendingValue(g.masterSyncStatus)||g.deleted===true||g.deletePending===true).length;

  const localErrors =
    tx.filter((t:any)=>isErrorValue(t.syncStatus)).length +
    accounts.filter((a:any)=>isErrorValue(a.syncStatus)||isErrorValue(a.masterSyncStatus)).length +
    groups.filter((g:any)=>isErrorValue(g.syncStatus)||isErrorValue(g.masterSyncStatus)).length;

  const age = health?.lastCheckedAt ? Date.now()-new Date(health.lastCheckedAt).getTime() : Infinity;
  const fresh = Number.isFinite(age) && age < 5*60*1000;
  const remotePending = Number(health?.tallyToApp||0)+Number(health?.appToTally||0);
  const remoteErrors = Number(health?.errors||0)+Number(health?.conflicts||0);

  if (localErrors || health?.status==="error" || remoteErrors) {
    const n = localErrors + remoteErrors || 1;
    return {tone:"error",label:\`\${n} sync issue\${n===1?"":"s"}\`};
  }

  if (localPending || !fresh || health?.status==="pending" || remotePending) {
    const n = localPending + remotePending || 1;
    return {tone:"pending",label:\`\${n} item\${n===1?"":"s"} pending sync\`};
  }

  return {tone:"success",label:"Sync successful"};
}`;

s = replaceFunction(s, "getSyncState", getSyncState);

s = s.replace(/getSyncState\(data\)/g, "getSyncState(data,book)");
s = s.replace(/syncStatus\s*:\s*editTx\.syncStatus/g, 'syncStatus:"pending"');
s = s.replace(/lastSyncedAt\s*:\s*editTx\.lastSyncedAt/g, "lastSyncedAt:undefined");
s = s.replace(/syncStatus\s*:\s*"pending"\s*,\s*lastSyncedAt\s*:\s*undefined\s*,\s*syncStatus\s*:\s*"pending"\s*,?/g, 'syncStatus:"pending",lastSyncedAt:undefined,');
s = s.replace(/syncStatus\s*:\s*"pending"\s*,\s*syncStatus\s*:\s*"pending"\s*,?/g, 'syncStatus:"pending",');

fs.writeFileSync(file, s, "utf8");
console.log("Patched VaultApp sync state and App edit pending behavior.");