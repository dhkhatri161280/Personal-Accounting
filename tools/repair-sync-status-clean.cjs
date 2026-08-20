const fs = require("fs");
const path = require("path");

const root = process.cwd();
const tsxPath = path.join(root, "components", "VaultApp.tsx");
const cssPath = path.join(root, "app", "globals.css");

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backup(file) {
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.backup-clean-sync-${stamp()}`);
  }
}

function findMatching(src, openIndex, openChar, closeChar) {
  let depth = 0;
  let quote = null;
  let escape = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    if (lineComment) {
      if (ch === "\n" || ch === "\r") lineComment = false;
      continue;
    }

    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }

    if (quote) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === openChar) depth++;
    if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function replaceFunction(src, name, replacement) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`Could not find function ${name}`);

  const brace = src.indexOf("{", start);
  if (brace < 0) throw new Error(`Could not find opening brace for ${name}`);

  const end = findMatching(src, brace, "{", "}");
  if (end < 0) throw new Error(`Could not find closing brace for ${name}`);

  return src.slice(0, start) + replacement + src.slice(end + 1);
}

function findCallEnd(src, start) {
  const paren = src.indexOf("(", start);
  if (paren < 0) return -1;
  return findMatching(src, paren, "(", ")");
}

if (!fs.existsSync(tsxPath)) {
  throw new Error(`Missing ${tsxPath}`);
}

backup(tsxPath);

let tsx = fs.readFileSync(tsxPath, "utf8");

if (!/\btype\s+SyncHealth\b/.test(tsx)) {
  const idx = tsx.indexOf("function getSyncState");
  if (idx < 0) throw new Error("Could not find getSyncState insertion point");

  tsx =
    tsx.slice(0, idx) +
    `type SyncHealth={book?:string;status?:string|null;lastCheckedAt?:string|null;matched?:number;tallyToApp?:number;appToTally?:number;conflicts?:number;errors?:number;message?:string|null};\n` +
    tsx.slice(idx);
}

const cleanGetSyncState = `function getSyncState(data:Ledger|null,book:"us"|"india",health?:SyncHealth|null){
 const tx=data?.transactions||[],accounts=data?.accounts||[],groups=(data as any)?.groups||[];
 const status=String(health?.status||"").toLowerCase();
 const hasRemote=!!health&&(!!health.lastCheckedAt||status==="success"||status==="pending"||status==="running"||status==="syncing"||status==="error"||Number.isFinite(Number(health.tallyToApp))||Number.isFinite(Number(health.appToTally))||Number.isFinite(Number(health.conflicts))||Number.isFinite(Number(health.errors)));
 if(hasRemote){
  const tallyToApp=Number(health?.tallyToApp||0),appToTally=Number(health?.appToTally||0),conflicts=Number(health?.conflicts||0),errors=Number(health?.errors||0);
  const issueCount=errors+conflicts;
  const pendingCount=tallyToApp+appToTally;
  if(status==="error"||issueCount>0)return{tone:"error" as const,label:health?.message||String(issueCount||1)+" sync issue"+((issueCount||1)===1?"":"s")};
  if(status==="pending"||status==="running"||status==="syncing"||pendingCount>0)return{tone:"pending" as const,label:health?.message||String(pendingCount||1)+" pending sync"};
  return{tone:"success" as const,label:health?.message||"Sync successful"};
 }
 const localErrors=tx.filter(isVoucherSyncError).length+accounts.filter(isMasterSyncError).length+groups.filter(isMasterSyncError).length;
 const localPending=tx.filter(isVoucherPendingSync).length+accounts.filter(isMasterPendingSync).length+groups.filter(isMasterPendingSync).length;
 if(localErrors)return{tone:"error" as const,label:String(localErrors)+" sync error"+(localErrors===1?"":"s")};
 if(localPending)return{tone:"pending" as const,label:String(localPending)+" item"+(localPending===1?"":"s")+" pending sync"};
 return{tone:"success" as const,label:"Sync successful"};
}`;

tsx = replaceFunction(tsx, "getSyncState", cleanGetSyncState);

if (!tsx.includes("remoteSyncHealth")) {
  const bookMatch = /\[\s*book\s*,\s*setBook\s*\]/.exec(tsx);
  if (!bookMatch) throw new Error("Could not find [book,setBook] state");

  const useStateStart = tsx.indexOf("useState", bookMatch.index);
  if (useStateStart < 0) throw new Error("Could not find book useState");

  const closeParen = findCallEnd(tsx, useStateStart);
  if (closeParen < 0) throw new Error("Could not find end of book useState");

  const remoteState = `,[remoteSyncHealth,setRemoteSyncHealth]=useState<SyncHealth|null>(null)`;
  tsx = tsx.slice(0, closeParen + 1) + remoteState + tsx.slice(closeParen + 1);

  const statementEnd = tsx.indexOf(";", closeParen + remoteState.length);
  if (statementEnd < 0) throw new Error("Could not find end of book state statement");

  const remoteEffect =
    `useEffect(()=>{let active=true;async function check(){try{const res=await fetch("/api/sync-status?book="+book+"&t="+Date.now(),{cache:"no-store"});if(!res.ok)throw new Error(String(res.status));const next=await res.json() as SyncHealth;if(active)setRemoteSyncHealth(next)}catch{if(active)setRemoteSyncHealth(null)}}check();const id=setInterval(check,10000);return()=>{active=false;clearInterval(id)}},[book]);`;

  tsx = tsx.slice(0, statementEnd + 1) + remoteEffect + tsx.slice(statementEnd + 1);
}

const beforeCallPatch = tsx;
tsx = tsx.replace(/getSyncState\(\s*data\s*(?:,\s*book\s*)?(?:,\s*remoteSyncHealth\s*)?\)/g, "getSyncState(data,book,remoteSyncHealth)");

if (beforeCallPatch === tsx && !tsx.includes("getSyncState(data,book,remoteSyncHealth)")) {
  throw new Error("Could not patch getSyncState call");
}

fs.writeFileSync(tsxPath, tsx, "utf8");

if (fs.existsSync(cssPath)) {
  backup(cssPath);
  let css = fs.readFileSync(cssPath, "utf8");

  const block = `
/* Clean sync lock status colors */
.sync-lock-button.success{background:#dcfce7!important;border-color:#86efac!important;color:#166534!important}
.sync-lock-button.pending{background:#fef08a!important;border-color:#facc15!important;color:#854d0e!important}
.sync-lock-button.error{background:#fee2e2!important;border-color:#f87171!important;color:#991b1b!important}
.sync-lock-button>svg,.sync-lock-button .sync-lock-icon{display:block!important}
`;

  if (!css.includes("Clean sync lock status colors")) {
    css += block;
    fs.writeFileSync(cssPath, css, "utf8");
  }
}

console.log("Clean sync status source repair applied.");
console.log("Remote /api/sync-status now controls the lock color first.");