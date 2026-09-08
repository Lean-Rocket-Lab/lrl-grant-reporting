// READ-ONLY. Zach: intake from Aiden — contact→company passed, company scored, data written, but NO
// Client Stage Tracking record created. Trace the whole chain for that company.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
function env(){ try {
  const t=readFileSync(join(process.cwd(),'.env.local'),'utf8');
  for(const l of t.split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}
} catch {} }
const NAME = process.argv[2] ?? 'aiden';
async function main(){
  env(); process.env.GHL_TARGET='live';
  const c=ghl();
  const { enumerateAllContacts } = await import('../lib/ghl/contacts');
  const contacts=await enumerateAllContacts(c);
  const hits=(contacts as any[]).filter((x)=>`${x.firstName??''} ${x.lastName??''} ${x.email??''} ${x.companyName??''}`.toLowerCase().includes(NAME.toLowerCase()));
  console.log(`contacts matching ${JSON.stringify(NAME)}: ${hits.length}`);
  for(const ct of hits){
    console.log(`\n── ${ct.firstName??''} ${ct.lastName??''}  <${ct.email??'no email'}>`);
    console.log(`   contactId=${ct.id}  businessId=${ct.businessId ?? 'NONE'}  companyName=${JSON.stringify(ct.companyName??null)}`);
    console.log(`   created=${String(ct.dateAdded??'').slice(0,19)}  updated=${String(ct.dateUpdated??'').slice(0,19)}`);
    if(!ct.businessId) { console.log('   → no company, so nothing to score'); continue; }
    let biz:any=null;
    try{ const d:any=await c.request({path:`/businesses/${ct.businessId}`}); biz=d.business??d; }catch(e:any){ console.log('   business fetch failed:',e?.message); }
    if(biz){
      console.log(`   company: ${biz.name}  id=${biz.id}`);
      // the scoring inputs + the *_current fields propagation writes
      const { SCORING_INPUT_KEYS } = await import('../lib/stage/companyInputs');
      const { readRecordFields } = await import('../lib/ghl/records');
      const f=await readRecordFields('business', biz.id, c).catch(()=>null);
      if(f){
        const present=SCORING_INPUT_KEYS.map((k)=>k.replace(/^business\./,'')).filter((k)=>{const v=f.get(k); return v!=null&&v!==''});
        console.log(`   scoring inputs present: ${present.length}/${SCORING_INPUT_KEYS.length}  ${present.slice(0,8).join(', ')}`);
        for(const k of ['trl_current','mrl_current','crl_current','churchill_current','business_model']){
          const v=f.get(k); if(v!=null&&v!=='') console.log(`      ${k} = ${JSON.stringify(v)}`);
        }
      }
      // does a stage record exist for it?
      const { STAGE_OBJECT } = await import('../lib/stage/priorAssessment');
      const { getRelatedRecordIds } = await import('../lib/ghl/associations');
      const recs:any[]=[];
      for(let page=1;page<=60;page+=1){
        const d:any=await c.request({method:'POST',path:`/objects/${STAGE_OBJECT}/records/search`,autoLocation:false,
          body:{locationId:c.locationId,query:'',page,pageLimit:100,searchAfter:[],sort:[{field:'updatedAt',direction:'desc'}]}});
        const r=d.records??d.items??[]; recs.push(...r); if(r.length<100)break;
      }
      let mine:any[]=[];
      for(const r of recs){
        const ids=await getRelatedRecordIds(r.id,'business',c).catch(()=>[] as string[]);
        if(ids.includes(biz.id)) mine.push(r);
        await new Promise((x)=>setTimeout(x,60));
      }
      console.log(`   STAGE RECORDS for this company: ${mine.length}`);
      for(const r of mine) console.log(`      ${r.id}  created=${String(r.createdAt??'').slice(0,19)}  ${JSON.stringify(r.properties).slice(0,140)}`);
    }
    // the enricher state — did the scorer decide "unchanged"?
    const { getEnricherState } = await import('../lib/enrichment/stateStore').catch(()=>({getEnricherState:null as any}));
    if(getEnricherState && ct.businessId){
      const st=await getEnricherState(ct.businessId).catch(()=>null);
      console.log(`   enricher state for company: ${JSON.stringify(st)}`);
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
