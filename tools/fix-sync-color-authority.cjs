const fs = require("fs");
const path = require("path");

const root = process.cwd();
const file = path.join(root, "components", "VaultApp.tsx");

if (!fs.existsSync(file)) {
  throw new Error("Run this from C:\\Users\\dikhatri\\Documents\\Codex\\personal-accounting-app");
}

let src = fs.readFileSync(file, "utf8");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.copyFileSync(file, `${file}.backup-sync-color-authority-${stamp}`);

const start = src.indexOf("function getSyncState");
if (start < 0) throw new Error("function getSyncState not found");

const bodyStart = src.indexOf("{", start);
let depth = 0;
let end = -1;
let quote = "";
let escaped = false;

for (let i = bodyStart; i < src.length; i++) {
  const c = src[i];

  if (quote) {
    if (escaped) escaped = false;
    else if (c === "\\") escaped = true;
    else if (c === quote) quote = "";
    continue;
  }

  if (c === '"' || c === "'" || c === "`") {
    quote = c;
    continue;
  }

  if (c === "{") depth++;
  if (c === "}") {
    depth--;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}

if (end < 0) throw new Error("getSyncState end not found");

const fixed =
  'function getSyncState(data:Ledger|null,book:"us"|"india"="us"){' +
  'const anyData=data as any;' +
  'const health=anyData?.syncHealth?.[book]||null;' +
  'if(health){' +
  'const status=String(health.status||"").toLowerCase();' +
  'const errors=Number(health.errors||0)+Number(health.conflicts||0);' +
  'const pending=Number(health.tallyToApp||0)+Number(health.appToTally||0);' +
  'if(status==="error"||status==="failed"||errors>0)return{tone:"error",label:`${errors||1} sync issue${(errors||1)===1?"":"s"}`};' +
  'if(status==="pending"||status==="running"||status==="in_progress"||pending>0)return{tone:"pending",label:`${pending||1} item${(pending||1)===1?"":"s"} pending sync`};' +
  'return{tone:"success",label:"Sync successful"}' +
  '}' +
  'const tx=data?.transactions||[],accounts=data?.accounts||[],groups=(data as any)?.groups||[];' +
  'const errors=tx.filter(isVoucherSyncError).length+accounts.filter(isMasterSyncError).length+groups.filter(isMasterSyncError).length;' +
  'const pending=tx.filter(isVoucherPendingSync).length+accounts.filter(isMasterPendingSync).length+groups.filter(isMasterPendingSync).length;' +
  'if(errors)return{tone:"error",label:`${errors} sync issue${errors===1?"":"s"}`};' +
  'if(pending)return{tone:"pending",label:`${pending} item${pending===1?"":"s"} pending sync`};' +
  'return{tone:"success",label:"Sync successful"}' +
  '}';

src = src.slice(0, start) + fixed + src.slice(end);

src = src.replace(
  /fetch\(`\/api\/sync-status\?book=\$\{book\}`\)/g,
  'fetch(`/api/sync-status?book=${book}&t=${Date.now()}`,{cache:"no-store"})'
);

src = src.replace(
  /fetch\(`\/api\/sync-status\?book=\$\{book\}&t=\$\{Date\.now\(\)\}`\)(?!,\{cache:"no-store"\})/g,
  'fetch(`/api/sync-status?book=${book}&t=${Date.now()}`,{cache:"no-store"})'
);

fs.writeFileSync(file, src, "utf8");

const check = fs.readFileSync(file, "utf8");
if (!check.includes("const health=anyData?.syncHealth?.[book]||null;if(health)")) {
  throw new Error("Patch verification failed");
}

console.log("Clean sync color authority fix applied.");
console.log("Lock color now follows /api/sync-status first; stale local pending flags are fallback only.");