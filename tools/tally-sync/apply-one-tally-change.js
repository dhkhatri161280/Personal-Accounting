'use strict';
const fs=require('fs'),path=require('path');
const {norm,cents,fp,normaliseBase,encrypt,parse,post,load}=require('./sync-core');
const book=String(process.argv[2]||'').toLowerCase();
if(!['us','india'].includes(book)){console.error('ERROR: Choose US or INDIA.');process.exit(1)}
const now=new Date(),fy=now.getMonth()>=3?now.getFullYear():now.getFullYear()-1;
const start=`${fy}-04-01`,end=`${fy+1}-03-31`,startTally=`1-Apr-${fy}`,endTally=`31-Mar-${fy+1}`;
const tallyPort=Number(process.env.PL_TALLY_PORT||(book==='india'?9000:9001));
const accessToken=process.env.PL_ACCESS_CODE||'';

function requestXml(){return`<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PL One Edit Apply</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVFROMDATE TYPE="Date">${startTally}</SVFROMDATE><SVTODATE TYPE="Date">${endTally}</SVTODATE></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="PL One Edit Apply" ISMODIFY="No"><TYPE>Voucher</TYPE><FETCH>GUID,Date,VoucherTypeName,VoucherNumber,Narration,AllLedgerEntries.*</FETCH><FILTER>PLApplyDate</FILTER></COLLECTION><SYSTEM TYPE="Formulae" NAME="PLApplyDate">$Date &gt;= $$Date:"${startTally}" AND $Date &lt;= $$Date:"${endTally}"</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`}

function compare(vault,tally){
  const cloud=vault.transactions.filter(x=>!x.deleted&&x.date>=start&&x.date<=end);
  const cloudIds=new Map(cloud.map(x=>[norm(x.tallyGuid||x.guid),x]));
  const tallyIds=new Map(tally.map(x=>[norm(x.guid),x]));
  const out={matched:[],tallyChanged:[],appChanged:[],tallyOnly:[],tallyDeletes:[],appOnly:[],conflicts:[]};
  for(const t of tally){
    const c=cloudIds.get(norm(t.guid));
    if(!c){out.tallyOnly.push(t);continue}
    const tf=fp(t),cf=fp(c),base=normaliseBase(c.syncFingerprint);
    if(tf===cf)out.matched.push(t);
    else if(!base)out.conflicts.push({tally:t,app:c});
    else{const tc=tf!==base,cc=cf!==base;
      // A voucher cancelled in Tally exports with zero entries — that's not a real Tally-side
      // edit to pull, it's Tally diverging from a still-valid App voucher. Surface it as an
      // App-side item so this engine doesn't offer to overwrite the App's correct data.
      if(t.cancelled&&tc&&!cc)out.appChanged.push(c);
      else if(tc&&!cc)out.tallyChanged.push({tally:t,app:c});else if(!tc&&cc)out.appChanged.push(c);else out.conflicts.push({tally:t,app:c})}
  }
  for(const c of cloud)if(!tallyIds.has(norm(c.tallyGuid||c.guid))){if(c.tallyGuid&&(c.syncFingerprint||c.syncStatus==='synced'))out.tallyDeletes.push(c);else out.appOnly.push(c)}
  return out;
}

