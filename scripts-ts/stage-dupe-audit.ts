// READ-ONLY. Zach, 2026-09-04: "In the Client Stage Tracking object I am seeing lots of duplicates
// and then nobody has been scored since 8/27." This counts the duplicates and says how they arose.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
function env(){ try {
  const t=readFileSync(join(process.cwd(),'.env.local'),'utf8');
  for(const l of t.split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}
} catch { /* CI */ } }
async function main(){
  env(); process.env.GHL_TARGET='live';
  const c=ghl();
  const { STAGE_OBJECT } = await import('../lib/stage/priorAssessment');
  const { getRelatedRecordIds } = await import('../lib/ghl/associations');
  const recs:any[]=[];
  for(let page=1;page<=60;page+=1){
    const d:any=await c.request({method:'POST',path:`/objects/${STAGE_OBJECT}/records/search`,autoLocation:false,
      body:{locationId:c.locationId,query:'',page,pageLimit:100,searchAfter:[],sort:[{field:'updatedAt',direction:'desc'}]}});
    const r=d.records??d.items??[]; recs.push(...r); if(r.length<100)break;
  }
  console.log(`${STAGE_OBJECT}: ${recs.length} record(s)\n`);
  if(recs.length){
    console.log('property keys on the newest record:');
    console.log('  ', Object.keys(recs[0].properties ?? {}).join(', '));
    console.log('\nnewest 3:');
    for(const r of recs.slice(0,3)) console.log('  ', JSON.stringify(r.properties).slice(0,260));
  }
  // Group by company via the association.
  const byCompany=new Map<string,any[]>();
  let orphan=0;
  for(const r of recs){
    const ids=await getRelatedRecordIds(r.id,'business',c).catch(()=>[] as string[]);
    if(!ids.length){ orphan++; continue; }
    for(const id of ids){ const a=byCompany.get(id)??[]; a.push(r); byCompany.set(id,a); }
    await new Promise((x)=>setTimeout(x,105));
  }
  const multi=Array.from(byCompany.entries()).filter(([,v])=>v.length>1);
  console.log(`\ncompanies with a stage record: ${byCompany.size}`);
  console.log(`records not associated to any company: ${orphan}`);
  console.log(`companies with MORE THAN ONE: ${multi.length}`);
  const hist:Record<number,number>={};
  for(const v of Array.from(byCompany.values())) hist[v.length]=(hist[v.length]??0)+1;
  console.log('records per company:');
  for(const [k,v] of Object.entries(hist).sort((a,b)=>Number(a[0])-Number(b[0]))) console.log(`   ${String(v).padStart(4)} company(ies) with ${k} record(s)`);
  // ── SAME-DAY duplicates are the bug; different-day records are DESIGNED history ────────────────
  // writeStageRecord.ts appends a record per scoring EVENT on purpose, so several records for one
  // company is normal. What is not normal is two records for one company on ONE day: the scorer holds
  // `todayRecordId` precisely so a same-day re-score OVERWRITES instead of appending.
  let sameDayGroups=0, redundant=0;
  const offenders:Array<{cid:string;name:string;day:string;ids:string[]}>=[];
  for(const [cid,v] of Array.from(byCompany.entries())){
    const byDay=new Map<string,any[]>();
    for(const r of v){
      const d=String((r.properties??{}).rescore_date ?? '').slice(0,10) || String(r.createdAt??'').slice(0,10);
      const a=byDay.get(d)??[]; a.push(r); byDay.set(d,a);
    }
    for(const [day,rs] of Array.from(byDay.entries())){
      if(rs.length<2) continue;
      sameDayGroups++; redundant += rs.length-1;
      offenders.push({cid,name:String((rs[0].properties??{}).name??'').split('—')[0].trim(),day,ids:rs.map((r:any)=>r.id)});
    }
  }
  console.log(`\n── SAME-DAY DUPLICATES (the bug) ──`);
  console.log(`   company+day pairs holding more than one record: ${sameDayGroups}`);
  console.log(`   redundant records (keep newest per pair, delete the rest): ${redundant} of ${recs.length}`);
  for(const o of offenders.sort((a,b)=>b.ids.length-a.ids.length).slice(0,25)){
    console.log(`   ${o.day}  ${o.name.slice(0,34).padEnd(34)} ${o.ids.length} records  ${o.ids.map((i)=>i.slice(0,8)).join(' ')}`);
  }
  const legitimate = Array.from(byCompany.values()).filter((v)=>v.length>1).length - new Set(offenders.map((o)=>o.cid)).size;
  console.log(`\n   companies whose multiple records are all on DIFFERENT days (designed history, leave alone): ${legitimate}`);

  console.log('\nworst offenders (all records per company, incl. legitimate history):');
  for(const [cid,v] of multi.sort((a,b)=>b[1].length-a[1].length).slice(0,8)){
    console.log(`   company ${cid}: ${v.length} records`);
    for(const r of v.slice(0,6)){
      const p=r.properties??{};
      console.log(`      ${String(r.id).slice(0,10)}  created=${String(r.createdAt??p.createdAt??'?').slice(0,10)}  ${JSON.stringify(p).slice(0,120)}`);
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
