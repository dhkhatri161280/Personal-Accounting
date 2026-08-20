const fs=require("fs"),path=require("path");
const p=path.join(process.cwd(),"components","VaultApp.tsx");
if(!fs.existsSync(p)) throw Error("Run from personal-accounting-app folder. Missing "+p);
let s=fs.readFileSync(p,"utf8");
fs.copyFileSync(p,p+".backup-sync-status-"+new Date().toISOString().replace(/[:.]/g,"-"));

function replaceFunction(src,name,body){
  const sig="function "+name;
  const start=src.indexOf(sig);
  if(start<0) throw Error("Missing "+name);
  const brace=src.indexOf("{",start);
  let depth=0,end=-1;
  for(let i=brace;i<src.length;i++){
    if(src[i]==="{") depth++;
    if(src[i]==="}") depth--;
    if(depth===0){end=i+1;break;}
  }
  if(end<0) throw Error("Could not parse "+name);
  return src.slice(0,start)+body+src.slice(end);
}

const fn=`function getSyncState(data:Ledger|null,book:"us"|"india"="us"){
const anyData=data as any;
const health=anyData?.syncHealth?.[book]||anyData?.syncHealth||null;
const age=health?.lastCheckedAt?Date.now()-Date.parse(health.lastCheckedAt):Infinity;
const fresh=Number.isFinite(age)&&age<5*60*1000;
const tx=anyData?.transactions||[],accounts=anyData?.accounts||[],groups=anyData?.groups||[];
const bad=(v:any)=>["error","failed","conflict"].includes(String(v||"").toLowerCase());
const localErrors=tx.filter((t:any)=>bad(t.syncStatus)).length+accounts.filter((a:any)=>bad(a.masterSyncStatus)).length+groups.filter((g:any)=>bad(g.masterSyncStatus)).length;
const localPending=tx.filter((t:any)=>!t.historical&&(t.deleted||t.syncStatus==="pending"||String(t.syncFingerprint||"").startsWith("app-change-")||(!t.tallyGuid&&!t.syncFingerprint))).length+accounts.filter((a:any)=>a.masterSyncStatus==="pending"||a.masterDeletePending).length+groups.filter((g:any)=>g.masterSyncStatus==="pending"||g.masterDeletePending).length;
const conflicts=Number(health?.conflicts||0),tallyToApp=Number(health?.tallyToApp||0),appToTally=Number(health?.appToTally||0);
const errors=localErrors+conflicts+Number(health?.errors||0);
const pending=localPending+tallyToApp+appToTally;
if(errors>0||health?.status==="error")return{tone:"error",label:\`\${errors||1} sync issue\${(errors||1)===1?"":"s"}\`};
if(!fresh||health?.status==="pending"||pending>0)return{tone:"pending",label:\`\${pending||1} pending sync\`};
return{tone:"success",label:"Sync successful"};
}`;

s=replaceFunction(s,"getSyncState",fn);
s=s.replace(/getSyncState\(data\)/g,"getSyncState(data,book)");
s=s.replace(/setInterval\(check,\s*30000\)/g,"setInterval(check,10000)");
s=s.replace(/syncFingerprint:editTx\.syncFingerprint,syncStatus:editTx\.syncStatus,lastSyncedAt:editTx\.lastSyncedAt/g,'syncFingerprint:editTx.syncFingerprint,syncStatus:"pending",lastSyncedAt:undefined');
s=s.replace(/syncStatus:"pending",lastSyncedAt:undefined,syncStatus:"pending",lastSyncedAt:undefined/g,'syncStatus:"pending",lastSyncedAt:undefined');

if(/syncStatus:editTx\.syncStatus/.test(s)) throw Error("Old edit syncStatus logic still exists.");
fs.writeFileSync(p,s);
console.log("App status patch applied.");