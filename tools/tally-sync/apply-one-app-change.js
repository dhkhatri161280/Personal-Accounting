'use strict';
const fs=require('fs'),path=require('path');
const {norm,cents,fp,normaliseBase,encrypt,parse,post,createXml,deleteXml,alterXml,validateEntryRules,load}=require('./sync-core');
const book=String(process.argv[2]||'').toLowerCase();
if(!['us','india'].includes(book)){console.error('ERROR: Choose US or INDIA.');process.exit(1)}
const now=new Date(),fy=now.getMonth()>=3?now.getFullYear():now.getFullYear()-1;
const start=`${fy}-04-01`,end=`${fy+1}-03-31`,startTally=`1-Apr-${fy}`,endTally=`31-Mar-${fy+1}`;
const tallyPort=Number(process.env.PL_TALLY_PORT||(book==='india'?9000:9001));
const accessToken=process.env.PL_ACCESS_CODE||'';

function requestXml(){return`<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PL App Edit Apply</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVFROMDATE TYPE="Date">${startTally}</SVFROMDATE><SVTODATE TYPE="Date">${endTally}</SVTODATE></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="PL App Edit Apply" ISMODIFY="No"><TYPE>Voucher</TYPE><FETCH>GUID,MasterID,Date,VoucherTypeName,VoucherNumber,Narration,AllLedgerEntries.*</FETCH><FILTER>PLAppApplyDate</FILTER></COLLECTION><SYSTEM TYPE="Formulae" NAME="PLAppApplyDate">$Date &gt;= $$Date:"${startTally}" AND $Date &lt;= $$Date:"${endTally}"</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`}

function compare(vault,tally){
  const all=vault.transactions.filter(x=>x.date>=start&&x.date<=end);
  const cloud=all.filter(x=>!x.deleted),deleted=all.filter(x=>x.deleted);
  const ci=new Map(cloud.map(x=>[norm(x.tallyGuid||x.guid),x]));
  const di=new Map(deleted.map(x=>[norm(x.tallyGuid||x.guid),x]));
  const ti=new Map(tally.map(x=>[norm(x.guid),x]));
  const o={matched:[],tallyChanged:[],appChanged:[],tallyOnly:[],appOnly:[],appDeletes:[],conflicts:[]};
  for(const t of tally){
    const k=norm(t.guid),d=di.get(k),c=ci.get(k);
    if(d){o.appDeletes.push({tally:t,app:d});continue}
    if(!c){o.tallyOnly.push(t);continue}
    const tf=fp(t),cf=fp(c),base=normaliseBase(c.syncFingerprint);
    if(tf===cf)o.matched.push(t);
    else if(!base)o.conflicts.push({tally:t,app:c});
    else{const tc=tf!==base,cc=cf!==base;
      // A voucher cancelled in Tally exports with zero entries — treat it as needing the
      // App's correct version pushed back (restore), not as a Tally-side edit to pull.
      if(t.cancelled&&tc&&!cc)o.appChanged.push({tally:t,app:c});
      else if(tc&&!cc)o.tallyChanged.push(t);else if(!tc&&cc)o.appChanged.push({tally:t,app:c});else o.conflicts.push({tally:t,app:c})}
  }
  for(const c of cloud)if(!ti.has(norm(c.tallyGuid||c.guid)))o.appOnly.push(c);
  return o;
}

