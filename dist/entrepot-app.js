/* MIR Entrepôt — vraie Auth, QR opaque et mouvements côté serveur uniquement.
 * Cette page ne possède jamais la vérité des quantités, même hors ligne. */
(function(){
'use strict';
const $=selector=>document.querySelector(selector), Core=window.MIRWarehouseCore;
const status=message=>{$('#wh-status').textContent=String(message||'');};
const live=message=>{$('#wh-live').textContent=String(message||'');};
const fmt=n=>new Intl.NumberFormat('fr-CA',{maximumFractionDigits:3}).format(Number(n)||0);
let client=null,orgs=[],current=null,selectedLineId='',lastQueue=[],busy=false,scannerStream=null,scanFrame=0,catalogueItems=[];
const node=(tag,text='',parent)=>{const el=document.createElement(tag);el.textContent=String(text??'');if(parent)parent.append(el);return el;};
function fail(error){const message=error?.message||String(error||'Opération non confirmée');status(message);live(message);return message;}
function clearChildren(selector){const el=$(selector);if(el)el.replaceChildren();return el;}
function org(){return $('#wh-org')?.value||null;}
function activeOrg(){return orgs.find(x=>x.id===org())||null;}
function authenticated(){return !!client&&Array.isArray(orgs)&&orgs.length>0;}
function clearIdentity(){
 orgs=[];current=null;lastQueue=[];
 $('#wh-workspace').hidden=true;$('#wh-detail').hidden=true;$('#wh-login').hidden=false;
 clearChildren('#wh-queue');clearChildren('#wh-history');clearChildren('#wh-results');
 $('#wh-submit').disabled=true;
}
async function loadCatalogue(){
 if(catalogueItems.length||!activeOrg()?.isAdmin||!window.MIREmployeeStore?.buildCatalogue)return;
 try{
  const response=await fetch('catalogue-fd6866b49d21.json',{cache:'no-cache'});
  if(!response.ok)throw Error('Le catalogue MIR ne répond pas.');
  const raw=await response.json();
  catalogueItems=window.MIREmployeeStore.buildCatalogue(raw.materials||[]);
  catalogueResults();
 }catch(error){status('Catalogue non chargé : '+error.message);}
}
function catalogueResults(){
 const selector=clearChildren('#wh-catalogue-select'),term=$('#wh-catalogue-query').value.trim().toLocaleLowerCase('fr-CA');
 const first=node('option','Choisir la référence exacte',selector);first.value='';
 const entries=catalogueItems.filter(item=>item.active!==false&&!item.referencePending&&
  (item.name+' '+item.brand+' '+item.id).toLocaleLowerCase('fr-CA').includes(term)).slice(0,60);
 for(const item of entries){const o=node('option',item.name+' · '+(item.brand||'MIR')+' · '+item.unit,selector);o.value=item.id;}
 catalogueOptions();
}
function catalogueOptions(){
 const item=catalogueItems.find(row=>row.id===$('#wh-catalogue-select').value);
 const colors=clearChildren('#wh-catalogue-color'),formats=clearChildren('#wh-catalogue-format');
 const c=node('option',item?.colorPolicy==='required'?'Choisir une couleur exacte':'Aucune couleur requise',colors);c.value='';
 for(const row of item?.colors||[]){const o=node('option',row.name,colors);o.value=row.id;}
 const base=node('option',item?.formats?.length>1?'Choisir un format exact':'Format standard',formats);base.value='';
 for(const row of item?.formats||[]){const o=node('option',row.label||row.id,formats);o.value=row.id;}
 colors.disabled=!item||item.colorPolicy==='none';
 formats.disabled=!item||item.formats?.length<=1;
}
function useCatalogue(){
 const item=catalogueItems.find(row=>row.id===$('#wh-catalogue-select').value),catalogue=window.MIREmployeeStore;
 if(!item)return status('Choisis un article existant du catalogue MIR.');
 if(item.measureFields?.length)return status('Ce pliage demande des cotes : crée-le et enregistre-le d’abord dans Mes pliages.');
 const configured=catalogue.configureLine({catalogue:catalogueItems},{itemId:item.id,quantity:1,
  colorId:$('#wh-catalogue-color').value||undefined,formatId:$('#wh-catalogue-format').value||undefined});
 if(!configured.ok)return status(configured.error?.message||'Choisis la bonne couleur et le bon format.');
 const line=configured.line,form=$('#wh-register-form');
 if(line.stockKey.length>300)return status('Variante trop longue : associe cette référence depuis Mes pliages avec l’Admin.');
 // Les pièces personnalisées du catalogue partagé ont un autre identifiant stable.
 // Une ancienne ligne du magasin reste une référence matérielle, sans inventer un UUID modèle.
 form.elements.kind.value='hardware';
 form.elements.sourceRef.value=line.stockKey;
 form.elements.sku.value=(item.id+(line.colorId?'-'+line.colorId:'')+(line.formatId?'-'+line.formatId:''))
   .replace(/[^a-zA-Z0-9._-]/g,'-').slice(0,80);
 form.elements.name.value=item.name+(line.colorName?' · '+line.colorName:'')+(line.formatLabel?' · '+line.formatLabel:'');
 form.elements.unit.value=item.unit;
 form.elements.step.value=item.quantityStep||1;
 status('Référence exacte reprise : '+item.name+'. Confirme les champs avant de créer son QR.');
 form.elements.sku.focus();
}
function renderOrgs(){
 const element=clearChildren('#wh-org');
 for(const row of orgs){const opt=node('option',row.name||'Organisation MIR',element);opt.value=row.id;}
 $('#wh-register-section').hidden=!activeOrg()?.isAdmin;
 if(activeOrg()?.isAdmin)void loadCatalogue();
}
async function session(){
 if(!client)return;
 try{
  const available=await client.memberships();
  if(!Array.isArray(available)||!available.length){clearIdentity();status('Accès Entrepôt réservé aux employés autorisés.');return;}
  orgs=available;$('#wh-login').hidden=true;$('#wh-workspace').hidden=false;renderOrgs();
  status('Connecté à l’entrepôt MIR · les quantités proviennent du serveur.');
  await refreshQueue();
  const code=new URLSearchParams(location.search).get('qr');
  if(code)await openRef(code);
 }catch(error){clearIdentity();status(/Connexion requise/i.test(error?.message||'')?'Connexion requise pour consulter l’inventaire.':error.message);}
}
async function refreshQueue(){
 if(!authenticated())return;
 try{
  const rows=await client.queue(org());lastQueue=Array.isArray(rows)?rows:[];
  const box=clearChildren('#wh-queue');
  if(!lastQueue.length){node('p','Aucune commande liée à un stock en attente de préparation.',box).className='wh-hint';return;}
  for(const row of lastQueue){
   const b=node('button','',box);b.type='button';b.className='wh-queue-item';
   node('strong',row.name||row.sku,b);
   node('small',(row.job||('Bon '+String(row.orderId||'').slice(0,8)))+' · Commandés '+fmt(row.requestedQty)+' · Livrés '+fmt(row.deliveredQty)+' · Reste '+fmt(row.remainingQty)+' '+(row.unit||''),b);
   b.addEventListener('click',()=>openRef(row.qrToken,{lineId:row.lineId}));
  }
 }catch(error){fail(error);}
}
function renderSearch(rows){
 const box=clearChildren('#wh-results');
 if(!Array.isArray(rows)||!rows.length){node('p','Aucune référence. Essaie un autre nom ou SKU.',box).className='wh-hint';return;}
 for(const row of rows){
  const b=node('button','',box);b.type='button';b.className='wh-result';
  node('strong',row.sku+' · '+row.name,b);
  node('small','Stock : '+fmt(row.onHand)+' '+row.unit,b);
  b.addEventListener('click',()=>openRef(row.qrToken));
 }
}
function renderOrder(){
 const options=clearChildren('#wh-order-select'),defaultOption=node('option','Aucune commande — mouvement d’inventaire',options);defaultOption.value='';
 const rows=Array.isArray(current?.orders)?current.orders:[];
 for(const row of rows){
  const option=node('option',(row.job||String(row.orderId||'').slice(0,8))+
   ' · demandé '+fmt(row.requestedQty)+' · livré '+fmt(row.deliveredQty)+' · reste '+fmt(row.remainingQty),options);
  option.value=row.lineId;
 }
 if(rows.some(row=>row.lineId===selectedLineId))options.value=selectedLineId;
 else if(rows.length===1){options.value=rows[0].lineId;selectedLineId=rows[0].lineId;}
 else{options.value='';selectedLineId='';}
 showOrder();
}
function showOrder(){
 selectedLineId=$('#wh-order-select').value;
 const row=(current?.orders||[]).find(x=>x.lineId===selectedLineId);
 const box=clearChildren('#wh-current-order');box.hidden=!row;
 if(row){
  node('strong','Commande : '+(row.job||String(row.orderId).slice(0,8)),box);
  node('p','Commandés '+fmt(row.requestedQty)+' · Livrés '+fmt(row.deliveredQty)+' · Reste '+fmt(row.remainingQty)+' '+current.sku.unit,box);
  const reason=$('#wh-reason');
  if(!reason.value||reason.dataset.auto==='1'){
   reason.value='Livraison commande '+String(row.orderId).slice(0,8);
   reason.dataset.auto='1';
  }
  $('#wh-delta').placeholder='-20';
 }else{
  const reason=$('#wh-reason');if(reason.dataset.auto==='1'){reason.value='';reason.dataset.auto='0';}
  $('#wh-delta').placeholder='-10 ou +10';
 }
 preview();
}
function renderHistory(){
 const box=clearChildren('#wh-history'),rows=current?.movements||[];
 if(!rows.length){node('p','Aucun mouvement enregistré pour cette référence.',box).className='wh-hint';return;}
 for(const item of rows){
  const row=node('div','',box);row.className='wh-history-row';
  const amount=Number(item.delta);
  node('b',(amount>0?'+':'')+fmt(amount),row);
  node('span',(item.kind==='delivery'?'Sortie commande':item.kind==='receipt'?'Réception fournisseur':'Correction stock')+
    ' · '+(item.reason||'')+' · '+new Date(item.at).toLocaleString('fr-CA'),row);
 }
}
function label(sku){
 const token=sku.qrToken;
 const url=Core.qrUrl(token,{origin:'https://revetementsmirweb.github.io',prefix:'/MIR/'});
 $('#wh-label-sku').textContent=sku.sku;$('#wh-label-name').textContent=sku.name+' · '+sku.unit;
 $('#wh-label-url').textContent=url;
 const qr=clearChildren('#wh-label-qr');
 if(typeof window.QRCode!=='function'){status('Générateur QR indisponible : impression désactivée.');$('#wh-print').disabled=true;return;}
 try{
  new window.QRCode(qr,{text:url,width:160,height:160,colorDark:'#18251d',colorLight:'#ffffff',
   correctLevel:window.QRCode.CorrectLevel.M});
  $('#wh-print').disabled=false;
 }catch(error){fail(error);$('#wh-print').disabled=true;}
}
function renderItem(){
 if(!current?.sku)return;
 const sku=current.sku;
 $('#wh-detail').hidden=false;$('#wh-item-name').textContent=sku.name;
 $('#wh-item-sku').textContent=sku.sku+' · '+(sku.sourceKind==='bending'?'Pliage enregistré':'Quincaillerie');
 $('#wh-stock-qty').textContent=fmt(sku.onHand);
 $('#wh-unit').textContent=sku.unit;
 $('#wh-remaining-total').textContent=fmt((current.orders||[]).reduce((sum,row)=>sum+Number(row.remainingQty||0),0));
 renderOrder();renderHistory();label(sku);
}
async function openRef(raw,{lineId=''}={}){
 if(!authenticated())return status('Connecte-toi avant de scanner un QR.');
 const token=Core.qrToken(raw);
 if(!token)return status('QR inconnu : utilise une étiquette MIR de l’entrepôt.');
 busy=true;$('#wh-qr-input').value=raw;status('Lecture de la fiche de stock sur le serveur…');
 try{
  const next=await client.snapshot(org(),token);
  if(!next?.sku?.id||next.sku.qrToken!==token)throw Error('Fiche retournée incompatible avec le QR demandé.');
  current=next;selectedLineId=lineId;
  $('#wh-delta').value='';$('#wh-reason').value='';$('#wh-reason').dataset.auto='0';
  renderItem();status('Fiche chargée : '+next.sku.name+'. Stock '+fmt(next.sku.onHand)+' '+next.sku.unit);
  const currentURL=new URL(location.href);currentURL.searchParams.set('qr',token);history.replaceState(null,'',currentURL);
 }catch(error){fail(error);}
 finally{busy=false;preview();}
}
function preview(){
 const box=$('#wh-preview');box.dataset.error='false';$('#wh-submit').disabled=true;
 if(!current?.sku){box.textContent='Scanne un QR de produit pour voir son stock.';return;}
 if(busy){box.textContent='Mouvement en cours, ne pas recommencer.';return;}
 const value=$('#wh-delta').value.trim(),reason=$('#wh-reason').value.trim();
 if(!value){box.textContent='Entre -20 pour sortir 20 articles, ou +20 pour une réception fournisseur.';return;}
 const line=(current.orders||[]).find(x=>x.lineId===selectedLineId)||null;
 try{
  const delta=Core.parseSigned(value);
  const result=Core.preview({sku:current.sku,line,amount:delta,reason:line?'delivery':delta>0?'receipt':'adjustment'});
  const message=(line?'Commande : reste '+fmt(result.order.after)+' '+current.sku.unit+' à livrer. ':'')+
   'Stock : '+fmt(result.stockBefore)+' → '+fmt(result.stockAfter)+' '+current.sku.unit+'.';
  box.textContent=message+(line?'':' Mouvement sans bon : aucun reliquat de commande ne change.');
  if(reason.length>=3){$('#wh-submit').disabled=false;$('#wh-submit').textContent='Confirmer '+(delta>0?'+':'')+fmt(delta)+' '+current.sku.unit;}
  else box.textContent+=' Indique le motif pour confirmer.';
 }catch(error){box.dataset.error='true';box.textContent=error.message;}
}
function stopCamera(){
 if(scanFrame)cancelAnimationFrame(scanFrame);scanFrame=0;
 if(scannerStream){scannerStream.getTracks().forEach(track=>track.stop());scannerStream=null;}
 $('#wh-camera').hidden=true;
}
async function startCamera(){
 if(!('BarcodeDetector'in window)||!navigator.mediaDevices?.getUserMedia)return status('Utilise l’appareil photo du téléphone ou un lecteur QR externe.');
 if(scannerStream)return;
 try{
  const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});
  scannerStream=stream;$('#wh-camera').hidden=false;const video=$('#wh-camera-video');video.srcObject=stream;await video.play();
  const detector=new BarcodeDetector({formats:['qr_code']});
  const scan=async()=>{if(!scannerStream)return;try{
   const rows=await detector.detect(video),row=rows.find(x=>Core.qrToken(x.rawValue));
   if(row){stopCamera();await openRef(row.rawValue);return;}
  }catch(error){status('Caméra : '+error.message);}scanFrame=requestAnimationFrame(scan);};
  scanFrame=requestAnimationFrame(scan);
 }catch(error){stopCamera();fail(error);}
}
async function bootstrap(){
 if(!Core||!window.MIRWarehouseClient||!window.MIRSupabase){clearIdentity();return status('Modules Entrepôt indisponibles.');}
 try{client=window.MIRWarehouseClient.create({sdk:window.MIRSupabase,
  config:window.MIRSharedConfig,storage:sessionStorage});}
 catch(error){clearIdentity();return status(error.message);}
 if('BarcodeDetector'in window&&navigator.mediaDevices?.getUserMedia)$('#wh-camera-start').hidden=false;
 await session();
}
$('#wh-login-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!client)return;
 const f=event.currentTarget,button=f.querySelector('button');button.disabled=true;status('Connexion et vérification des droits Entrepôt…');
 try{const data=new FormData(f);orgs=await client.login(String(data.get('email')),String(data.get('password')));
  f.elements.password.value='';$('#wh-login').hidden=true;$('#wh-workspace').hidden=false;renderOrgs();
  await refreshQueue();const code=new URLSearchParams(location.search).get('qr');
  if(code)await openRef(code);status('Connexion Entrepôt MIR réussie.');
 }catch(error){clearIdentity();fail(error);}
 finally{button.disabled=false;}
});
$('#wh-signout').addEventListener('click',async()=>{
 stopCamera();try{await client.logout();clearIdentity();status('Déconnecté de l’entrepôt MIR.');}
 catch(error){fail(error);}
});
$('#wh-refresh').addEventListener('click',async()=>{await refreshQueue();if(current?.sku?.qrToken)await openRef(current.sku.qrToken,{lineId:selectedLineId});});
$('#wh-org').addEventListener('change',async()=>{
 current=null;selectedLineId='';$('#wh-detail').hidden=true;$('#wh-register-section').hidden=!activeOrg()?.isAdmin;
 await refreshQueue();
 const token=Core.qrToken(new URLSearchParams(location.search).get('qr')||'');
 if(token)await openRef(token);
});
$('#wh-scan-form').addEventListener('submit',event=>{event.preventDefault();openRef($('#wh-qr-input').value);});
$('#wh-search-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!authenticated())return;
 try{renderSearch(await client.search(org(),$('#wh-search').value.trim()));}catch(error){fail(error);}
});
$('#wh-queue-refresh').addEventListener('click',refreshQueue);
$('#wh-catalogue-query').addEventListener('input',catalogueResults);
$('#wh-catalogue-select').addEventListener('change',catalogueOptions);
$('#wh-catalogue-use').addEventListener('click',useCatalogue);
$('#wh-order-select').addEventListener('change',showOrder);
$('#wh-delta').addEventListener('input',preview);
$('#wh-reason').addEventListener('input',event=>{event.target.dataset.auto='0';preview();});
$('#wh-print').addEventListener('click',()=>{if(current?.sku?.qrToken&&typeof window.QRCode==='function')window.print();});
$('#wh-camera-start').addEventListener('click',startCamera);
$('#wh-camera-stop').addEventListener('click',stopCamera);
$('#wh-move-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!authenticated()||busy||!current?.sku)return;
 const token=current.sku.qrToken,delta=Core.parseSigned($('#wh-delta').value),reason=$('#wh-reason').value.trim();
 const line=(current.orders||[]).find(x=>x.lineId===selectedLineId)||null;
 try{Core.preview({sku:current.sku,line,amount:delta,reason:line?'delivery':delta>0?'receipt':'adjustment'});}
 catch(error){return fail(error);}
 if(reason.length<3)return fail(Error('Indique le motif de la sortie ou réception.'));
 busy=true;$('#wh-submit').disabled=true;status('Confirmation serveur… ne recommence pas la sortie.');
 try{
  const result=await client.move({org:org(),token,lineId:line?.lineId||null,delta,reason});
  status((result.replayed?'Mouvement déjà confirmé : ':'Mouvement enregistré : ')+
    (delta>0?'+':'')+fmt(delta)+' '+current.sku.unit+
    (result.remainingAfter!==null&&result.remainingAfter!==undefined?' · '+fmt(result.remainingAfter)+' reste à livrer':''));
  await openRef(token,{lineId:line?.lineId||''});await refreshQueue();
  $('#wh-delta').value='';
 }catch(error){fail(error);}
 finally{busy=false;preview();}
});
$('#wh-register-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!activeOrg()?.isAdmin)return fail(Error('Admin MIR requis pour créer une fiche.'));
 const values=new FormData(event.currentTarget);
 try{
  const result=await client.register(org(),{kind:values.get('kind'),sourceRef:String(values.get('sourceRef')||'').trim(),
   sku:String(values.get('sku')||'').trim(),name:String(values.get('name')||'').trim(),
   unit:String(values.get('unit')||'').trim(),step:Number(values.get('step'))});
  status('Référence enregistrée avec son QR permanent : '+result.sku);
  event.currentTarget.reset();await openRef(result.qrToken);
 }catch(error){fail(error);}
});
window.addEventListener('pagehide',stopCamera);
bootstrap();
})();