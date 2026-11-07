/* MIR Coordination — adjointe et Admin. Chaque action est une RPC sécurisée.
 * Le navigateur n'invente jamais de stock, fournisseur ou état de livraison.
 */
(function(){
'use strict';
const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>new Intl.NumberFormat('fr-CA',{maximumFractionDigits:3}).format(Number(n)||0);
const CLIENT=window.MIRCoordinationClient;
let api=null,orgs=[],inbox=[],detail=null,suppliers=[],busy=false,filter='all',poller=null,sessionReady=false;
const status=v=>{$('#co-status').textContent=String(v||'');};
const toast=v=>{$('#co-toast').textContent=String(v||'');};
const org=()=>$('#co-organization')?.value;
const err=e=>{status(e?.message||String(e));toast(e?.message||String(e));};
const pending=()=>busy;
function locked(flag){
 busy=!!flag;document.querySelectorAll('button[data-co-action],button[data-co-save]').forEach(b=>b.disabled=busy);
}
function signedOut(){
 sessionReady=false;detail=null;inbox=[];suppliers=[];orgs=[];
 $('#co-workspace').hidden=true;$('#co-login').hidden=false;$('#co-detail').hidden=true;
 $('#co-none').hidden=false;
}
function visibleOrg(){return orgs.find(x=>x.id===org());}
async function session(){
 if(!api)return signedOut();
 try{
  orgs=(await api.memberships()).filter(x=>x.assistant||x.admin);
  if(!orgs.length)throw Error('Accès Adjointe non autorisé pour ce compte MIR.');
  $('#co-organization').replaceChildren();
  for(const row of orgs){const option=document.createElement('option');option.value=row.id;option.textContent=row.name;$('#co-organization').append(option);}
  sessionReady=true;$('#co-login').hidden=true;$('#co-workspace').hidden=false;
  status('Coordination MIR connectée · toutes les écritures passent par le serveur.');
  await refresh({initial:true});
 }catch(error){signedOut();err(error);}
}
function sum(line,lane){
 return (line.routes||[]).filter(r=>r.lane===lane).reduce((n,r)=>n+Number(r.quantity||0),0);
}
function summary(row){
 const lines=row.lines||[],total=lines.reduce((n,l)=>n+Number(l.requestedQty||0),0);
 const warehouse=lines.reduce((n,l)=>n+sum(l,'warehouse'),0);
 const external=lines.reduce((n,l)=>n+sum(l,'supplier'),0);
 const received=lines.reduce((n,l)=>n+(l.routes||[]).filter(r=>r.lane==='supplier').reduce((m,r)=>m+Number(r.receivedQty||0),0),0);
 const picked=lines.reduce((n,l)=>n+(l.routes||[]).filter(r=>r.lane==='warehouse').reduce((m,r)=>m+Number(r.pickedQty||0),0),0);
 const unassigned=total-warehouse-external;
 const supplierHasPO=lines.every(l=>(l.routes||[]).filter(r=>r.lane==='supplier').every(r=>!!r.supplierOrderId));
 const warehouseShipped=warehouse===0||!!row.shippedAt;
 return {total,warehouse,external,received,picked,unassigned,supplierHasPO,warehouseShipped,
  complete:unassigned===0&&warehouseShipped&&received===external&&supplierHasPO,
  warehouseReady:warehouse>0&&picked===warehouse&&!row.shippedAt};
}
function renderInbox(){
 const needle=$('#co-search').value.trim().toLowerCase(),rows=inbox.filter(x=>
  (!needle||[x.sourceOrderId,x.id,x.job,x.address,x.team].some(v=>String(v||'').toLowerCase().includes(needle)))&&
  (filter==='all'||filter==='new'&&!x.id||filter==='shipped'&&x.status==='warehouse_shipped'));
 $('#co-count').textContent=rows.length;
 $('#co-orders').innerHTML=rows.length?rows.map(row=>
  '<button type="button" class="co-order" data-co-open="'+esc(row.sourceOrderId)+'" aria-current="'+String(detail?.sourceOrderId===row.sourceOrderId)+'">'+
  '<strong>Commande '+esc(String(row.sourceOrderId||'').slice(0,13))+'</strong>'+
  '<small>'+esc(row.job||'Chantier à préciser')+' · '+esc(row.team||'Équipe à préciser')+'</small>'+
  '<small>'+esc(row.address||'Adresse à compléter')+'</small>'+
  '<em>'+esc(row.status==='new'?'À répartir':row.status==='warehouse_shipped'?'Entrepôt expédié':'En traitement')+
  ' · '+fmt(row.lineCount)+' ligne(s)</em></button>').join(''):
 '<p>Aucune commande dans cette vue.</p>';
}
async function refresh({initial=false}={}){
 if(!sessionReady||!org())return;
 try{
  const next=await api.inbox(org());inbox=Array.isArray(next)?next:[];
  renderInbox();
  if(initial||!detail)await suppliersForOrg();
  if(!initial&&detail&&!busy&&!document.querySelector('#co-detail :focus:is(input,select,textarea)')){
   const row=inbox.find(x=>x.id===detail.id);
   if(row&&Number(row.revision)>Number(detail.revision))status('La commande a été modifiée ailleurs. Actualise pour voir les nouvelles quantités avant de confirmer.');
  }
 }catch(error){err(error);}
}
async function suppliersForOrg(){
 try{const out=await api.suppliers(org());suppliers=Array.isArray(out)?out:[];}
 catch(error){suppliers=[];status('Les fournisseurs ne sont pas encore disponibles : '+error.message);}
}
function supplierOptions(value=''){
 return '<option value="">Sélectionner un fournisseur</option>'+suppliers.map(x=>
  '<option value="'+esc(x.id)+'"'+(value===x.id?' selected':'')+'>'+esc(x.name)+(x.verified?'':' · Contact à vérifier')+'</option>').join('');
}
function linkedPo(route){
 if(route.lane!=='supplier')return '';
 const id=route.id||'',supplier=suppliers.find(s=>s.id===route.supplierId);
 const saved=route.supplierOrderId,production=route.productionStatus||'to_order';
 const labels={to_order:'À commander',ordered:'Commandé',in_production:'En production externe',
  ready:'Prêt chez fournisseur',received_partial:'Réception partielle',received:'Tout reçu'};
 const selector=Number(route.receivedQty||0)>0?'':'<label>État fournisseur<select data-co-production-status="'+esc(id)+'">'+
  [['ordered','Commandé'],['in_production','En production'],['ready','Prêt à recevoir']].map(([v,label])=>
  '<option value="'+v+'"'+(production===v?' selected':'')+'>'+label+'</option>').join('')+
  '</select></label><button type="button" data-co-action="supplier-state" data-route="'+esc(id)+'">Mettre à jour</button>';
 return '<div class="co-route-po" data-co-po-route="'+esc(id)+'"><strong>'+esc(supplier?.name||route.supplierId||'Fournisseur')+
  ' · '+fmt(route.quantity)+' · reçu '+fmt(route.receivedQty||0)+'</strong>'+
  '<span class="co-badge">'+esc(labels[production]||'À confirmer')+'</span>'+
  (saved?
   '<span class="co-badge">Bon '+esc(String(saved).slice(0,13))+'</span>'+
   selector+
   (Number(route.receivedQty||0)<Number(route.quantity)?
   '<label>Réception<input type="number" min="1" step="1" data-co-receipt="'+esc(id)+'" placeholder="Quantité"></label><button type="button" data-co-action="receive" data-route="'+esc(id)+'">Recevoir</button>':''):
   '<button type="button" data-co-action="po" data-route="'+esc(id)+'">Créer un bon</button>'+
   '<label>Ou bon existant<select data-co-existing-po="'+esc(id)+'"><option value="">Choisir après recherche</option></select></label>'+
   '<button type="button" data-co-action="existing-po" data-route="'+esc(id)+'">Ajouter à ce bon</button>'
  )+'</div>';
}
function supplierRow(lineId,{supplierId='',quantity=0}={}){
 return '<div class="co-external-row"><label>Fournisseur<select data-co-supplier>'+supplierOptions(supplierId)+'</select></label>'+
 '<label>Quantité<input type="number" min="1" step="1" data-co-supplier-qty value="'+esc(quantity||'')+'"></label>'+
 '<button type="button" data-co-action="remove-supplier">×<span class="sr-only">Retirer ce fournisseur</span></button></div>';
}
function renderLine(item){
 const routes=item.routes||[],wh=routes.find(r=>r.lane==='warehouse'),ext=routes.filter(r=>r.lane==='supplier');
 const external=ext.reduce((n,r)=>n+Number(r.quantity||0),0),assigned=external+Number(wh?.quantity||0),unassigned=Number(item.requestedQty)-assigned;
 return '<article class="co-line" data-co-line="'+esc(item.id)+'">'+
 '<h4>'+esc(item.name||'Matériel')+'</h4><div class="co-line-meta"><span>Demandé : <strong>'+fmt(item.requestedQty)+'</strong> '+esc(item.unit)+'</span>'+
 '<span>Entrepôt : <strong>'+fmt(wh?.quantity||0)+'</strong></span>'+
 '<span>À commander : <strong>'+fmt(external)+'</strong></span>'+
 '<span>À répartir : <strong>'+fmt(unassigned)+'</strong></span></div>'+
 '<form data-co-route-form="'+esc(item.id)+'"><div class="co-route-grid">'+
 '<label>Quantité Entrepôt<input type="number" step="1" min="0" max="'+esc(item.requestedQty)+'" name="warehouse" value="'+esc(wh?.quantity||0)+'" required></label>'+
 '<label>À commander<output>'+fmt(external)+'</output></label>'+
 '<div><span class="co-route-label">Fournisseur(s) externe(s)</span><div class="co-suppliers-list">'+
  (ext.length?ext.map(r=>supplierRow(item.id,{supplierId:r.supplierId,quantity:r.quantity})).join(''):supplierRow(item.id))+
 '</div><button type="button" data-co-action="add-supplier">+ Fournisseur</button></div></div>'+
 '<div class="co-route-actions"><span class="co-small">Une ligne de bon déjà créée ne peut pas être effacée silencieusement.</span>'+
 '<button type="submit" class="co-primary" data-co-save>Enregistrer la répartition</button></div></form>'+
 (ext.some(r=>r.supplierOrderId)?'<div class="co-routes-summary">'+ext.map(linkedPo).join('')+'</div>':
  ext.length?'<div class="co-routes-summary">'+ext.map(linkedPo).join('')+'</div>':'')+
 '<div class="co-inline-add"><label>Ajout avant expédition (ex. +3 Mono)<input type="number" min="1" step="1" data-co-add-qty placeholder="+3"></label>'+
 '<button type="button" data-co-action="add" data-line="'+esc(item.id)+'">Ajouter à la commande</button>'+
 '<p class="co-small">L’ajout garde l’ancienne ligne intacte, crée une nouvelle ligne et notifie l’entrepôt. À répartir ensuite.</p></div>'+
 '</article>';
}
async function fillExistingPOs(){
 if(!detail||!api?.supplierOrders)return;
 const version=detail.id+':'+detail.revision,routeById=new Map(
  (detail.lines||[]).flatMap(l=>l.routes||[]).map(r=>[r.id,r]));
 const selected=[...document.querySelectorAll('#co-line-list select[data-co-existing-po]')],cache=new Map();
 for(const select of selected){
  const route=routeById.get(select.dataset.coExistingPo);if(!route?.supplierId)continue;
  try{
   if(!cache.has(route.supplierId))cache.set(route.supplierId,api.supplierOrders(org(),route.supplierId));
   const rows=await cache.get(route.supplierId);
   if(!detail||detail.id+':'+detail.revision!==version||!select.isConnected)return;
   select.replaceChildren();const empty=document.createElement('option');empty.value='';
   empty.textContent='Choisir un bon existant';select.append(empty);
   for(const row of Array.isArray(rows)?rows:[]){
    const opt=document.createElement('option');opt.value=row.id;
    opt.textContent=(row.number||String(row.id||'').slice(0,12))+' · '+(row.job||'Chantier à préciser');
    select.append(opt);
   }
  }catch(error){if(select.isConnected)select.title='Bons non disponibles : '+error.message;}
 }
}
function renderDetail(){
 if(!detail)return;
 $('#co-none').hidden=true;$('#co-detail').hidden=false;
 const sum=summary(detail);
 $('#co-order-heading').textContent='Commande '+String(detail.sourceOrderId||detail.id).slice(0,15);
 $('#co-overall-status').textContent=sum.complete?'Commande complétée':
  detail.shippedAt?'Entrepôt expédié · fournisseur(s) en cours':
   sum.unassigned>0?'En attente de répartition':'Préparation et bons en cours';
 $('#co-metrics').innerHTML=[
 ['Commandés',sum.total],['Entrepôt',sum.warehouse],['À commander',sum.external],['Non répartis',sum.unassigned]
 ].map(([label,num])=>'<div><span>'+label+'</span><strong>'+fmt(num)+'</strong></div>').join('');
 const form=$('#co-meta');form.elements.job.value=detail.job||'';form.elements.team.value=detail.team||'';
 form.elements.address.value=detail.address||'';form.elements.priority.value=detail.priority||'normal';form.elements.notes.value=detail.notes||'';
 $('#co-line-list').innerHTML=(detail.lines||[]).map(renderLine).join('')||'<p>Aucune ligne à répartir.</p>';
 $('#co-detail').dataset.shipped=String(!!detail.shippedAt);
 document.querySelectorAll('#co-detail [data-co-save],#co-detail [data-co-action="add"]').forEach(b=>b.disabled=!!detail.shippedAt);
 const events=(detail.events||[]).slice().sort((a,b)=>Number(b.revision)-Number(a.revision));
 $('#co-events').innerHTML=events.map(e=>'<div class="co-event"><strong>'+esc(e.type)+'</strong> · R'+fmt(e.revision)+
 '<time>'+esc(e.at?new Date(e.at).toLocaleString('fr-CA'):'')+'</time>'+
 (e.type==='quantity_added'?'<span class="co-badge">Ajout +'+fmt(e.payload?.delta)+' '+esc(e.payload?.unit)+' '+esc(e.payload?.name)+'</span>':'')+
 '</div>').join('')||'Aucun événement.';
 $('#co-pos').innerHTML=(detail.lines||[]).flatMap(l=>(l.routes||[]).filter(r=>r.lane==='supplier'&&r.supplierOrderId).map(r=>
 '<div class="co-event"><strong>'+esc(suppliers.find(s=>s.id===r.supplierId)?.name||'Fournisseur')+'</strong>'+
 '<small> Bon '+esc(String(r.supplierOrderId).slice(0,13))+' · '+fmt(r.quantity)+' '+esc(l.unit)+
 ' · reçu '+fmt(r.receivedQty||0)+'</small></div>')).join('')||'<p class="co-small">Aucun bon fournisseur créé.</p>';
 $('#co-notifications').innerHTML=events.filter(e=>e.type==='quantity_added'||e.type==='routed').slice(0,9)
 .map(e=>'<div class="co-event"><strong>'+esc(e.type==='quantity_added'?'Ajout de matériel':'Répartition modifiée')+'</strong>'+
 '<p>'+esc(e.payload?.name||'Commande')+(e.type==='quantity_added'?' +'+fmt(e.payload?.delta)+' '+esc(e.payload?.unit):'')+'</p></div>').join('')||'<p>Aucun changement à communiquer.</p>';
 $('#co-meta').querySelector('button').disabled=!!detail.shippedAt;
 $('#co-overall-status').className='co-badge';
 void fillExistingPOs();
}
async function openOrder(sourceOrderId){
 if(!sessionReady||busy)return;locked(true);status('Lecture de la commande et de ses références…');
 try{
  const from=inbox.find(row=>row.sourceOrderId===sourceOrderId);if(!from)throw Error('Commande à actualiser.');
  const selected=from.id||((await api.open(org(),sourceOrderId))||{}).id;
  if(!selected)throw Error('Impossible d’ouvrir les lignes serveur de cette commande.');
  detail=await api.detail(org(),selected);
  renderDetail();renderInbox();status('Commande chargée. Répartis une ligne puis confirme.');
 }catch(error){err(error);}
 finally{locked(false);}
}
async function detailReload(){if(!detail)return;const id=detail.id;detail=await api.detail(org(),id);renderDetail();await refresh();}
async function actionRun(action){
 if(!detail||busy)return;
 const id=detail.id,rev=detail.revision,source=action.closest('[data-co-line]'),lineId=source?.dataset.coLine,routeId=action.dataset.route;
 locked(true);status('Enregistrement sécurisé de la modification…');
 try{
  let response;
  if(action.dataset.coAction==='add'){
   const amount=Number(source.querySelector('[data-co-add-qty]').value);response=await api.add(org(),id,lineId,amount,rev);
  }else if(action.dataset.coAction==='po'||action.dataset.coAction==='existing-po'){
   const po=action.dataset.coAction==='existing-po'?action.closest('.co-route-po')?.querySelector('[data-co-existing-po]')?.value||null:null;
   if(action.dataset.coAction==='existing-po'&&!po)throw Error('Choisis un bon fournisseur existant.');
   response=await api.linkPO(org(),id,routeId,po,rev);
  }else if(action.dataset.coAction==='receive'){
   const amount=Number(action.closest('.co-route-po')?.querySelector('[data-co-receipt]')?.value);
   response=await api.supplierReceive(org(),id,routeId,amount,rev);
  }else if(action.dataset.coAction==='supplier-state'){
   const value=action.closest('.co-route-po')?.querySelector('[data-co-production-status]')?.value;
   if(!['ordered','in_production','ready'].includes(value))throw Error('Choisis un état fournisseur valide.');
   response=await api.supplierStatus(org(),id,routeId,value,rev);
  }else return;
  status('Modification conservée côté serveur. Révision '+fmt(response.revision||rev)+'.');
  await detailReload();
 }catch(error){err(error);}
 finally{locked(false);}
}
async function routeForm(form){
 if(!detail||busy)return;
 const lineId=form.dataset.coRouteForm,l=(detail.lines||[]).find(l=>l.id===lineId);
 if(!l)return;
 const warehouseQty=Number(form.elements.warehouse.value);
 const supplierRows=[...form.querySelectorAll('.co-external-row')].map(row=>({
  supplierId:row.querySelector('[data-co-supplier]')?.value||'',quantity:Number(row.querySelector('[data-co-supplier-qty]')?.value||0)
 })).filter(row=>row.supplierId||row.quantity);
 if(supplierRows.some(x=>!x.supplierId||x.quantity<=0))return err(Error('Fournisseur et quantité requis sur chaque ligne externe.'));
 if(warehouseQty+supplierRows.reduce((n,r)=>n+r.quantity,0)>Number(l.requestedQty))
  return err(Error('La somme Entrepôt et Fournisseurs dépasse la quantité demandée.'));
 locked(true);try{
  const output=await api.route(org(),detail.id,lineId,warehouseQty,supplierRows,detail.revision);
  status('Répartition enregistrée · révision '+output.revision);
  await detailReload();
 }catch(error){err(error);}finally{locked(false);}
}
async function metaForm(form){
 if(!detail||busy)return;
 const d=new FormData(form),values=Object.fromEntries(['job','address','team','priority','notes'].map(k=>[k,String(d.get(k)||'')]));
 locked(true);try{await api.metadata(org(),detail.id,detail.revision,values);await detailReload();status('Chantier et livraison mis à jour pour l’entrepôt.');}
 catch(error){err(error);}finally{locked(false);}
}
function bind(){
 $('#co-login-form').addEventListener('submit',async e=>{
  e.preventDefault();const data=new FormData(e.currentTarget),button=e.currentTarget.querySelector('button');
  button.disabled=true;try{
   orgs=await api.login(String(data.get('email')||''),String(data.get('password')||''));
   e.currentTarget.elements.password.value='';await session();
  }catch(error){signedOut();err(error);}finally{button.disabled=false;}
 });
 $('#co-signout').addEventListener('click',async()=>{try{await api.logout();signedOut();status('Déconnecté de la coordination MIR.');}catch(error){err(error);}});
 $('#co-refresh').addEventListener('click',()=>refresh());
 $('#co-order-reload').addEventListener('click',()=>detailReload().catch(err));
 $('#co-organization').addEventListener('change',async()=>{detail=null;$('#co-detail').hidden=true;$('#co-none').hidden=false;await suppliersForOrg();await refresh();});
 $('#co-search').addEventListener('input',renderInbox);
 document.querySelector('.co-filters').addEventListener('click',e=>{const b=e.target.closest('[data-co-filter]');if(!b)return;filter=b.dataset.coFilter;
  document.querySelectorAll('[data-co-filter]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));renderInbox();});
 $('#co-orders').addEventListener('click',e=>{const b=e.target.closest('[data-co-open]');if(b)openOrder(b.dataset.coOpen);});
 $('#co-line-list').addEventListener('click',e=>{
  const b=e.target.closest('[data-co-action]');if(!b||busy)return;
  if(b.dataset.coAction==='add-supplier'){const form=b.closest('form'),list=form.querySelector('.co-suppliers-list');if(list.querySelectorAll('.co-external-row').length<20)list.insertAdjacentHTML('beforeend',supplierRow(''));return;}
  if(b.dataset.coAction==='remove-supplier'){b.closest('.co-external-row')?.remove();return;}
  void actionRun(b);
 });
 $('#co-line-list').addEventListener('submit',e=>{const form=e.target.closest('[data-co-route-form]');if(!form)return;e.preventDefault();routeForm(form);});
 $('#co-meta').addEventListener('submit',e=>{e.preventDefault();metaForm(e.currentTarget);});
}
async function bootstrap(){
 bind();
 if(!CLIENT||!window.MIRSupabase){signedOut();return status('Client sécurisé MIR indisponible.');}
 try{api=CLIENT.create({sdk:window.MIRSupabase,config:window.MIRSharedConfig,storage:sessionStorage});
  await session();
  poller=setInterval(()=>{if(sessionReady&&!busy&&document.visibilityState==='visible')void refresh();},30000);
 }catch(error){signedOut();status(error.message);}
}
window.addEventListener('pagehide',()=>{clearInterval(poller);api?.close?.();});
bootstrap();
})();