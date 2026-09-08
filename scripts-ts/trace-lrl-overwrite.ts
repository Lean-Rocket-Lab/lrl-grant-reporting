// READ-ONLY. Recover what Lean Rocket Lab's company record held BEFORE Aiden's intake overwrote it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
function env(){ try {
  const t=readFileSync(join(process.cwd(),'.env.local'),'utf8');
  for(const l of t.split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}
} catch {} }
const SUSPECT='6a4d574e64db0a03eb278f62';
const INTERESTING=/name|address|city|state|postal|website|phone|email|county|geo|hubzone|opportunity/i;
async function main(){
  env(); process.env.GHL_TARGET='live';
  const { queryChangeLog } = await import('../lib/audit/query');
  const { rows } = await queryChangeLog({ recordId: SUSPECT, limit: 400 });
  console.log(`${rows.length} change-log row(s) for the company\n`);
  console.log('=== every change to an IDENTITY or GEO field, newest first ===');
  let n=0;
  for(const r of rows){
    for(const ch of ((r.changes as any[])??[])){
      const field=String(ch.field).replace(/^business\./,'');
      if(!INTERESTING.test(field)) continue;
      n++;
      console.log(`${String(r.ts).slice(4,24)}  ${String(r.actorName).padEnd(22)} ${field.padEnd(20)}`);
      console.log(`      from ${JSON.stringify(ch.from)?.slice(0,90)}`);
      console.log(`      to   ${JSON.stringify(ch.to)?.slice(0,90)}`);
    }
  }
  if(!n) console.log('   (none — so the overwrite did NOT go through the change log)');
  console.log('\n=== all actors that ever wrote to this record ===');
  const by:Record<string,number>={};
  for(const r of rows) by[String(r.actorName)]=(by[String(r.actorName)]??0)+1;
  for(const [k,v] of Object.entries(by).sort((a,b)=>b[1]-a[1])) console.log(`   ${String(v).padStart(3)}  ${k}`);
  console.log('\n=== anything logged TODAY ===');
  for(const r of rows.filter((x)=>String(x.ts).includes('Sep 08 2026'))){
    const ch=((r.changes as any[])??[]).map((x:any)=>String(x.field).replace('business.','')).join(', ');
    console.log(`   ${String(r.ts).slice(4,24)}  ${r.actorName}  applied=${r.applied}  [${ch}]`);
    if(r.rationale) console.log(`      ${String(r.rationale).slice(0,140)}`);
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
