/* MIR Entrepôt — tableau de bord de préparation.
 * Complément du traceur QR existant : aucune écriture de stock ici.
 * Les RPC Coord/Entrepôt contrôlent rôles, scans et expédition.
 */
(function(){
 'use strict';
 const $=s=>document.querySelector(s);
 const fmt=v=>new Intl.NumberFormat('fr-CA',{maximumFractionDigits:3}).format(Number(v)||0);
 const node=(tag,t='',parent)=>{const x=document.createElement(tag);x.textContent=String(t??'');if(parent)parent.append(x);return x;};
 let api=null,orgId=null,orders=[],inFlight=false,active=false,lastRevision=new Map();
 const root=$('#wh-coordination-tasks'),count=$('#wh-unread-count'),legacy=$('#wh-queue')?.closest('.wh-card');
 if(!root||!count||!window.MIRWarehouseClient)return;
 const status=s=>{const el=$('#wh-status');if(el)el.textContent=String(s||'');};
 function clear(){root.replaceChildren();count.textContent='0';orders=[];active=false;document.body.dataset.coordination='unavailable';if(legacy)legacy.hidden=false;}
 function banner(text){root.replaceChildren();node('p',text,root).className='wh-coordination-empty';}
 function render(){
  root.replaceChildren();
  const unread=orders.reduce((n,o)=>n+(o.unread||[]).length,0);count.textContent=String(unread);
  if(!orders.length){banner('Aucune commande Entrepôt active. Les expédiées sont classées automatiquement.');return;}
  for(const order of orders){
   const card=node('article','',root);card.className='wh-coordination-card';card.dataset.coOrder=order.id;
   node('h3','Commande '+String(order.sourceOrderId||order.id).slice(0,14),card);
   node('p','Job : '+(order.job||'À préciser')+' · Équipe : '+(order.team||'À préciser'),card);
   node('p','Livraison : '+(order.address||'À préciser'),card).className='wh-coordination-address';
   for(const event of order.unread||[]){
    const notice=node('div','',card);notice.className='wh-coordination-notice';
    node('strong',event.type==='quantity_added'?'Commande modifiée — matériel ajouté':
      event.type==='routed'?'Répartition modifiée':'Chantier ou commande modifiés',notice);
    node('span',event.type==='quantity_added'?'+ '+fmt(event.payload?.delta)+' '+(event.payload?.unit||'')+
     ' '+(event.payload?.name||'article')+' · Commande '+String(order.sourceOrderId||'').slice(0,12):
      'Nouvelle révision '+fmt(event.revision)+' à vérifier',notice);
   }
   const list=node('div','',card);list.className='wh-coordination-lines';
   for(const line of order.lines||[]){
    const row=node('div','',list);row.className='wh-coordination-line';
    const copy=node('div','',row);node('strong',line.name||'Article MIR',copy);
    node('small','Préparés '+fmt(line.pickedQty)+' / '+fmt(line.requestedQty)+
      ' '+(line.unit||'')+' · reste '+fmt(line.remainingQty),copy);
    const action=node('button','Scanner',row);action.dataset.coScan=line.qrToken||'';
    action.dataset.coLine=line.sourceLineId||'';
    if(!line.qrToken){action.disabled=true;action.title='L’Admin doit relier la variante exacte au QR';}
   }
   const actions=node('div','',card);actions.className='wh-coordination-actions';
   const ack=node('button',(order.unread||[]).length?'J’ai pris connaissance':'Modifications lues',actions);
   ack.dataset.coAck=order.id;ack.disabled=!(order.unread||[]).length;
   const ship=node('button','Commande expédiée',actions);ship.dataset.coShip=order.id;ship.className='wh-ship';
   ship.disabled=(order.unread||[]).length>0||!(order.lines||[]).length||
     (order.lines||[]).some(l=>Number(l.remainingQty)!==0);
   if(ship.disabled)ship.title='Confirme les modifications et prépare toutes les lignes avant d’expédier';
  }
 }
 async function poll(){
  const workspace=$('#wh-workspace');
  if(!workspace||workspace.hidden||document.visibilityState==='hidden'||inFlight)return;
  const chosen=$('#wh-org')?.value;if(!chosen)return;
  try{
   if(!api)api=window.MIRWarehouseClient.create({sdk:window.MIRSupabase,
    config:window.MIRSharedConfig,storage:sessionStorage});
   const next=await api.coordinationQueue(chosen);
   if(!Array.isArray(next))throw Error('File de préparation non reconnue');
   const changes=next.filter(o=>(o.unread||[]).length>0&&
     Number(o.revision)>Number(lastRevision.get(o.id)||0));
   orders=next;orgId=chosen;active=true;document.body.dataset.coordination='active';
   if(legacy)legacy.hidden=true;
   for(const o of orders)lastRevision.set(o.id,Number(o.revision)||0);
   render();
   if(changes.length)status('Entrepôt : '+changes.length+
     ' commande(s) avec des modifications à lire (ex. +3 Mono).');
  }catch(error){
   // Ne jamais simuler une expédition lorsque la base ou l'Auth ne répond pas.
   clear();
   banner('Coordination Entrepôt non activée ou accès refusé : '+error.message);
  }
 }
 async function scan(row){
  if(!row?.dataset.coScan)return;
  const qr=$('#wh-qr-input'),form=$('#wh-scan-form');
  if(!qr||!form)return;
  qr.value=row.dataset.coScan;
  form.requestSubmit();
  const lineId=row.dataset.coLine;
  if(!lineId)return;
  // Le module inventaire charge la fiche après sa propre requête authentifiée.
  for(let i=0;i<22;i++){
   await new Promise(resolve=>setTimeout(resolve,170));
   const select=$('#wh-order-select');if(!select)return;
   if([...select.options].some(o=>o.value===lineId)){
    select.value=lineId;select.dispatchEvent(new Event('change',{bubbles:true}));break;
   }
  }
 }
 async function act(button){
  if(inFlight||!active||!orgId)return;
  const card=button.closest('[data-co-order]'),order=orders.find(o=>o.id===card?.dataset.coOrder);
  if(!order)return;
  if(button.dataset.coAck){
   inFlight=true;
   try{await api.acknowledge(orgId,order.id);status('Modifications reconnues pour la commande '+String(order.sourceOrderId).slice(0,12));await pollFresh();}
   catch(error){status('Accusé non confirmé : '+error.message);}finally{inFlight=false;}
  }
  if(button.dataset.coShip){
   if((order.unread||[]).length||!(order.lines||[]).length||(order.lines||[]).some(l=>Number(l.remainingQty)!==0))
    return status('Préparation incomplète ou modifications non lues.');
   if(!window.confirm('Confirmer l’expédition Entrepôt ? Le stock déjà scanné ne sera pas déduit une seconde fois.'))return;
   inFlight=true;
   try{
    await api.ship(orgId,order.id,Number(order.revision));
    status('Expédition confirmée : la tâche Entrepôt est classée. Les fournisseurs sont suivis à part.');
    await pollFresh();
   }catch(error){status('Départ non confirmé : '+error.message);}finally{inFlight=false;}
  }
 }
 async function pollFresh(){
  const old=inFlight;inFlight=false;
  try{await poll();}finally{inFlight=old;}
 }
 root.addEventListener('click',event=>{
  const b=event.target.closest('button');if(!b)return;
  if(b.dataset.coScan!==undefined){void scan(b);return;}
  if(b.dataset.coAck||b.dataset.coShip)void act(b);
 });
 $('#wh-refresh')?.addEventListener('click',()=>void poll());
 $('#wh-queue-refresh')?.addEventListener('click',()=>void poll());
 $('#wh-org')?.addEventListener('change',()=>{clear();lastRevision.clear();void poll();});
 $('#wh-signout')?.addEventListener('click',()=>{clear();api?.close?.();api=null;});
 // L'écran Entrepôt existant reste maître de la session et du scan QR.
 const loop=setInterval(poll,18000);
 window.addEventListener('pagehide',()=>{clearInterval(loop);api?.close?.();});
 void poll();
})();
