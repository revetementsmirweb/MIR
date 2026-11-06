'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {configuration}=require('../tools/validation/config.cjs');
test('Validation réelle bloquée si les comptes de test ne sont pas configurés',()=>{
 const c=configuration({});assert.equal(c.missing.length,7);assert.deepEqual(c.accounts,{});assert.equal(c.publicConfig.supabaseUrl,'https://gccltmaulvrnthrbnrpd.supabase.co');
 assert.ok(c.missing.includes('MIR_TEST_ADMIN_PASSWORD'));assert.ok(!JSON.stringify(c.missing).includes('sb_publishable_'));
});
test('Comptes distincts, organisation valide et serveur MIR imposés',()=>{
 const env={MIR_TEST_ORG_ID:'00000000-0000-4000-8000-000000000010'};
 for(const r of ['ADMIN','EMPLOYEE','CLIENT']){env['MIR_TEST_'+r+'_EMAIL']=r+'@example.invalid';env['MIR_TEST_'+r+'_PASSWORD']='fixture-only';}
 assert.equal(configuration(env).missing.length,0);
 assert.throws(()=>configuration({...env,MIR_TEST_ORG_ID:'invalid'}),/UUID/);
 assert.throws(()=>configuration({...env,MIR_TEST_CLIENT_EMAIL:env.MIR_TEST_ADMIN_EMAIL}),/distincts/);
 assert.equal(configuration({...env,MIR_TEST_SUPABASE_URL:'https://untrusted.invalid'}).publicConfig.supabaseUrl,'https://gccltmaulvrnthrbnrpd.supabase.co','credentials cannot be redirected by a URL override');
});
test('Audit SQL seulement en lecture : 19 tables RLS et 7 RPC authentifiées de la migration 004',async()=>{
 const {PGlite}=require('../tools/database/node_modules/@electric-sql/pglite'),db=new PGlite();
 try{
  await db.exec("create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;");
  const dir=path.join(__dirname,'../supabase/migrations');for(const f of fs.readdirSync(dir).sort().filter(f=>f<'202611060004'))await db.exec(fs.readFileSync(path.join(dir,f),'utf8'));
  const sql=fs.readFileSync(path.join(__dirname,'../supabase/verification/mission-4-read-only.sql'),'utf8');assert.match(sql,/BEGIN READ ONLY/);assert.doesNotMatch(sql,/set_config|SET ROLE|CREATE|INSERT|UPDATE|DELETE/i);
  const before=(await db.exec(sql)).find(r=>r.rows[0]?.audit).rows[0].audit;assert.equal(before.saleLengthColumn,false);assert.ok(before.tables.some(t=>!t.exists));assert.ok(before.routines.every(r=>!r.exists),'une 004 absente ne doit jamais être annoncée installée');
  await db.exec(fs.readFileSync(path.join(dir,'202611060004_connected_catalogue.sql'),'utf8'));
  const rows=await db.exec(sql),audit=rows.find(r=>r.rows[0]?.audit)?.rows[0].audit;assert.ok(audit);assert.equal(audit.tables.length,19);assert.ok(audit.tables.every(t=>t.exists&&t.rls));assert.equal(audit.routines.length,7);assert.ok(audit.routines.every(r=>r.exists&&r.securityDefiner&&!r.anonymousExecute&&r.authenticatedExecute));assert.equal(audit.saleLengthColumn,true);assert.equal(audit.migrationHistoryPresent,false);
  assert.equal((await db.query('select count(*)::int as n from mir_core.models')).rows[0].n,0,'audit leaves data unchanged');
 }finally{await db.close();}
});
