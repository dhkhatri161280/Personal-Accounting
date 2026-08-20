const fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto'),zlib=require('zlib');
const book=String(process.argv[2]||'').toLowerCase();
if(!['us','india'].includes(book)){console.error('ERROR: Choose US or INDIA.');process.exit(1)}
const site='https://personal-ledger-dk.digneshkhatri.workers.dev',now=new Date(),fy=now.getMonth()>=3?now.getFullYear():now.getFullYear()-1,start=`${fy}-04-01`,end=`${fy+1}-03-31`,startTally=`1-Apr-${fy}`,endTally=`31-Mar-${fy+1}`;
const B=s=>Buffer.from(s,'base64'),b64=b=>Buffer.from(b).toString('base64'),norm=s=>String(s||'').replace(/&apos;/gi,"'").replace(/&quot;/gi,'"').replace(/&amp;/gi,'&').trim().toLowerCase(),cents=n=>Math.round(Number(n||0)*100);
function key(v,p){return crypto.pbkdf2Sync(p,B(v.salt),v.iterations,32,'sha256')}
function decrypt(v,p){const d=crypto.createDecipheriv('aes-256-gcm',key(v,p),B(v.iv));d.setAuthTag(B(v.tag));return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(B(v.ciphertext)),d.final()])).toString('utf8'))}
function encrypt(data,p){const iv=crypto.randomBytes(12),salt=crypto.randomBytes(16),iterations=600000,k=crypto.pbkdf2Sync(p,salt,iterations,32,'sha256'),c=crypto.createCipheriv('aes-256-gcm',k,iv),plain=zlib.gzipSync(Buffer.from(JSON.stringify(data))),cipher=Buffer.concat([c.update(plain),c.final()]);return{version:1,algorithm:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations,salt:b64(salt),iv:b64(iv),tag:b64(c.getAuthTag()),ciphertext:b64(cipher)}}
function dec(s){return String(s||'').replace(/&amp;/g,'&').replace(/&apos;/g,"'").replace(/&quot;/g,'"').replace(/&#4;\s*/g,'').trim()}
function tag(b,n){const m=b.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${n}>`,'i'));return dec(m?m[1]:'')}
function parse(xml){return[...xml.matchAll(/<VOUCHER(?:\s[^>]*)?>([\s\S]*?)<\/VOUCHER>/gi)].map(m=>{const b=m[1],raw=tag(b,'DATE'),entries=[...b.matchAll(/<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/gi)].map(e=>({name:tag(e[1],'LEDGERNAME'),amount:Number(tag(e[1],'AMOUNT')||0)}));return{guid:tag(b,'GUID'),masterId:Number(tag(b,'MASTERID')||0),date:raw.replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3'),type:tag(b,'VOUCHERTYPENAME'),number:tag(b,'VOUCHERNUMBER'),narration:tag(b,'NARRATION'),entries}})}
function fp(v){return JSON.stringify([v.date,norm(v.type),String(v.number||''),norm(v.narration),(v.entries||[]).map(e=>[norm(e.name||e.accountName),cents(e.amount)]).sort((a,b)=>a[0].localeCompare(b[0]))])}
function fpNoNumber(v){return JSON.stringify([v.date,norm(v.type),norm(v.narration),(v.entries||[]).map(e=>[norm(e.name||e.accountName),cents(e.amount)]).sort((a,b)=>a[0].localeCompare(b[0]))])}
function post(xml){return new Promise((resolve,reject)=>{const q=http.request({host:'127.0.0.1',port:Number(process.env.PL_TALLY_PORT||(book==='india'?9000:9001)),method:'POST',headers:{'Content-Type':'text/xml; charset=utf-8','Content-Length':Buffer.byteLength(xml)}},r=>{const a=[];r.on('data',x=>a.push(x));r.on('end',()=>resolve(Buffer.concat(a).toString('utf8')))});q.setTimeout(90000,()=>q.destroy(Error('Tally timed out')));q.on('error',reject);q.end(xml)})}
function requestXml(){return`<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PL Number Repair</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVFROMDATE TYPE="Date">${startTally}</SVFROMDATE><SVTODATE TYPE="Date">${endTally}</SVTODATE></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="PL Number Repair" ISMODIFY="No"><TYPE>Voucher</TYPE><FETCH>GUID,MasterID,Date,VoucherTypeName,VoucherNumber,Narration,AllLedgerEntries.*</FETCH><FILTER>PLNumberRepairDate</FILTER></COLLECTION><SYSTEM TYPE="Formulae" NAME="PLNumberRepairDate">$Date &gt;= $$Date:"${startTally}" AND $Date &lt;= $$Date:"${endTally}"</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`}
async function load(auth,pw){const url=site+'/api/vault'+(book==='india'?'?book=india':'');const r=await fetch(url,{headers:{Authorization:auth}});if(!r.ok)throw Error('Cloud HTTP '+r.status);const raw=await r.text();return{url,raw,etag:'"'+crypto.createHash('sha256').update(raw).digest('hex')+'"',vault:decrypt(JSON.parse(raw),pw)}}
function typeKey(v){return norm(v.type)}
function numericNumber(v){const n=Number(v.number);return Number.isFinite(n)&&n>0?Math.trunc(n):0}
(async()=>{try{
  const sp=process.env.PL_SITE_PASSWORD||'',vp=process.env.PL_VAULT_PASSWORD||'';
  if(!sp||!vp)throw Error('Passwords were not supplied');
  const auth='Basic '+Buffer.from('number-repair:'+sp).toString('base64'),state=await load(auth,vp),tally=parse(await post(requestXml()));
  const tallyByGuid=new Map(tally.map(t=>[norm(t.guid),t]).filter(x=>x[0])),tallyByNoNumber=new Map(),tallyMaxByType=new Map();
  for(const t of tally){const no=fpNoNumber(t);if(!tallyByNoNumber.has(no))tallyByNoNumber.set(no,[]);tallyByNoNumber.get(no).push(t);const k=typeKey(t),n=numericNumber(t);if(n)tallyMaxByType.set(k,Math.max(tallyMaxByType.get(k)||0,n))}
  let changed=false,linkedFixed=0,contentLinked=0,pendingFixed=0;
  const period=state.vault.transactions.filter(t=>t.date>=start&&t.date<=end&&!t.deleted);
  const matchedCloud=new Set();
  const cloudKey=c=>String(c.guid||c.id||`${c.date}|${c.type}|${c.number}|${c.narration}`);
  for(const c of period){
    const ck=cloudKey(c);
    let t=tallyByGuid.get(norm(c.tallyGuid||c.guid)),matchedByGuid=!!t;
    if(!t){const matches=tallyByNoNumber.get(fpNoNumber(c))||[];if(matches.length===1){t=matches[0];matchedByGuid=false}}
    if(!t)continue;
    matchedCloud.add(ck);
    if(t.guid&&!norm(c.tallyGuid||c.guid)){c.tallyGuid=t.guid;changed=true;contentLinked++}
    if(String(c.number||'')!==String(t.number||'')){
      c.number=String(t.number||'');
      changed=true;linkedFixed++;
    }
    if(fp(c)===fp(t)||(!matchedByGuid&&fpNoNumber(c)===fpNoNumber(t)&&String(c.number||'')===String(t.number||''))){
      c.syncFingerprint=fp(t);
      c.syncStatus='synced';
      c.lastSyncedAt=new Date().toISOString();
    }
  }
  const linkedIds=new Set([...tallyByGuid.keys()]);
  const appOnly=period.filter(c=>!matchedCloud.has(cloudKey(c))&&!linkedIds.has(norm(c.tallyGuid||c.guid))).sort((a,b)=>String(a.date).localeCompare(String(b.date))||(Number(a.id)||0)-(Number(b.id)||0));
  const usedByType=new Map();
  for(const [k,max] of tallyMaxByType)usedByType.set(k,max);
  for(const c of appOnly){
    const k=typeKey(c),next=(usedByType.get(k)||0)+1;
    if(String(c.number||'')!==String(next)){c.number=String(next);c.syncStatus='pending';changed=true;pendingFixed++}
    usedByType.set(k,next);
  }
  if(!changed){console.log(`NUMBER_REPAIR: ${book.toUpperCase()} no voucher numbering changes needed.`);return}
  const backup=path.join(__dirname,`encrypted-${book}-vault-before-number-repair-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  fs.writeFileSync(backup,state.raw);
  const body=JSON.stringify(encrypt(state.vault,vp)),put=await fetch(state.url,{method:'PUT',headers:{Authorization:auth,'Content-Type':'application/json','If-Match':state.etag},body});
  if(!put.ok)throw Error('Cloud number repair update failed HTTP '+put.status+' '+await put.text());
  console.log(`NUMBER_REPAIR: ${book.toUpperCase()} fixed ${linkedFixed} linked voucher number(s), repaired ${contentLinked} content link(s), renumbered ${pendingFixed} pending App voucher(s).`);
  console.log('Encrypted backup: '+backup);
}catch(e){console.error('ERROR:',e.message);process.exitCode=1}})();
