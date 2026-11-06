'use strict';
// Explicit opt-in acceptance runner. Real SDK, Auth, PostgREST and RPC only.
// No provisioning, migrations, email, payment, deletion or deployment.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {configuration}=require('./config.cjs');
const cases=['01-authentication','02-permissions-organizations','03-create-model','04-publish','05-independent-sessions','06-submit-requests','07-admin-retrieval','08-price-history','09-network-reconnection','10-existing-data-preservation','11-hosted-sql-audit'];
async function main(){
 const c=configuration(),report={schema:'mir-real-validation-1',startedAt:new Date().toISOString(),commit:spawnSync('git',['rev-parse','HEAD'],{cwd:c.root,encoding:'utf8'}).stdout.trim(),mode:'real-service-only',results:cases.map(name=>({name,status:'BLOCKED',detail:'Not executed'}))};
 const result=(name,status,detail)=>{Object.assign(report.results.find(r=>r.name===name),{status,detail});console.log(status+' '+name+': '+detail);};
 const output=process.env.MIR_TEST_REPORT||path.join(c.root,'artifacts/mission-4-real.json');
 const write=()=>{report.finishedAt=new Date().toISOString();fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600});};
 const probe=spawnSync('python3',['-c',`import urllib.request,urllib.error,json,sys
try:
 r=urllib.request.urlopen(sys.argv[1],timeout=15);print(json.dumps({'reachable':True,'status':r.status}))
except urllib.error.HTTPError as e:print(json.dumps({'reachable':True,'status':e.code}))
except Exception:print(json.dumps({'reachable':False,'reason':'Network/proxy connection refused or unavailable'}))`,c.publicConfig.supabaseUrl+'/auth/v1/settings'],{encoding:'utf8',timeout:20000});
 try{report.connectivity=JSON.parse(probe.stdout);}catch{report.connectivity={reachable:false,reason:'Connectivity probe unavailable'};}
 report.missingVariables=c.missing;
 if(!report.connectivity.reachable||c.missing.length){console.log('BLOCKED: '+(!report.connectivity.reachable?'Supabase network access unavailable. ':'')+(c.missing.length?'Missing secret/variable names: '+c.missing.join(', '):''));write();process.exitCode=2;return;}
 if(process.argv.includes('--preflight')){console.log('Preflight ready; no login or write attempted.');write();return;}
 if(process.env.MIR_TEST_ALLOW_FIXTURES!=='yes'){console.log('BLOCKED: set MIR_TEST_ALLOW_FIXTURES=yes after verifying a dedicated MIR TEST organization.');write();process.exitCode=2;return;}
 const {chromium}=require('playwright'),M=require('../../dist/production-model.js'),B=require('../../dist/template-library-backup.js');
 let server,browser,admin,fixture,settings,activeCase='01-authentication';const pages={},contexts=[];
 const run='mission4-'+randomUUID(),originalOrders=new Map();
 const check=async(name,fn)=>{activeCase=name;const state=await fn();if(state!=='blocked')result(name,'PASS','Real authenticated Supabase requests completed');};
 const rpc=(p,name,args)=>p.evaluate(async({name,args})=>{const {data,error}=await window.__missionSdk.rpc(name,args);return {data,error:error?{code:error.code,message:error.message}:null};},{name,args});
 const ok=async(p,name,args)=>{const r=await rpc(p,name,args);if(r.error)throw Error(name+': '+r.error.code+' '+r.error.message);return r.data;};
 const denied=async(p,name,args)=>{const r=await rpc(p,name,args);assert.equal(r.error?.code,'42501','Expected a permission refusal, not a missing RPC or network failure');};
 const snapshot=p=>ok(p,'mir_shared_snapshot',{org:c.org});
 try{
  server=http.createServer((req,res)=>{const target=path.resolve(c.root,'dist','.'+new URL(req.url,'http://localhost').pathname);if(!target.startsWith(path.join(c.root,'dist')+path.sep)||!fs.existsSync(target)||!fs.statSync(target).isFile()){res.statusCode=404;res.end();return;}res.setHeader('content-type',({'.js':'application/javascript','.html':'text/html','.css':'text/css'})[path.extname(target)]||'application/octet-stream');fs.createReadStream(target).pipe(res);});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base='http://127.0.0.1:'+server.address().port,executable=process.env.MIR_CHROMIUM_EXECUTABLE||['/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>fs.existsSync(p));
  const proxy=process.env.HTTPS_PROXY||process.env.HTTP_PROXY;
  browser=await chromium.launch({...(executable?{executablePath:executable}:{}),headless:true,args:['--no-sandbox'],...(proxy?{proxy:{server:proxy,bypass:'127.0.0.1,localhost'}}:{})});
  const login=async(role,width)=>{
   const context=await browser.newContext({viewport:{width,height:900},hasTouch:width<1100});contexts.push(context);const p=await context.newPage();p.setDefaultTimeout(20000);
   await p.goto(base+'/espace-partage.html');await p.locator('[name=email]').fill(c.accounts[role].email);await p.locator('[name=password]').fill(c.accounts[role].password);await p.locator('#login button').click();await p.locator('#workspace').waitFor({state:'visible'});
   await p.evaluate(()=>{window.__missionSdk=window.MIRSupabase.createClient(window.MIRSharedConfig.supabaseUrl,window.MIRSharedConfig.publishableKey);});
   const user=await p.evaluate(async()=>{const r=await window.__missionSdk.auth.getUser();return r.error?null:r.data.user?.id;});assert.ok(user,'Real Auth getUser confirmation required');
   const memberships=await ok(p,'mir_my_memberships',{}),membership=memberships.find(m=>m.id===c.org);
   if(role!=='outsider'){assert.ok(membership,'Account must already belong to the test organization');assert.match(membership.name,/^MIR TEST(?:\b|[ _-])/i,'Production organization refused');assert.equal(membership.role,role==='other_client'?'client':role);await p.locator('#organization').selectOption(c.org);}
   else assert.equal(membership,undefined,'Outsider must not belong to the primary organization');
   pages[role]=p;return {p,user,memberships};
  };
  let employeeId;
  await check('01-authentication',async()=>{const a=await login('admin',1440);admin=a.p;const e=await login('employee',1024),cl=await login('client',390);employeeId=e.user;assert.equal(new Set([a.user,e.user,cl.user]).size,3);});
  const template=M.createTemplate({kind:'profile',template:'l',unit:'in',dimensions:{A:3,B:2}},{id:run,name:'MIR TEST — '+run}).template;
  const record={id:run,name:template.name,currentVersion:1,versions:[template],allowed:{materials:['aluminium','acier'],colorSystems:['manufacturer']}};assert.equal(B.validate([record]).ok,true);
  await check('03-create-model',async()=>{fixture=await ok(admin,'mir_import_master',{org:c.org,record});assert.equal(await ok(admin,'mir_import_master',{org:c.org,record}),fixture);});
  let model;
  settings={boutique:true,store:true,supplier_po:false,archived:false,aluminum_cents:1234,steel_cents:2345,sale_length_in:120,conditions:'TEST TECHNIQUE — aucune vente, aucun stock confirmé',standard_measures:{A:'3',B:'2'},locked_measures:{A:'3'}};
  await check('04-publish',async()=>{model=(await snapshot(admin)).catalogue.find(m=>m.id===fixture);await ok(admin,'mir_admin_publish_model',{org:c.org,model:fixture,expected_revision:model.revision,settings});model=(await snapshot(admin)).catalogue.find(m=>m.id===fixture);assert.equal(model.boutique,true);assert.equal(model.store,true);});
  await check('05-independent-sessions',async()=>{for(const role of ['employee','client']){await pages[role].locator('#refresh').click();const state=await snapshot(pages[role]);assert.ok(state.catalogue.some(m=>m.id===fixture));await pages[role].locator('[data-model-id="'+fixture+'"]').waitFor();assert.ok(await pages[role].evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'No horizontal overflow');}});
  let clientOrder,employeeOrder;const config={metal:'aluminium',quantity:2,color:'TEST couleur à valider',measures:{A:'3',B:'2',length:'120'}};
  const submit=(p,request_id,configuration,revision=model.revision)=>ok(p,'mir_submit_request',{org:c.org,request_id,model:fixture,publication_revision:revision,configuration});
  await check('06-submit-requests',async()=>{for(const [role,p] of Object.entries(pages))originalOrders.set(role,(await snapshot(p)).orders);const job=await ok(admin,'mir_assign_job',{org:c.org,job_name:'MIR TEST '+run,employee:employeeId});clientOrder=await submit(pages.client,randomUUID(),config);employeeOrder=await submit(pages.employee,randomUUID(),{...config,chantier:job});assert.notEqual(clientOrder,employeeOrder);});
  await check('07-admin-retrieval',async()=>{const s=await snapshot(admin);assert.ok(s.orders.some(o=>o.id===clientOrder));assert.ok(s.orders.some(o=>o.id===employeeOrder));await admin.locator('#refresh').click();assert.match(await admin.locator('#orders').textContent(),new RegExp(clientOrder));});
  await check('08-price-history',async()=>{const before=(await snapshot(pages.client)).orders.find(o=>o.id===clientOrder);assert.equal(before.snapshot.unitPriceCents,1234);settings={...settings,aluminum_cents:3456};await ok(admin,'mir_admin_publish_model',{org:c.org,model:fixture,expected_revision:model.revision,settings});model=(await snapshot(admin)).catalogue.find(m=>m.id===fixture);const after=await snapshot(pages.client);assert.equal(after.catalogue.find(m=>m.id===fixture).aluminumCents,3456);assert.deepEqual(after.orders.find(o=>o.id===clientOrder),before);});
  await check('02-permissions-organizations',async()=>{
   const anon=await pages.client.evaluate(async org=>{const cfg=window.MIRSharedConfig;const sdk=window.MIRSupabase.createClient(cfg.supabaseUrl,cfg.publishableKey,{auth:{storageKey:'mir-mission4-anonymous',persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});const r=await sdk.rpc('mir_shared_snapshot',{org});return {code:r.error?.code};},c.org);assert.equal(anon.code,'42501','Anonymous RPC must be denied, not simply unavailable');

   for(const role of ['employee','client'])await denied(pages[role],'mir_admin_publish_model',{org:c.org,model:fixture,expected_revision:model.revision,settings});
   assert.equal((await snapshot(pages.employee)).catalogue.find(m=>m.id===fixture).aluminumCents,null);assert.deepEqual((await snapshot(pages.employee)).members,[]);
   assert.equal((await snapshot(pages.client)).orders.some(o=>o.id===employeeOrder),false);assert.equal((await snapshot(pages.employee)).orders.some(o=>o.id===clientOrder),false);
   const forged=await rpc(pages.client,'mir_submit_request',{org:c.org,request_id:randomUUID(),model:fixture,publication_revision:model.revision,configuration:{...config,price:1}});assert.ok(forged.error,'Browser-supplied price refused');assert.notEqual(forged.error.code,'PGRST202');
   if(!c.accounts.outsider||!c.foreignOrg||!c.accounts.other_client){result('02-permissions-organizations','BLOCKED','Role/price and employee/client isolation passed; second client and foreign-organization accounts still required');return 'blocked';}
   const outsider=await login('outsider',1440);assert.ok(outsider.memberships.some(m=>m.id===c.foreignOrg&&/^MIR TEST\b/i.test(m.name)));await denied(outsider.p,'mir_shared_snapshot',{org:c.org});await denied(admin,'mir_shared_snapshot',{org:c.foreignOrg});
   const peer=await login('other_client',390);assert.equal((await snapshot(peer.p)).orders.some(o=>o.id===clientOrder),false);
  });
  await check('09-network-reconnection',async()=>{
   const p=pages.client;await p.evaluate(()=>{window.__missionClient=window.MIRSharedClient.create({sdk:window.__missionSdk,storage:localStorage});});
   await p.context().setOffline(true);const offline=await p.evaluate(async({org,model,configuration})=>{try{await window.__missionClient.submit(org,model,configuration);return false;}catch{return true;}},{org:c.org,model,configuration:config});assert.equal(offline,true);await p.context().setOffline(false);
   const request=await p.evaluate(async org=>window.__missionClient.pending(org),c.org);assert.ok(request?.requestId);
   // A real commit whose response is lost. No auth, SDK or RPC response is fabricated.
   let dropped=false;await p.route('**/rest/v1/rpc/mir_submit_request',async route=>{if(dropped)return route.continue();const response=await route.fetch();assert.equal(response.ok(),true);dropped=true;await route.abort('failed');});
   const retry=()=>p.evaluate(async({org,model,configuration})=>{try{return {id:await window.__missionClient.submit(org,model,configuration)};}catch{return {failed:true};}},{org:c.org,model,configuration:config});
   assert.equal((await retry()).failed,true);await p.unroute('**/rest/v1/rpc/mir_submit_request');
   await p.locator('#logout').click();await p.locator('#login').waitFor({state:'visible'});await p.waitForFunction(async()=>!(await window.__missionSdk.auth.getSession()).data.session);await denied(p,'mir_shared_snapshot',{org:c.org});
   await p.locator('[name=email]').fill(c.accounts.client.email);await p.locator('[name=password]').fill(c.accounts.client.password);await p.locator('#login button').click();await p.locator('#workspace').waitFor({state:'visible'});
   const confirmed=await retry();assert.ok(confirmed.id);assert.equal(await submit(p,request.requestId,config),confirmed.id);assert.equal((await snapshot(admin)).orders.filter(o=>o.id===confirmed.id).length,1);assert.equal(await p.evaluate(async org=>window.__missionClient.pending(org),c.org),null);
  });
  // Test fixture snapshots only. No access to the user's iPad localStorage.
  for(const [role,orders] of originalOrders){const current=(await snapshot(pages[role])).orders;for(const order of orders)assert.deepEqual(current.find(o=>o.id===order.id),order);}
  result('10-existing-data-preservation','BLOCKED','Visible pre-existing server snapshots unchanged; actual iPad models/PO backups not available, full preservation not certified');
  result('11-hosted-sql-audit','BLOCKED','Read-only SQL audit must be executed on hosted database; browser RPC isolation does not prove table RLS policies');
 }catch(e){
  let message=String(e.message||e);for(const a of Object.values(c.accounts))for(const value of [a.email,a.password])if(value)message=message.split(value).join('[redacted]');
  result(activeCase,'FAIL',message.slice(0,800));
 }finally{
  if(admin&&fixture&&settings){try{const m=(await snapshot(admin)).catalogue.find(m=>m.id===fixture);await ok(admin,'mir_admin_publish_model',{org:c.org,model:fixture,expected_revision:m.revision,settings:{...settings,boutique:false,store:false,supplier_po:false,archived:true}});report.fixture={run,model:fixture,state:'archived',note:'Test requests/job retained as audit evidence; no deletion'};}catch{report.fixture={run,model:fixture,state:'cleanup-unconfirmed',note:'Admin must archive only this TEST model manually'};report.cleanupFailed=true;}}
  if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));write();
 }
 if(report.cleanupFailed||report.results.some(r=>r.status==='FAIL'))process.exitCode=1;else if(report.results.some(r=>r.status==='BLOCKED'))process.exitCode=2;
}
main().catch(()=>{console.error('Validation stopped before execution: check configuration; no credentials printed.');process.exitCode=2;});
