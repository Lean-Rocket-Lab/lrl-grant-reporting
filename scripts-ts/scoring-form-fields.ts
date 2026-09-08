// READ-ONLY. The fields a GHL FORM must collect so the Client Stage scorer can run.
//
// The scorer is COMPANY-scoped, but a form writes to the CONTACT. The contact→company up-sync
// carries the answers up, so what a form needs is each scoring input's CONTACT counterpart —
// resolved here from the live field mappings rather than assumed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
function env(){ try {
  const t=readFileSync(join(process.cwd(),'.env.local'),'utf8');
  for(const l of t.split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}
} catch {} }
async function main(){
  env(); process.env.GHL_TARGET='live';
  const c=ghl();
  const { SCORING_INPUTS } = await import('../lib/stage/companyInputs');
  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const [bizCat, conCat]: any[] = await Promise.all([getCatalog('business',{client:c}), getCatalog('contact',{client:c})]);

  // The live contact→company pairs, from config/field-mappings.json (the shipped mapping set the
  // up-sync actually uses). Keys appear both bare and prefixed in that file, so normalise both.
  const pairs = new Map<string,string>(); // businessBare -> contactBare
  {
    const cfg = JSON.parse(readFileSync(join(process.cwd(),'config/field-mappings.json'),'utf8'));
    const rows: any[] = Array.isArray(cfg) ? cfg : (cfg.mappings ?? cfg.rows ?? []);
    for (const r of rows) {
      const b = String(r.businessKey ?? '').replace(/^business\./,'');
      const ct = String(r.contactKey ?? '').replace(/^contact\./,'');
      if (b && ct) pairs.set(b, ct);
    }
  }
  console.log(`resolved ${pairs.size} contact↔company field pair(s)\n`);

  const label=(bare:string)=>String(conCat.byKey[`contact.${bare}`]?.name ?? '');
  const dtype=(bare:string)=>String(conCat.byKey[`contact.${bare}`]?.dataType ?? '—');

  // The ROUTER first — not a scoring input, but nothing scores without it.
  console.log('═══ THE ROUTER — collect this or the company is never scored ═══');
  for(const b of ['business_model']){
    const ct=pairs.get(b) ?? b;
    const exists=Boolean(conCat.byKey[`contact.${ct}`]);
    console.log(`   contact.${ct}`);
    console.log(`      label     ${label(ct) || '(no contact field!)'}`);
    console.log(`      type      ${dtype(ct)}   exists on contact: ${exists}`);
    const opts=(bizCat.byKey[`business.${b}`]?.options??[]).map((o:any)=>o.label??o.key??o);
    console.log(`      options   ${opts.join(' | ')}`);
  }

  const byDim: Record<string,string[]> = { trl:[], mrl:[], crl:[], churchill:[] };
  console.log('\n═══ THE 18 SCORING INPUTS ═══');
  let missing=0;
  for(const i of SCORING_INPUTS){
    const b=i.businessKey.replace(/^business\./,'');
    const ct=pairs.get(b) ?? b;
    const exists=Boolean(conCat.byKey[`contact.${ct}`]);
    if(!exists) missing++;
    for(const d of i.dims) byDim[d].push(i.label);
    console.log(`\n   ${i.label}${i.money?'  ($)':''}`);
    console.log(`      contact field  contact.${ct}${exists?'':'   ⚠️ NO CONTACT FIELD — a form cannot collect this'}`);
    console.log(`      company field  business.${b}`);
    console.log(`      feeds          ${i.dims.join(', ').toUpperCase()}`);
    console.log(`      type           ${dtype(ct)}`);
    const opts=(conCat.byKey[`contact.${ct}`]?.options??[]).map((o:any)=>o.label??o.key??o);
    if(opts.length) console.log(`      options        ${opts.slice(0,8).join(' | ')}${opts.length>8?` … (${opts.length})`:''}`);
  }
  console.log('\n═══ BY DIMENSION — what each score needs ═══');
  for(const [d,list] of Object.entries(byDim)) console.log(`   ${d.toUpperCase().padEnd(9)} ${list.length} input(s): ${list.join('; ')}`);
  console.log(`\ninputs with no contact counterpart: ${missing}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
