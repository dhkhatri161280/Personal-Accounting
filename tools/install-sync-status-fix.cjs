const fs = require("fs");
const path = require("path");

const root = process.cwd();
const tsxPath = path.join(root, "components", "VaultApp.tsx");
const routeDir = path.join(root, "app", "api", "sync-status");
const routePath = path.join(routeDir, "route.ts");

if (!fs.existsSync(tsxPath)) throw Error("Missing components/VaultApp.tsx");

fs.mkdirSync(routeDir, { recursive: true });
fs.copyFileSync(tsxPath, tsxPath + ".backup-sync-status-api-" + new Date().toISOString().replace(/[:.]/g, "-"));

fs.writeFileSync(routePath, `
import {env} from "cloudflare:workers";
import type {AppBindings} from "@/lib/cloudflare-env";
const bindings=env as unknown as AppBindings;
export const dynamic="force-dynamic";

function bookOf(request:Request){
  const b=(new URL(request.url).searchParams.get("book")||"us").toLowerCase();
  return b==="india"?"india":"us";
}
function key(book:string){return "fintech-by-dk.book."+book+".sync-status";}
function clean(input:any,book:string){
  const status=["success","pending","error"].includes(String(input?.status))?String(input.status):"pending";
  return {
    book,
    status,
    lastCheckedAt: input?.lastCheckedAt || null,
    matched:Number(input?.matched||0),
    tallyToApp:Number(input?.tallyToApp||0),
    appToTally:Number(input?.appToTally||0),
    conflicts:Number(input?.conflicts||0),
    errors:Number(input?.errors||0),
    message:String(input?.message||"")
  };
}
export async function GET(request:Request){
  if(!bindings.VAULT)return Response.json({status:"pending",message:"Status storage not configured"},{headers:{"Cache-Control":"no-store"}});
  const book=bookOf(request);
  const raw=await bindings.VAULT.get(key(book));
  if(!raw)return Response.json({book,status:"pending",lastCheckedAt:null,matched:0,tallyToApp:0,appToTally:0,conflicts:0,errors:0,message:"No Tally sync status published yet"},{headers:{"Cache-Control":"no-store"}});
  return Response.json(clean(JSON.parse(raw),book),{headers:{"Cache-Control":"no-store"}});
}
export async function PUT(request:Request){
  if(!bindings.VAULT)return new Response("Status storage not configured",{status:503});
  if(!request.headers.get("authorization"))return new Response("Missing sync authorization",{status:401});
  const book=bookOf(request);
  const body=clean(await request.json(),book);
  body.lastCheckedAt=new Date().toISOString();
  await bindings.VAULT.put(key(book),JSON.stringify(body));
  return Response.json({ok:true,...body});
}
`, "utf8");

let s = fs.readFileSync(tsxPath, "utf8");

function replaceFunction(src, name, body) {
  const start = src.indexOf("function " + name);
  if (start < 0) throw Error("Missing function " + name);
  const brace = src.indexOf("{", start);
  let depth = 0, end = -1;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth++;
    if (src[i] === "}") depth--;
    if (depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw Error("Could not parse function " + name);
  return src.slice(0, start) + body + src.slice(end);
}

const getSyncState = `function getSyncState(data:any,book:"us"|"india"="us"){
const health=(data as any)?.syncHealth?.[book]||null;
const age=health?.lastCheckedAt?Date.now()-Date.parse(health.lastCheckedAt):Infinity;
const fresh=Number.isFinite(age)&&age<5*60*1000;
const tx=(data as any)?.transactions||[],accounts=(data as any)?.accounts||[],groups=(data as any)?.groups||[];
const bad=(v:any)=>["error","failed","conflict"].includes(String(v||"").toLowerCase());
const localErrors=tx.filter((t:any)=>bad(t.syncStatus)).length+accounts.filter((a:any)=>bad(a.masterSyncStatus)).length+groups.filter((g:any)=>bad(g.masterSyncStatus)).length;
const localPending=tx.filter((t:any)=>!t.historical&&(t.deleted||t.syncStatus==="pending"||String(t.syncFingerprint||"").startsWith("app-change-")||(!t.tallyGuid&&!t.syncFingerprint))).length+accounts.filter((a:any)=>a.masterSyncStatus==="pending"||a.masterDeletePending).length+groups.filter((g:any)=>g.masterSyncStatus==="pending"||g.masterDeletePending).length;
const conflicts=Number(health?.conflicts||0),tallyToApp=Number(health?.tallyToApp||0),appToTally=Number(health?.appToTally||0),healthErrors=Number(health?.errors||0);
const errors=localErrors+conflicts+healthErrors;
const pending=localPending+tallyToApp+appToTally;
if(!fresh)return{tone:"pending",label:"Sync status updating"};
if(errors>0||health?.status==="error")return{tone:"error",label:\`\${errors||1} sync issue\${(errors||1)===1?"":"s"}\`};
if(pending>0||health?.status==="pending")return{tone:"pending",label:\`\${pending||1} pending sync\`};
return{tone:"success",label:"Sync successful"};
}`;

s = replaceFunction(s, "getSyncState", getSyncState);

if (!s.includes("/api/sync-status?book=")) {
  const m = s.match(/const\\s+apiUrl\\s*=\\s*[^;]+;/);
  if (!m) throw Error("Could not find apiUrl in VaultApp.tsx");
  const hook = `useEffect(()=>{let dead=false;async function loadSyncHealth(){try{const r=await fetch(\`/api/sync-status?book=\${book}\`,{cache:"no-store"});if(!r.ok)return;const h=await r.json();if(dead)return;setData((current:any)=>current?({...current,syncHealth:{...((current as any).syncHealth||{}),[book]:h}} as any):current)}catch{}}loadSyncHealth();const id=setInterval(loadSyncHealth,10000);return()=>{dead=true;clearInterval(id)}},[book]);`;
  s = s.slice(0, m.index + m[0].length) + hook + s.slice(m.index + m[0].length);
}

s = s.replace(/getSyncState\\(data\\)/g, "getSyncState(data,book)");
s = s.replace(/setInterval\\(check,\\s*30000\\)/g, "setInterval(check,10000)");
s = s.replace(/syncStatus:editTx\\.syncStatus/g, 'syncStatus:"pending"');
s = s.replace(/lastSyncedAt:editTx\\.lastSyncedAt/g, "lastSyncedAt:undefined");
while (s.includes('syncStatus:"pending",syncStatus:"pending"')) {
  s = s.replace(/syncStatus:"pending",syncStatus:"pending"/g, 'syncStatus:"pending"');
}

fs.writeFileSync(tsxPath, s, "utf8");
console.log("Created:", routePath);
console.log("Patched VaultApp sync status.");