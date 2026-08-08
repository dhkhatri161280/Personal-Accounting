process.on('uncaughtException',error=>{console.log('COORDINATOR ERROR: '+error.message);process.exit(1)});
process.on('unhandledRejection',error=>{console.log('COORDINATOR ERROR: '+error.message);process.exit(1)});
import {spawn} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const book=String(process.argv[2]||'').toLowerCase();
if(!['us','india'].includes(book))throw Error('Book must be us or india');
const root=path.dirname(fileURLToPath(import.meta.url));
const runner=path.join(root,'dual-port-engine-runner.js');
const resolveScript=path.join(root,'resolve-number-conflicts.mjs');

function retain(pattern,keep){try{const files=fs.readdirSync(root).filter(name=>pattern.test(name)).map(name=>({name,time:fs.statSync(path.join(root,name)).mtimeMs})).sort((a,b)=>b.time-a.time);for(const file of files.slice(keep))fs.unlinkSync(path.join(root,file.name))}catch(error){console.log('RETENTION WARNING: '+error.message)}}
retain(new RegExp(`^tally-${book}-one-app-edit-response-.*\\.xml$`,'i'),5);
retain(new RegExp(`^encrypted-${book}-vault-before-.*\\.json$`,'i'),8);

function run(mode,extra={}){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[runner,mode,book],{env:{...process.env,...extra},windowsHide:true});let out='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>out+=x);p.on('error',reject);p.on('close',code=>code===0?resolve(out):reject(Error(`${mode} failed (${code}): ${out.trim()}`)))})}
function runScript(scriptPath,args=[],extra={}){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[scriptPath,...args],{env:{...process.env,...extra},windowsHide:true});let out='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>out+=x);p.on('error',reject);p.on('close',code=>code===0?resolve(out):reject(Error(`${path.basename(scriptPath)} failed (${code}): ${out.trim()}`)))})}
function plan(text){const count=label=>{const m=text.match(new RegExp('(\\d+)\\s+'+label,'i'));if(!m)throw Error('Unable to parse '+label+' from fresh reconciliation plan');return Number(m[1])};return{matched:count('matched'),tally:count('Tally-to-App'),app:count('App-to-Tally'),conflicts:count('conflicts')}}
function confirmation(text,direction){const label=direction==='tally-to-app'?'TALLY(?: EDIT)? -> APP':'APP(?: EDIT| DELETE)? -> TALLY';const r=new RegExp(label+':\\s*\\d{4}-\\d{2}-\\d{2}\\s*\\|\\s*([^|]+?)\\s+(\\S+)\\s*\\|','i');const m=text.match(r);if(!m)throw Error('Could not identify the single '+direction+' voucher');return 'APPLY '+book.toUpperCase()+' '+m[1].trim().toUpperCase()+' '+m[2].trim()}

// parseConflictPairs: compares entry lines (amounts) in addition to date/type/narration
// — only flags as number-only when ALL content matches and ONLY the voucher number differs
function parseConflictPairs(text){
  const pairs=[],lines=text.split('\n');
  const tRe=/CONFLICT\s*[-–]+\s*TALLY VERSION:\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(.+?)\s+(\S+)\s*\|\s*(.+)/i;
  const aRe=/CONFLICT\s*[-–]+\s*APP VERSION:\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(.+?)\s+(\S+)\s*\|\s*(.+)/i;
  function entries(start){const e=[];for(let k=start;k<lines.length;k++){if(!/^\s+\S/.test(lines[k]))break;e.push(lines[k].trim().toLowerCase());}return e.sort().join('\n');}
  for(let i=0;i<lines.length;i++){
    const tm=lines[i].match(tRe);if(!tm)continue;
    const tEntries=entries(i+1);
    for(let j=i+1;j<Math.min(i+10,lines.length);j++){
      const am=lines[j].match(aRe);if(!am)continue;
      const aEntries=entries(j+1);
      const[,tD,tT,tN,tNar]=tm,[,aD,aT,aN,aNar]=am;
      if(tD===aD&&tT.trim().toLowerCase()===aT.trim().toLowerCase()&&tNar.trim()===aNar.trim()&&tN!==aN&&tEntries===aEntries)
        pairs.push({date:aD,type:aT.trim(),appNumber:aN,tallyNumber:tN,narration:aNar.trim()});
      else if(tD===aD&&tN!==aN&&tEntries!==aEntries)
        console.log(`CONTENT CONFLICT (not auto-resolvable): ${tD} | ${tT.trim()} | ${tNar.trim()} — amounts differ between App and Tally`);
      break;
    }
  }
  return pairs;
}

let master='';try{master=await run('master-sync');console.log(master.trim())}catch(error){console.log('MASTER STAGE WARNING: '+error.message)}
if(/MASTER_(?:ACTION_APPLIED|BASELINE_INITIALIZED)/.test(master)){console.log('Master stage completed; voucher stage deferred to the next cycle');process.exit(0)}

let preview=await run('preview');console.log(preview.trim());
let p=plan(preview);

if(p.conflicts){
  const fixable=parseConflictPairs(preview);
  if(fixable.length===0||!fs.existsSync(resolveScript)){
    throw Error(`Safety stop: ${p.conflicts} conflict(s) detected — manual review required`);
  }
  console.log(`${fixable.length} number-only conflict(s) detected — auto-resolving...`);
  try{
    const resolveOut=await runScript(resolveScript,[book],{PL_CONFLICT_PAIRS:JSON.stringify(fixable)});
    console.log(resolveOut.trim());
    preview=await run('preview');console.log(preview.trim());
    p=plan(preview);
  }catch(resolveErr){
    throw Error(`Safety stop: auto-resolution failed — ${resolveErr.message}`);
  }
  if(p.conflicts){throw Error(`Safety stop: ${p.conflicts} unresolvable conflict(s) remain — manual review required`);}
  console.log('All conflicts resolved; continuing sync cycle.');
}

const actions=p.tally+p.app;
if(actions===0){console.log('Already synchronized');process.exit(0)}
const identityRepair=p.tally===1&&p.app>=1;
const hasBacklog=p.tally>0&&p.app>0&&!identityRepair;
if(actions!==1&&!identityRepair&&!(p.tally===0&&p.app>1)&&!hasBacklog&&!(p.tally>1&&p.app===0))throw Error(`Safety stop: cycle contains ${actions} incompatible changes`);
const direction=(identityRepair||hasBacklog)?'app-to-tally':p.tally>0?'tally-to-app':'app-to-tally';
const confirm=confirmation(preview,direction);
console.log(`Applying one atomic ${direction} operation`);
console.log((await run(direction,{PL_APPLY_CONFIRM:confirm})).trim());
const after=await run('preview');console.log(after.trim());const final=plan(after);

// post-apply safety: conflicts must be gone; tally-to-app must show progress; app-to-tally must not grow Tally queue
if(final.conflicts)throw Error('Post-write reconciliation has unsafe exceptions: conflicts remain');
if(direction==='tally-to-app'&&final.tally>=p.tally)throw Error('Post-write reconciliation has unsafe exceptions: Tally queue did not reduce after tally-to-app apply');
if(direction==='app-to-tally'&&final.tally>p.tally)throw Error('Post-write reconciliation has unsafe exceptions: Tally queue grew unexpectedly during app-to-tally apply');

const remaining=[final.tally?final.tally+' Tally':null,final.app?final.app+' App':null].filter(Boolean);
console.log(remaining.length?('Post-write reconciliation clean; '+remaining.join(', ')+' voucher(s) remain queued'):'Post-write reconciliation clean');
