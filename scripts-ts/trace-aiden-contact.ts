// READ-ONLY. Zach's hypothesis: the form matched an EXISTING contact by phone, overwrote it, and the
// businessId of that old contact (Lean Rocket Lab) came along for the ride.
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
  const d:any=await c.request({path:'/contacts/DuQPmo91pc0Gqrrs6avU'});
  const ct=d.contact??d;
  console.log('=== AIDEN\'S CONTACT ===');
  for(const k of ['id','firstName','lastName','email','phone','companyName','businessId','dateAdded','dateUpdated','source','type']){
    if(ct[k]!=null&&ct[k]!=='') console.log(`   ${k.padEnd(12)} ${JSON.stringify(ct[k])}`);
  }
  console.log('\n=== does that phone collide with any other contact? ===');
  const { enumerateAllContacts } = await import('../lib/ghl/contacts');
  const all=await enumerateAllContacts(c);
  const norm=(p:unknown)=>String(p??'').replace(/\D/g,'').slice(-10);
  const mine=norm(ct.phone);
  if(!mine) console.log('   (no phone on the contact)');
  else {
    const same=(all as any[]).filter((x)=>norm(x.phone)===mine);
    console.log(`   phone ${mine} appears on ${same.length} contact(s):`);
    for(const x of same) console.log(`      ${x.id}  ${String(x.firstName??'')} ${String(x.lastName??'')}  <${x.email??''}>  businessId=${x.businessId??'none'}  added=${String(x.dateAdded??'').slice(0,19)}`);
  }
  console.log('\n=== dateAdded of Aiden vs the LRL company record ===');
  console.log(`   contact added   ${String(ct.dateAdded??'?').slice(0,19)}`);
  console.log(`   contact updated ${String(ct.dateUpdated??'?').slice(0,19)}`);
  console.log(`   company created 2026-07-07T19:45:18  (Lean Rocket Lab)`);
  console.log(`   company updated 2026-09-08T19:13:55  (renamed to Aidens Consulting Company)`);
}
main().catch(e=>{console.error(e);process.exit(1);});
