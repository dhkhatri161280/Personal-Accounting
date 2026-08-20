const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "components", "VaultApp.tsx");
if (!fs.existsSync(file)) throw new Error("Missing components\\VaultApp.tsx");

let s = fs.readFileSync(file, "utf8");
fs.copyFileSync(file, file + ".backup-sync-state-" + new Date().toISOString().replace(/[:.]/g, "-"));

function findFunctionEnd(src, start) {
  const open = src.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let esc = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error("Could not find function end");
}

const fnStart = s.indexOf("function getSyncState");
if (fnStart < 0) throw new Error("function getSyncState not found");
const fnEnd = findFunctionEnd(s, fnStart);

const newFn = `function getSyncState(data:any,book:"us"|"india"="us"){const anyData=data as any;const health=anyData?.syncHealth?.[book]||anyData?.syncHealth;const tx=anyData?.transactions||[];const accounts=anyData?.accounts||[];const groups=anyData?.groups||[];const voucherPending=tx.filter((t:any)=>!t.historical&&(t.syncStatus==="pending"||t.deleted===true||t.syncDeletePending===true||t.deletePending===true||(!t.tallyGuid&&!t.syncFingerprint))).length;const masterPending=accounts.filter((a:any)=>a.masterSyncStatus==="pending"||a.masterDeletePending===true).length+groups.filter((g:any)=>g.masterSyncStatus==="pending"||g.masterDeletePending===true).length;const localPending=voucherPending+masterPending;const age=health?.lastCheckedAt?Date.now()-Date.parse(health.lastCheckedAt):Infinity;const fresh=Number.isFinite(age)&&age<5*60*1000;const tallyToApp=Number(health?.tallyToApp||0);const appToTally=Number(health?.appToTally||0);const conflicts=Number(health?.conflicts||0);const errors=Number(health?.errors||0);if(health?.status==="error"||conflicts>0||errors>0)return{tone:"error",label:\`\${conflicts||errors||1} sync issue\${(conflicts||errors||1)===1?"":"s"}\`};const pending=localPending+tallyToApp+appToTally;if(pending>0||health?.status==="pending"||!fresh)return{tone:"pending",label:\`\${pending||1} pending sync\`};return{tone:"success",label:"Sync successful"}}`;

s = s.slice(0, fnStart) + newFn + s.slice(fnEnd);

s = s.replace(/getSyncState\(data\)/g, "getSyncState(data,book)");
s = s.replace(/syncStatus\s*:\s*editTx\.syncStatus/g, 'syncStatus:"pending"');
s = s.replace(/lastSyncedAt\s*:\s*editTx\.lastSyncedAt/g, "lastSyncedAt:undefined");

fs.writeFileSync(file, s, "utf8");
console.log("Patched App sync state. Local App edits will now force yellow.");