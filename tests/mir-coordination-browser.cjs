'use strict';
/* Tests navigateur explicites sous Auth/RPC simulées : aucune preuve hébergée. */
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{chromium}=require('playwright');
const port=8933,base='http://127.0.0.1:'+port,fixture="window.__state={\n permitted:true,org:'00000000-0000-4000-8000-000000000010',\n source:'00000000-0000-4000-8000-000000000061',\n id:'00000000-0000-4000-8000-000000000070',revision:1,\n events:[],supplierIds:['00000000-0000-4000-8000-000000000050','00000000-0000-4000-8000-000000000051'],\n poNumber:0,lines:[\n {id:'00000000-0000-4000-8000-000000000071',sourceLineId:'00000000-0000-4000-8000-000000000081',name:'Tube Mono',unit:'tube',requestedQty:25,variantKey:'MONO',routes:[]},\n {id:'00000000-0000-4000-8000-000000000072',sourceLineId:'00000000-0000-4000-8000-000000000082',name:'Solin 3 plis',unit:'pièce',requestedQty:12,variantKey:'SOLIN',routes:[]}\n ],job:'JOB-353',address:'101 rue de chantier, Québec',team:'Équipe A',priority:'normal',notes:''\n};\nwindow.__calls=[];\nwindow.MIRSupabase={createClient:()=>({\n auth:{getUser:async()=>({data:{user:{id:'00000000-0000-4000-8000-000000000001'}}}),signInWithPassword:async()=>({error:null}),signOut:async()=>({error:null}),\n  onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},\n rpc:async(name,args)=>{\n  const s=window.__state;window.__calls.push({name,args});\n  if(name==='mir_coordination_memberships')return {data:s.permitted?[{id:s.org,name:'MIR TEST',assistant:true,admin:true,warehouse:false}]:[]};\n  if(name==='mir_coordination_inbox')return {data:[{sourceOrderId:s.source,id:s.opened?s.id:null,revision:s.revision,\n   job:s.job,address:s.address,team:s.team,lineCount:s.lines.length,status:s.opened?'in_progress':'new'}]};\n  if(name==='mir_coordination_suppliers')return {data:[\n   {id:s.supplierIds[0],name:'Breton Pliage',verified:true},\n   {id:s.supplierIds[1],name:'Unico Revêtement',verified:false}]};\n  if(name==='mir_coordination_supplier_orders')return {data:[]};\n  if(name==='mir_coordination_open'){s.opened=true;return {data:{id:s.id,revision:s.revision}};}\n  if(name==='mir_coordination_detail')return {data:{id:s.id,sourceOrderId:s.source,revision:s.revision,\n   job:s.job,address:s.address,team:s.team,priority:s.priority,notes:s.notes,shippedAt:null,\n   lines:s.lines,events:s.events}};\n  if(name==='mir_coordination_route'){\n   const line=s.lines.find(l=>l.id===args.coord_line);\n   if(!line)return {error:{message:'Ligne inconnue'}};\n   if(args.expected_revision!==s.revision)return {error:{code:'40001',message:'Révision changée'}};\n   let idIndex=0;line.routes=[];\n   if(args.warehouse_qty>0)line.routes.push({id:line.id+'-wh',lane:'warehouse',quantity:args.warehouse_qty,pickedQty:0});\n   for(const item of args.suppliers||[])line.routes.push({id:line.id+'-'+(++idIndex),lane:'supplier',\n      supplierId:item.supplierId,quantity:item.quantity,receivedQty:0,supplierOrderId:null});\n   s.revision++;s.events.push({type:'routed',revision:s.revision,payload:{name:line.name},at:new Date().toISOString()});\n   return {data:{revision:s.revision}};\n  }\n  if(name==='mir_coordination_add'){\n   const line=s.lines.find(l=>l.id===args.existing_coord_line),amount=Number(args.additional_qty);\n   if(!line||!amount||amount<0)return {error:{message:'Quantité invalide'}};\n   const extra={id:'00000000-0000-4000-8000-'+String(90+s.lines.length).padStart(12,'0'),\n    sourceLineId:'00000000-0000-4000-8000-'+String(190+s.lines.length).padStart(12,'0'),\n    name:line.name,unit:line.unit,requestedQty:amount,variantKey:line.variantKey,routes:[]};\n   s.lines.push(extra);s.revision++;\n   s.events.push({type:'quantity_added',revision:s.revision,payload:{name:line.name,delta:amount,unit:line.unit},at:new Date().toISOString()});\n   return {data:{revision:s.revision,newLineId:extra.id}};\n  }\n  if(name==='mir_coordination_supplier_po'){\n   const line=s.lines.find(l=>l.routes.some(r=>r.id===args.route_id)),route=line?.routes.find(r=>r.id===args.route_id);\n   if(!route)return {error:{message:'Route inconnue'}};\n   route.supplierOrderId=args.po_id||('00000000-0000-4000-8000-'+String(320+s.poNumber++).padStart(12,'0'));\n   s.revision++;s.events.push({type:'po_linked',revision:s.revision,at:new Date().toISOString(),payload:{poId:route.supplierOrderId}});\n   return {data:{revision:s.revision,supplierOrderId:route.supplierOrderId}};\n  }\n  if(name==='mir_coordination_metadata'){\n   Object.assign(s,args.vals||{});s.revision++;\n   s.events.push({type:'note_changed',revision:s.revision,payload:{},at:new Date().toISOString()});\n   return {data:{revision:s.revision}};\n  }\n  if(name==='mir_coordination_supplier_receive'){\n   const route=s.lines.flatMap(l=>l.routes).find(r=>r.id===args.route_id);\n   if(!route)return {error:{message:'Bon introuvable'}};\n   route.receivedQty+=Number(args.quantity);s.revision++;\n   return {data:{revision:s.revision,receivedQty:route.receivedQty}};\n  }\n  return {error:{message:'RPC simulée inconnue : '+name}};\n }\n})};";
async function ready(){for(let i=0;i<60;i++){const ok=await new Promise(resolve=>http.get(base+'/coordination.html',r=>{r.resume();resolve(r.statusCode===200)}).on('error',()=>resolve(false)));if(ok)return;await new Promise(r=>setTimeout(r,150));}throw Error('Server unavailable');}
(async()=>{
 fs.mkdirSync(path.join(__dirname,'../artifacts'),{recursive:true});
 const server=spawn('python3',['-m','http.server',String(port),'--directory',path.join(__dirname,'../dist'),'--bind','127.0.0.1'],{stdio:'ignore'});
 let browser;
 try{
  await ready();browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  for(const size of [{width:1440,height:900,name:'bureau'},{width:390,height:844,name:'mobile'}]){
   const context=await browser.newContext({viewport:{width:size.width,height:size.height},hasTouch:size.width<1100});
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/vendor/supabase-client.js',route=>route.fulfill({status:200,contentType:'application/javascript',body:fixture}));
   await page.goto(base+'/coordination.html',{waitUntil:'domcontentloaded'});
   await page.locator('#co-workspace').waitFor({state:'visible',timeout:22000});
   await page.locator('#co-orders [data-co-open]').first().click();
   await page.locator('#co-line-list [data-co-line]').first().waitFor({state:'visible'});
   let first=page.locator('#co-line-list [data-co-line]').first();
   await first.locator('input[name=warehouse]').fill('20');
   await first.locator('[data-co-supplier]').selectOption('00000000-0000-4000-8000-000000000050');
   await first.locator('[data-co-supplier-qty]').fill('5');
   await first.locator('[data-co-save]').click();
   await page.waitForFunction(()=>window.__state.lines[0].routes.length===2);
   assert.match(await page.locator('#co-metrics').textContent(),/Entrepôt/);
   assert.equal(await page.locator('#co-line-list [data-co-po-route]').count(),1);
   await page.locator('#co-line-list [data-co-po-route] button[data-co-action=po]').first().click();
   await page.waitForFunction(()=>!!window.__state.lines[0].routes[1].supplierOrderId);
   const createdPO=await page.evaluate(()=>window.__state.lines[0].routes[1].supplierOrderId);
   assert.ok(createdPO,'nouveau PO fournisseur');
   // Deuxième fournisseur sur la même commande employé.
   const second=page.locator('#co-line-list [data-co-line]').nth(1);
   await second.locator('[data-co-supplier]').selectOption('00000000-0000-4000-8000-000000000051');
   await second.locator('[data-co-supplier-qty]').fill('12');
   await second.locator('[data-co-save]').click();
   await page.waitForFunction(()=>window.__state.lines[1].routes.length===1);
   await page.locator('#co-line-list [data-co-line]').nth(1).locator('[data-co-action=po]').click();
   await page.waitForFunction(()=>!!window.__state.lines[1].routes[0].supplierOrderId);
   assert.notEqual(createdPO,await page.evaluate(()=>window.__state.lines[1].routes[0].supplierOrderId),'deux fournisseurs, deux bons');
   first=page.locator('#co-line-list [data-co-line]').first();
   await first.locator('[data-co-add-qty]').fill('3');
   await first.locator('[data-co-action=add]').click();
   await page.waitForFunction(()=>window.__state.lines.length===3);
   assert.match(await page.locator('#co-notifications').textContent(),/Ajout de matériel/);
   assert.match(await page.locator('#co-events').textContent(),/Ajout \+3/);
   assert.match(await page.locator('#co-line-list').textContent(),/Demandé : 3/);
   const meta=page.locator('#co-meta');
   await meta.locator('[name=team]').fill('Équipe B');
   await meta.locator('[name=address]').fill('321 rue neuve');
   await meta.locator('button[type=submit]').click();
   await page.waitForFunction(()=>window.__state.team==='Équipe B');
   assert.equal(await page.locator('#co-meta [name=team]').inputValue(),'Équipe B');
   assert.equal(await page.locator('#co-meta [name=address]').inputValue(),'321 rue neuve');
   const widths=await page.evaluate(()=>({root:document.documentElement.scrollWidth,viewport:innerWidth}));
   assert.ok(widths.root<=widths.viewport+2,'pas de débordement horizontal '+JSON.stringify(widths));
   assert.deepEqual(errors,[],'Erreurs page '+size.name);
   await page.screenshot({path:path.join(__dirname,'../artifacts/mir-coordination-'+size.name+'.png'),fullPage:true});
   console.log('PASS SIMULÉ '+size.name+' : split 20/5, deux POs, ajout +3, chantier et notifications');
   await context.close();
  }
  const context=await browser.newContext(),page=await context.newPage();
  await page.route('**/vendor/supabase-client.js',route=>route.fulfill({status:200,contentType:'application/javascript',body:fixture.replace('permitted:true','permitted:false')}));
  await page.goto(base+'/coordination.html',{waitUntil:'domcontentloaded'});
  await page.locator('#co-login').waitFor({state:'visible'});
  assert.equal(await page.locator('#co-workspace').isVisible(),false);
  await context.close();
  console.log('PASS SIMULÉ droits : compte non autorisé sans accès aux commandes');
 }finally{if(browser)await browser.close();server.kill();}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
