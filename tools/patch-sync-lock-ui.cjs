const fs = require("fs");
const path = require("path");

const p = path.join(process.cwd(), "components", "VaultApp.tsx");
if (!fs.existsSync(p)) throw Error("Missing components/VaultApp.tsx");

let s = fs.readFileSync(p, "utf8");
fs.copyFileSync(p, p + ".backup-sync-lock-ui-" + new Date().toISOString().replace(/[:.]/g, "-"));

const component = `
function SyncStatusLock({book,onClick}:{book:"us"|"india";onClick:()=>void}){
const [health,setHealth]=useState<any>(null);
useEffect(()=>{let dead=false;async function load(){try{const r=await fetch(\`/api/sync-status?book=\${book}\`,{cache:"no-store"});if(!r.ok)return;const h=await r.json();if(!dead)setHealth(h)}catch{if(!dead)setHealth({status:"pending",lastCheckedAt:null,message:"Sync unavailable"})}}load();const id=setInterval(load,10000);return()=>{dead=true;clearInterval(id)}},[book]);
const age=health?.lastCheckedAt?Date.now()-Date.parse(health.lastCheckedAt):Infinity;
const fresh=Number.isFinite(age)&&age<5*60*1000;
const conflicts=Number(health?.conflicts||0),errors=Number(health?.errors||0),tallyToApp=Number(health?.tallyToApp||0),appToTally=Number(health?.appToTally||0);
const issueCount=conflicts+errors;
const pendingCount=tallyToApp+appToTally;
const tone=health?.status==="error"||issueCount>0?"error":(!fresh||health?.status==="pending"||pendingCount>0)?"pending":"success";
const label=tone==="error"?\`\${issueCount||1} sync issue\${(issueCount||1)===1?"":"s"}\`:tone==="pending"?\`\${pendingCount||1} pending sync\`:"Sync successful";
return <button type="button" className={\`sync-lock-button \${tone}\`} title={\`\${label}. Lock vault\`} aria-label={\`\${label}. Lock vault\`} onClick={onClick}><svg className="sync-lock-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="10" width="14" height="10" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg></button>;
}
`;

if (!s.includes("function SyncStatusLock")) {
  const i = s.indexOf("export function VaultApp");
  if (i < 0) throw Error("Could not find export function VaultApp");
  s = s.slice(0, i) + component + s.slice(i);
}

const marker = "sync-lock-button ${syncTone}";
const markerIndex = s.indexOf(marker);
if (markerIndex < 0) throw Error("Could not find old sync lock button using syncTone");

const start = s.lastIndexOf("<button", markerIndex);
const end = s.indexOf("</button>", markerIndex);
if (start < 0 || end < 0) throw Error("Could not locate full old sync lock button");

s = s.slice(0, start) + "<SyncStatusLock book={book} onClick={lockVault}/>" + s.slice(end + "</button>".length);

fs.writeFileSync(p, s, "utf8");
console.log("Patched sync lock UI to read /api/sync-status directly.");