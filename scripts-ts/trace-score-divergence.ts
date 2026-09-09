// READ-ONLY. Three different values for one score: stage record 4/7/6/2, company 4/6/6/2,
// email 7/9/4/2. Find every write and put them in order.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
try{ for(const l of readFileSync(join(process.cwd(),'.env.local'),'utf8').split('\n')){
  const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^["']|["']$/g,''); } }catch{}
if(!process.env.GHL_TARGET) process.env.GHL_TARGET='live';
(async()=>{
  const c=ghl();
  const { enumerateAllContacts } = await import('../lib/ghl/contacts');
  const all:any[]=await enumerateAllContacts(c);
  const aiden=all.filter(x=>/aiden/i.test(`${x.firstName??''} ${x.lastName??''} ${x.email??''}`));
  console.log(`Aiden contacts: ${aiden.length}`);
  for(const ct of aiden) console.log(`   ${ct.id}  ${ct.firstName} ${ct.lastName} <${ct.email}>  businessId=${ct.businessId??'NONE'}`);
  const co=aiden.find(x=>x.businessId)?.businessId;
  if(!co){ console.log('no company — stop'); return; }
  const b:any=await c.request({path:`/businesses/${co}`});
  console.log(`\ncompany ${co} = ${JSON.stringify((b.business??b).name)}`);

  const { readRecordFields } = await import('../lib/ghl/records');
  const bf=await readRecordFields('business',co,c);
  console.log('COMPANY current values:');
  for(const k of ['trl_current','mrl_current','crl_current','churchill_current','churchill_substage_current']) console.log(`   ${k.padEnd(28)} ${JSON.stringify(bf.get(k)??null)}`);

  const cf=await readRecordFields('contact',aiden.find(x=>x.businessId)!.id,c);
  console.log('CONTACT current values (what an email merging contact.* would see):');
  for(const k of ['trl_current','mrl_current','crl_current','churchill_current']) console.log(`   ${k.padEnd(28)} ${JSON.stringify(cf.get(k)??null)}`);

  // stage records for this company
  const { getRelatedRecordIds } = await import('../lib/ghl/associations');
  const recs:any[]=[];
  for(let page=1;page<=60;page+=1){
    const d:any=await c.request({method:'POST',path:'/objects/custom_objects.business_stage/records/search',autoLocation:false,
      body:{locationId:c.locationId,query:'',page,pageLimit:100,searchAfter:[],sort:[{field:'updatedAt',direction:'desc'}]}});
    const r=d.records??d.items??[]; recs.push(...r); if(r.length<100)break;
  }
  console.log('\nSTAGE RECORDS for this company:');
  for(const r of recs){
    const ids=await getRelatedRecordIds(r.id,'business',c).catch(()=>[] as string[]);
    if(!ids.includes(co)) { await new Promise(x=>setTimeout(x,50)); continue; }
    const p=r.properties??{};
    console.log(`   ${r.id}`);
    console.log(`      created ${r.createdAt}   updated ${r.updatedAt}`);
    console.log(`      trl=${p.trl} mrl=${p.mrl} crl=${p.crl} churchill=${p.churchill_score} substage=${JSON.stringify(p.churchill_substage)}`);
    await new Promise(x=>setTimeout(x,50));
  }

  console.log('\n── EVERY score-related write today, in order ──');
  const { queryChangeLog } = await import('../lib/audit/query');
  const { rows } = await queryChangeLog({ since: '2026-09-09T00:00:00Z', limit: 300 });
  for(const r of [...rows].reverse()){
    const an=String(r.actorName);
    if(!/scor|stage|contact-to-company|company-to-contacts|enricher/i.test(an)) continue;
    const ch=((r.changes as any[])??[]).map((x:any)=>`${String(x.field).replace(/^(business|contact|custom_objects\.business_stage)\./,'')}=${JSON.stringify(x.to)}`).join(' ');
    console.log(`   ${String(r.ts).slice(4,24)}  ${an.padEnd(24)} ${String(r.recordLabel??r.recordId).slice(0,24).padEnd(24)} ${ch.slice(0,110)}`);
  }
})().catch(e=>{console.error(e);process.exit(1);});
