import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';

test('ADM-only WhatsApp attestations bind actor, source, terms, proposal revision and both clubs; member release disables them', {skip:!process.env.MLG_TEST_DATABASE_URL}, async()=>{
 const url=process.env.MLG_TEST_DATABASE_URL!;
 const admin=new Pool({connectionString:url});
 const name='mlg_attestation_test_'+randomUUID().replaceAll('-','');
 await admin.query('create database '+name);
 const target=new URL(url);target.pathname='/'+name;
 const db=new Pool({connectionString:target.toString()});
 try{
  await db.query(await readFile(new URL('./fixtures/mlg-adm-only-attestation.sql',import.meta.url),'utf8'));
  const actor=randomUUID(),other=randomUUID(),source=randomUUID(),inbox=randomUUID(),seller=randomUUID();
  await db.query('insert into public.admin_users values($1)',[actor]);
  await db.query('insert into public.platform_member_access values(true,false)');
  await db.query("insert into private.test_snapshots values('negotiation',$1,'hash-original')",[source]);
  await db.query("insert into public.whatsapp_market_inbox values($1,7,'awaiting_signatures',$2,$3,null)",[inbox,seller,source]);
  await db.query("insert into private.whatsapp_market_adm_attestations values($1,7,'negotiation',$2,'hash-original',$3,true,true)",[inbox,source,actor]);
  const valid=async(who:string|null=actor)=>(await db.query('select private.whatsapp_market_adm_attestation_valid($1,$2,$3) as valid',['negotiation',source,who])).rows[0].valid;
  assert.equal(await valid(),true,'no member account or member signature is required');
  assert.equal(await valid(null),false);assert.equal(await valid(other),false);
  await db.query('insert into public.admin_users values($1)',[other]);assert.equal(await valid(other),false,'another ADM cannot reuse the attestation');
  await db.query('update public.platform_member_access set members_released=true');assert.equal(await valid(),false);
  await db.query('update public.platform_member_access set members_released=false');assert.equal(await valid(),true);
  await db.query("update private.test_snapshots set terms_hash='changed-terms'");assert.equal(await valid(),false);
  await db.query("update private.test_snapshots set terms_hash='hash-original'");
  await db.query('update public.whatsapp_market_inbox set revision=8');assert.equal(await valid(),false);
  await db.query('update public.whatsapp_market_inbox set revision=7');
  await db.query('update private.whatsapp_market_adm_attestations set seller_confirmed=false');assert.equal(await valid(),false);
  await db.query('update public.whatsapp_market_inbox set from_club_id=null');assert.equal(await valid(),true,'external purchases require only the buying club consent');
  await db.query('update private.whatsapp_market_adm_attestations set buyer_confirmed=false');assert.equal(await valid(),false);
  await db.query("update public.whatsapp_market_inbox set status='rejected'");assert.equal(await valid(),false);
 }finally{await db.end();await admin.query('drop database '+name);await admin.end();}
});
