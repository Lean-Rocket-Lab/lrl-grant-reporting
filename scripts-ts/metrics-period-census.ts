// READ-ONLY. What do the live metrics activities actually hold — period, name, source key — before
// the Apr–Sep / Oct–Mar boundary correction? Measures the migration rather than assuming it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
function env(){
  try {
    const t = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const l of t.split('\n')) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
async function main(){
  env(); process.env.GHL_TARGET='live';
  const c=ghl();
  const acts:any[]=[];
  for(let page=1;page<=40;page+=1){
    const d:any=await c.request({method:'POST',path:'/objects/custom_objects.activities/records/search',autoLocation:false,
      body:{locationId:c.locationId,query:'',page,pageLimit:100,searchAfter:[],sort:[{field:'updatedAt',direction:'desc'}]}});
    const r=d.records??d.items??[]; acts.push(...r); if(r.length<100)break;
  }
  const m=acts.filter((a:any)=>String(a.properties?.activity_type)==='metrics');
  console.log(`total activities ${acts.length}   metrics ${m.length}\n`);

  const byPeriod=new Map<string,any[]>();
  for(const a of m){const p=String(a.properties?.reporting_period??'').slice(0,10);
    const x=byPeriod.get(p)??[];x.push(a);byPeriod.set(p,x);}
  console.log('reporting_period                 n   activity_date matches   names with a company');
  for(const [p,rows] of Array.from(byPeriod.entries()).sort()){
    const dateMatch=rows.filter((a:any)=>String(a.properties?.activity_date??'').slice(0,10)===p).length;
    // A name "carries the company" only if it has more than the two segments `Metrics – <label>`.
    const named=rows.filter((a:any)=>String(a.properties?.activity_name??'').split(' – ').length>2).length;
    console.log(`   ${p||'(blank)'}   ${String(rows.length).padStart(3)}          ${String(dateMatch).padStart(3)}/${rows.length}              ${String(named).padStart(3)}/${rows.length}`);
  }

  console.log('\nsample names:');
  for(const a of m.slice(0,6)) console.log(`   ${String(a.properties?.activity_name??'(none)')}`);

  const srcs=new Map<string,number>();
  for(const a of m){const s=`${a.properties?.activity_source??'?'}`;srcs.set(s,(srcs.get(s)??0)+1);}
  console.log('\nsource:', Array.from(srcs.entries()).map(([k,v])=>`${k}=${v}`).join('  '));
  console.log('sample source_record_id:');
  for(const a of m.slice(0,4)) console.log(`   ${a.properties?.source_record_id??'(none)'}`);

  // Do the Postgres claims agree with the records?
  const { getDb }=await import('../lib/db/index');
  const { activitySourceClaims }=await import('../lib/db/schema');
  const rows=await getDb().select().from(activitySourceClaims);
  const metricsClaims=rows.filter((r:any)=>/:\d{4}-\d{2}-\d{2}$/.test(r.sourceRecordId));
  console.log(`\nclaims total ${rows.length}   period-shaped (\`<id>:<YYYY-MM-DD>\`) ${metricsClaims.length}`);
  const claimEnds=new Map<string,number>();
  for(const r of metricsClaims){const e=r.sourceRecordId.split(':').pop()!;claimEnds.set(e,(claimEnds.get(e)??0)+1);}
  for(const [e,n] of Array.from(claimEnds.entries()).sort()) console.log(`   ${e}  ${n}`);
}
main().catch((e)=>{console.error(e);process.exit(1);});