(async()=>{try{
  const sitePw=process.env.PL_SITE_PASSWORD||'',vaultPw=process.env.PL_VAULT_PASSWORD||'',confirmation=process.env.PL_APPLY_CONFIRM||'';
  if(!sitePw||!vaultPw)throw Error('Passwords were not supplied');
  if(!accessToken)throw Error('PL_ACCESS_CODE not set -- required for /api/vault writes');
  const auth='Basic '+Buffer.from('manual-one-edit:'+sitePw).toString('base64');
  const state=await load(auth,vaultPw,book);
  const tally=parse(await post(requestXml(),tallyPort));
  const plan=compare(state.vault,tally);
  const candidates=[...plan.tallyChanged.map(x=>({...x,action:'edit'})),...plan.tallyOnly.map(tally=>({tally,app:null,action:'create'})),...plan.tallyDeletes.map(app=>({tally:null,app,action:'delete'}))];
  // appOnly items are independent new vouchers not yet pushed to Tally — unrelated to this
  // single targeted write, so they don't block it. Only genuine divergence (appChanged) or
  // an unresolved conflict on the SAME voucher must block.
  const exceptions=plan.appChanged.length+plan.conflicts.length;
  console.log(`FRESH PLAN: ${plan.matched.length} matched, ${plan.tallyChanged.length} Tally edits, ${plan.appChanged.length} App edits, ${plan.tallyOnly.length} Tally-only, ${plan.tallyDeletes.length} Tally-deletes, ${plan.appOnly.length} App-only, ${plan.conflicts.length} conflicts.`);
  if(candidates.length<1||exceptions!==0)throw Error('Safety stop: expected one or more isolated Tally-side creates, edits, or deletes');
  const x=candidates[0],t=x.tally,c=x.app,source=t||c;
  if(!source)throw Error('Safety stop: selected change has no source voucher');
  const sourceEntries=Array.isArray(source.entries)?source.entries:[],total=x.action==='delete'?0:sourceEntries.reduce((s,e)=>s+cents(e.amount),0);
  console.log(`APPROVED CANDIDATE: ${source.date} | ${source.type} ${source.number} | ${source.narration}`);
  for(const e of sourceEntries)console.log(`  ${e.name||e.accountName} ${Number(e.amount).toFixed(2)}`);
  const expected=`APPLY ${book.toUpperCase()} ${source.type.toUpperCase()} ${source.number}`;
  if(confirmation!==expected)throw Error(`Confirmation missing. Expected exactly: ${expected}`);
  if(x.action!=='delete'&&(total!==0||sourceEntries.length<2))throw Error('Safety stop: Tally voucher is not balanced');

  // Map Tally ledger names to App accounts using norm() — tolerates dash variants
  const byName=new Map(state.vault.accounts.map(a=>[norm(a.name),a]));
  const entries=x.action==='delete'?[]:sourceEntries.map(e=>{
    const a=byName.get(norm(e.name));
    if(!a)throw Error('Ledger missing in app: '+e.name);
    return{accountId:a.id,accountName:a.name,amount:e.amount}
  });

  const backup=path.join(__dirname,`encrypted-${book}-vault-before-one-edit-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  fs.writeFileSync(backup,state.raw);
  const target=x.action==='create'?{id:Math.max(0,...state.vault.transactions.map(v=>Number(v.id)||0))+1,guid:t.guid,tallyGuid:t.guid,historical:false}:c;
  if(x.action==='delete'){target.deleted=true;target.syncStatus='deleted';target.syncFingerprint='';target.lastSyncedAt=new Date().toISOString()}
  else{target.date=t.date;target.type=t.type;target.number=t.number;target.narration=t.narration;target.entries=entries;target.tallyGuid=t.guid;target.syncFingerprint=fp(t);target.syncStatus='synced';target.lastSyncedAt=new Date().toISOString();target.deleted=false;if(x.action==='create')state.vault.transactions.push(target)}
  const body=JSON.stringify(encrypt(state.vault,vaultPw));
  const put=await fetch(state.url,{method:'PUT',headers:{Authorization:auth,'Content-Type':'application/json','If-Match':state.etag,'x-dk-access-token':accessToken},body});
  if(!put.ok)throw Error('Cloud update rejected HTTP '+put.status+' '+await put.text());
  const verify=await load(auth,vaultPw,book);
  const finalPlan=compare(verify.vault,parse(await post(requestXml(),tallyPort)));
  const unsafe=finalPlan.appChanged.length+finalPlan.conflicts.length;
  if(unsafe!==0)throw Error('Post-update verification found unsafe App-side changes or conflicts');
  const queued=finalPlan.tallyChanged.length+finalPlan.tallyOnly.length+finalPlan.tallyDeletes.length;
  console.log(x.action==='delete'?'SUCCESS: Exactly one Tally deletion was copied to the encrypted app vault.':'SUCCESS: Exactly one Tally create/edit was copied to the encrypted app vault.');
  if(queued)console.log('QUEUE_REMAINING: '+queued+' Tally voucher(s) will be processed in later cycles.');
  console.log('Tally was read only and was not changed.');
  console.log('Encrypted backup: '+backup);
}catch(e){console.error('ERROR:',e.message);process.exitCode=1}})();
