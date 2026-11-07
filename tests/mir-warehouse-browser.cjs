'use strict';
/* Simulated RPC only: browser UI tests do not certify Supabase hosted. */
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const port=8921,base='http://127.0.0.1:'+port;
const token='02c8070d-d549-4298-833e-b1a8e6310981';
const mock="\nwindow.__rpcCalls=[];\nwindow.__warehouseFixture={\n access:true,org:'8025799e-2b83-47d6-880a-e4b15a904356',token:'02c8070d-d549-4298-833e-b1a8e6310981',\n skuId:'40eb4980-3b74-48f4-9878-b74e5f0bf222',lineId:'ed105621-549b-4cd2-a66c-69f818fa1574',\n orderId:'a3fe7d2e-a861-44f8-906b-1a83a1c0d9c0',onHand:85,delivered:0,movements:[],ids:new Map()\n};\nwindow.MIRSupabase={createClient:()=>({\n auth:{getUser:async()=>({data:{user:{id:'40eb4980-3b74-48f4-9878-b74e5f0bf222'}}}),\n signInWithPassword:async()=>({error:null}),signOut:async()=>({error:null}),\n onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},\n rpc:async(name,args)=>{\n  window.__rpcCalls.push({name,args});const s=window.__warehouseFixture;\n  if(name==='mir_warehouse_memberships')return {data:s.access?[{id:s.org,name:'MIR TEST',isAdmin:true}]:[]};\n  if(name==='mir_warehouse_queue')return {data:s.delivered<25?[{orderId:s.orderId,lineId:s.lineId,skuId:s.skuId,qrToken:s.token,sku:'MONO-TEST',name:'Tube Mono',requestedQty:25,deliveredQty:s.delivered,remainingQty:25-s.delivered,unit:'tube',job:'Chantier test'}]:[]};\n  if(name==='mir_warehouse_snapshot')return {data:{sku:{id:s.skuId,sku:'MONO-TEST',name:'Tube Mono',unit:'tube',qrToken:s.token,step:1,onHand:s.onHand,sourceKind:'hardware'},\n   orders:s.delivered<25?[{orderId:s.orderId,lineId:s.lineId,skuId:s.skuId,requestedQty:25,deliveredQty:s.delivered,cancelledQty:0,remainingQty:25-s.delivered,job:'Chantier test'}]:[],\n   movements:s.movements}};\n  if(name==='mir_warehouse_search')return {data:[{id:s.skuId,sku:'MONO-TEST',name:'Tube Mono',unit:'tube',qrToken:s.token,onHand:s.onHand}]};\n  if(name==='mir_warehouse_move'){\n   if(s.ids.has(args.request_id))return {data:{...s.ids.get(args.request_id),replayed:true}};\n   if(s.onHand+args.delta<0)return {data:null,error:{code:'22023',message:'Stock insuffisant'}};\n   if(args.line_id&&(-args.delta)>25-s.delivered)return {data:null,error:{code:'22023',message:'Dépassement du reliquat'}};\n   s.onHand+=args.delta;if(args.line_id)s.delivered-=args.delta;\n   s.movements.unshift({at:new Date().toISOString(),delta:args.delta,kind:args.line_id?'delivery':args.delta>0?'receipt':'adjustment',\n    reason:args.reason,actorId:'40eb4980-3b74-48f4-9878-b74e5f0bf222',orderLineId:args.line_id});\n   const out={stockAfter:s.onHand,remainingAfter:args.line_id?25-s.delivered:null,replayed:false};\n   s.ids.set(args.request_id,out);return {data:out};\n  }\n  if(name==='mir_warehouse_register')return {data:{sku:args.sku_code,qrToken:s.token}};\n  return {data:null,error:{message:'RPC inconnue : '+name}};\n }\n})};\n";
async function ready(){for(let i=0;i<80;i++){const ok=await new Promise(r=>http.get(base+'/entrepot.html',x=>{x.resume();r(x.statusCode===200)}).on('error',()=>r(false)));if(ok)return;await new Promise(r=>setTimeout(r,120))}throw Error('Server unavailable')}
(async()=>{
 fs.mkdirSync(path.join(__dirname,'../artifacts'),{recursive:true});
 const server=spawn('python3',['-m','http.server',String(port),'--directory',path.join(__dirname,'../dist'),'--bind','127.0.0.1'],{stdio:'ignore'});
 let browser;
 try{
  await ready();browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  for(const size of [{name:'desktop',width:1440,height:900},{name:'mobile',width:390,height:844}]){
   const context=await browser.newContext({viewport:{width:size.width,height:size.height},hasTouch:size.width<1100});
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/vendor/supabase-client.js',route=>route.fulfill({status:200,contentType:'application/javascript',body:mock}));
   await page.goto(base+'/entrepot.html?qr='+token,{waitUntil:'domcontentloaded'});
   await page.locator('#wh-detail').waitFor({state:'visible',timeout:25000});
   assert.equal(await page.locator('#wh-stock-qty').textContent(),'85');
   assert.match(await page.locator('#wh-current-order').textContent(),/Reste 25/);
   assert.match(await page.locator('#wh-label-url').textContent(),/entrepot\.html\?qr=/);
   await page.waitForFunction(()=>!!document.querySelector('#wh-label-qr img,#wh-label-qr canvas'));
   assert.equal(await page.locator('#wh-queue button').count(),1);
   await page.locator('#wh-delta').fill('-20');
   assert.match(await page.locator('#wh-preview').textContent(),/85.*65/);
   assert.match(await page.locator('#wh-preview').textContent(),/reste 5/i);
   await page.locator('#wh-submit').click();
   await page.waitForFunction(()=>document.querySelector('#wh-stock-qty').textContent==='65');
   assert.match(await page.locator('#wh-current-order').textContent(),/Reste 5/);
   await page.locator('#wh-order-select').selectOption('');
   await page.locator('#wh-delta').fill('-10');
   await page.locator('#wh-reason').fill('Sortie stock inventaire');
   assert.match(await page.locator('#wh-preview').textContent(),/65.*55/);
   await page.locator('#wh-submit').click();
   await page.waitForFunction(()=>document.querySelector('#wh-stock-qty').textContent==='55');
   assert.equal(await page.evaluate(()=>window.__warehouseFixture.delivered),20,'sortie libre ne change pas le bon');
   assert.equal(await page.evaluate(()=>window.__warehouseFixture.movements.length),2);
   await page.locator('#wh-qr-input').fill('https://evil.example/entrepot.html?qr='+token);
   await page.locator('#wh-scan-form button').click();
   assert.match(await page.locator('#wh-status').textContent(),/QR inconnu/);
   const widths=await page.evaluate(()=>({root:document.documentElement.scrollWidth,view:innerWidth}));
   assert.ok(widths.root<=widths.view+2,'aucun débordement horizontal '+JSON.stringify(widths));
   assert.deepEqual(errors,[],size.name+' errors');
   await page.screenshot({path:path.join(__dirname,'../artifacts/mir-entrepot-'+size.name+'.png'),fullPage:true});
   console.log('PASS MOCK '+size.name+': QR, stock 85→65, bon 25→5, sortie libre 65→55');
   await context.close();
  }
  const context=await browser.newContext(),page=await context.newPage();
  await page.route('**/vendor/supabase-client.js',route=>route.fulfill({status:200,contentType:'application/javascript',body:mock.replace('access:true,org','access:false,org')}));
  await page.goto(base+'/entrepot.html?qr='+token,{waitUntil:'domcontentloaded'});
  await page.locator('#wh-login').waitFor({state:'visible'});
  assert.equal(await page.locator('#wh-workspace').isVisible(),false);
  assert.equal(await page.locator('#wh-detail').isVisible(),false);
  await context.close();console.log('PASS MOCK accès non autorisé : stock invisible');
 }finally{if(browser)await browser.close();server.kill();}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
