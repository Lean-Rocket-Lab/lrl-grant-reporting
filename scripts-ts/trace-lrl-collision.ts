// READ-ONLY. URGENT: Aiden's contact points at businessId 6a4d574e64db0a03eb278f62, whose stage
// records are all named "Lean Rocket Lab" — but the business now reads "Aidens Consulting Company".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
function env(){ try {
  const t=readFileSync(join(process.cwd(),'.env.local'),'utf8');
  for(const l of t.split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}
} catch {} }
const SUSPECT='6a4d574e64db0a03eb278f62';
async function main(){
  env(); process.env.GHL_TARGET='live';
  const c=ghl();
  const d:any=await c.request({path:`/businesses/${SUSPECT}`});
  const b=d.business??d;
  console.log('=== THE COMPANY RECORD ===');
  for(const k of ['id','name','email','phone','website','address','city','state','postalCode','country','updatedAt','createdAt']){
    if(b[k]!=null&&b[k]!=='') console.log(`   ${k.padEnd(12)} ${JSON.stringify(b[k])}`);
  }
  const { readRecordFields } = await import('../lib/ghl/records');
  const f=await readRecordFields('business', SUSPECT, c);
  console.log('\n=== geo / zone fields on it ===');
  for(const k of ['county','hubzone','opportunity_zone','is_hubzone','in_opportunity_zone','geo_disadvantaged','sedi','date_of_incorporation','naics_code','trl_current','mrl_current','crl_current','churchill_current']){
    const v=f.get(k); if(v!=null&&v!=='') console.log(`   ${k.padEnd(26)} ${JSON.stringify(v)}`);
  }
  console.log('\n=== is there ANOTHER Lean Rocket Lab company? ===');
  const biz:any[]=[]; let skip=0;
  for(;;){ const r:any=await c.request({path:'/businesses/',params:{limit:100,skip}});
    const arr=r.businesses??[]; if(!arr.length)break; biz.push(...arr); if(arr.length<100)break; skip+=100; }
  for(const x of biz.filter((y:any)=>/lean rocket|aiden/i.test(String(y.name??'')))){
    console.log(`   ${x.id}  ${JSON.stringify(x.name)}  ${[x.address,x.city,x.state,x.postalCode].filter(Boolean).join(', ')}`);
  }
  console.log('\n=== who touched this record? change log ===');
  const { queryChangeLog } = await import('../lib/audit/query');
  const { rows } = await queryChangeLog({ recordId: SUSPECT, limit: 40 });
  console.log(`   ${rows.length} change-log row(s)`);
  for(const r of rows.slice(0,18)){
    const ch=(r.changes as any[])??[];
    const summary=ch.map((x:any)=>`${String(x.field).replace('business.','')}: ${JSON.stringify(x.from)?.slice(0,28)} -> ${JSON.stringify(x.to)?.slice(0,34)}`).join(' | ');
    console.log(`   ${String(r.ts).slice(0,19)}  ${String(r.actorName).padEnd(24)} ${String(r.applied)}  ${summary.slice(0,170)}`);
  }
  console.log('\n=== contacts pointing at this company ===');
  const { enumerateAllContacts } = await import('../lib/ghl/contacts');
  const cts=await enumerateAllContacts(c);
  for(const ct of (cts as any[]).filter((x)=>x.businessId===SUSPECT)){
    console.log(`   ${String(ct.firstName??'')} ${String(ct.lastName??'')}  <${ct.email??''}>  claims=${JSON.stringify(ct.companyName??null)}`);
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