(async()=>{try{
  const sp=process.env.PL_SITE_PASSWORD||'',vp=process.env.PL_VAULT_PASSWORD||'',confirmation=process.env.PL_APPLY_CONFIRM||'';
  if(!sp||!vp)throw Error('Passwords were not supplied');
  if(!accessToken)throw Error('PL_ACCESS_CODE not set -- required for /api/vault writes');
  const auth='Basic '+Buffer.from('manual-app-edit:'+sp).toString('base64');
  const state=await load(auth,vp,book);
  const tally=parse(await post(requestXml(),tallyPort));
  const plan=compare(state.vault,tally);
  const candidates=[...plan.appChanged.map(x=>({...x,action:'edit'})),...plan.appOnly.map(app=>({app,tally:null,action:'create'})),...plan.appDeletes.map(x=>({...x,action:'delete'}))];
  // tallyOnly items are independent new vouchers not yet pulled from Tally — unrelated to this
  // single targeted write, so they don't block it. Only genuine divergence (tallyChanged) or
  // an unresolved conflict on the SAME voucher must block.
  const exceptions=plan.tallyChanged.length+plan.conflicts.length;
  console.log(`FRESH PLAN: ${plan.matched.length} matched, ${plan.tallyChanged.length} Tally edits, ${plan.appChanged.length} App edits, ${plan.tallyOnly.length} Tally-only, ${plan.appOnly.length} App-only, ${plan.conflicts.length} conflicts.`);
  const planJson={matched:plan.matched.length,tallyToApp:plan.tallyChanged.length+plan.tallyOnly.length,appToTally:plan.appChanged.length+plan.appOnly.length+plan.appDeletes.length,conflicts:plan.conflicts.length};
  console.log('PLAN_JSON:'+JSON.stringify(planJson));

  // ── Identity repair: same data in both systems but Tally assigned its own GUID ──
  const repairPairs=[];
  for(const t of plan.tallyOnly)for(const c of plan.appOnly)if(fp(t)===fp(c))repairPairs.push({t,c});
  const repairable=repairPairs.length===1&&plan.tallyChanged.length===0&&plan.appChanged.length===0&&plan.conflicts.length===0;
  if(repairable){
    const {t,c}=repairPairs[0],expected=`APPLY ${book.toUpperCase()} ${String(c.type).toUpperCase()} ${c.number}`;
    if(confirmation!==expected)throw Error(`Confirmation missing. Expected exactly: ${expected}`);
    const fresh=await load(auth,vp,book);
    const freshCloud=fresh.vault.transactions.find(v=>norm(v.guid)===norm(c.guid)||norm(v.tallyGuid||v.guid)===norm(c.tallyGuid||c.guid));
    if(!freshCloud)throw Error('Identity repair could not find the App voucher');
    const backup=path.join(__dirname,`encrypted-${book}-vault-before-identity-repair-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    fs.writeFileSync(backup,fresh.raw);
    freshCloud.tallyGuid=t.guid;freshCloud.syncFingerprint=fp(t);freshCloud.syncStatus='synced';freshCloud.lastSyncedAt=new Date().toISOString();
    const body=JSON.stringify(encrypt(fresh.vault,vp));
    const put=await fetch(fresh.url,{method:'PUT',headers:{Authorization:auth,'Content-Type':'application/json','If-Match':fresh.etag,'x-dk-access-token':accessToken},body});
    if(!put.ok)throw Error('Identity repair cloud update failed HTTP '+put.status);
    const final=compare((await load(auth,vp,book)).vault,parse(await post(requestXml(),tallyPort)));
    const unsafe=final.tallyChanged.length+final.tallyOnly.length+final.conflicts.length,queued=final.appChanged.length+final.appOnly.length+final.appDeletes.length;
    if(unsafe)throw Error('Identity repair left Tally-side exceptions');
    console.log('SUCCESS: Existing Tally voucher linked to the App voucher; no duplicate was created.');
    if(queued)console.log('QUEUE_REMAINING: '+queued+' App voucher(s) will be processed in later cycles.');
    return;
  }

  if(candidates.length<1||exceptions!==0)throw Error('Safety stop: expected at least one App-side create, edit, or delete with no Tally-side exceptions');
  const x=candidates[0],c=x.app,t=x.tally,total=c.entries.reduce((s,e)=>s+cents(e.amount),0);
  console.log(`APPROVED CANDIDATE: ${c.date} | ${c.type} ${c.number} | ${c.narration}`);
  for(const e of c.entries)console.log(`  ${e.accountName} ${Number(e.amount).toFixed(2)}`);
  const expected=`APPLY ${book.toUpperCase()} ${String(c.type).toUpperCase()} ${c.number}`;
  if(confirmation!==expected)throw Error(`Confirmation missing. Expected exactly: ${expected}`);
  if((x.action!=='delete'&&(total!==0||c.entries.length<2))||(x.action!=='create'&&!t.masterId))throw Error('Safety stop: voucher is unbalanced or lacks Tally identity');
  if(x.action!=='delete'){const ruleErrors=validateEntryRules(c,state.vault.accounts);if(ruleErrors.length)throw Error('Voucher rule validation failed: '+ruleErrors.join('; '))}

  const response=await post(x.action==='create'?createXml(c):x.action==='delete'?deleteXml(t):alterXml(c,t),tallyPort);
  const audit=path.join(__dirname,`tally-${book}-one-app-edit-response-${new Date().toISOString().replace(/[:.]/g,'-')}.xml`);
  fs.writeFileSync(audit,response);
  // Tally's XML API reports a Delete (implemented as an Alter under the hood) in the
  // <ALTERED> count, not a dedicated <DELETED> tag — only Create gets its own <CREATED> tag.
  const actionTag=x.action==='create'?'CREATED':'ALTERED';
  if(!new RegExp('<'+actionTag+'>1<\\/'+actionTag+'>').test(response)||!/<ERRORS>0<\/ERRORS>/.test(response))throw Error('Tally did not confirm one clean '+x.action+'; response saved for review');

  // ── Post-write verification ───────────────────────────────────────────────
  // Tally sometimes ignores the GUID we send and assigns its own GUID.
  // We try GUID lookup first; if not found, fall back to fingerprint matching
  // so we still capture and record the actual GUID Tally assigned.
  const afterTally=parse(await post(requestXml(),tallyPort));
  let after=afterTally.find(v=>norm(v.guid)===norm(c.tallyGuid||c.guid));
  let writtenTallyGuid=c.tallyGuid||c.guid;
  if(!after&&x.action!=='delete'){
    after=afterTally.find(v=>fp(v)===fp(c));
    if(after){writtenTallyGuid=after.guid;console.log(`NOTE: Tally assigned GUID ${after.guid} (sent ${c.tallyGuid||c.guid})`)}
  }
  if(x.action==='delete'?!!after:(!after||fp(after)!==fp(c)))throw Error('Tally post-write verification did not match the App voucher action');

  // ── Baseline update ───────────────────────────────────────────────────────
  const fresh=await load(auth,vp,book);
  const freshCloud=fresh.vault.transactions.find(v=>norm(v.guid)===norm(c.guid)||norm(v.tallyGuid||v.guid)===norm(c.tallyGuid||c.guid));
  if(!freshCloud||fp(freshCloud)!==fp(c))throw Error('Cloud voucher changed during apply; baseline was not updated');
  freshCloud.tallyGuid=writtenTallyGuid;
  freshCloud.syncFingerprint=x.action==='delete'?'':fp(after);
  freshCloud.syncStatus=x.action==='delete'?'deleted':'synced';
  // Tally assigns its own voucher number on create (and can renumber on alter) — copy the
  // real number back so App and Tally always show the same number for a synced voucher.
  if(x.action!=='delete')freshCloud.number=after.number;
  freshCloud.lastSyncedAt=new Date().toISOString();
  const backup=path.join(__dirname,`encrypted-${book}-vault-before-app-edit-baseline-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  fs.writeFileSync(backup,fresh.raw);
  const body=JSON.stringify(encrypt(fresh.vault,vp));
  const put=await fetch(fresh.url,{method:'PUT',headers:{Authorization:auth,'Content-Type':'application/json','If-Match':fresh.etag,'x-dk-access-token':accessToken},body});
  if(!put.ok)throw Error('Tally changed successfully, but cloud baseline update failed HTTP '+put.status);

  const final=compare((await load(auth,vp,book)).vault,parse(await post(requestXml(),tallyPort)));
  const unsafe=final.tallyChanged.length+final.conflicts.length,queued=final.appChanged.length+final.appOnly.length+final.appDeletes.length;
  if(unsafe)throw Error('Post-apply reconciliation has Tally-side exceptions');
  console.log('SUCCESS: Exactly one App create/edit was applied to Tally and reconciled.');
  if(queued)console.log('QUEUE_REMAINING: '+queued+' App voucher(s) will be processed in later cycles.');
  console.log('Tally response audit: '+audit);
}catch(e){console.error('ERROR:',e.message);process.exitCode=1}})();
