/* MIR — coordination des commandes : modèle métier pur, sans réseau ni stock local. */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.MIROrderCoordination=api;})(typeof globalThis==='object'?globalThis:null,function(){
'use strict';
const copy=v=>JSON.parse(JSON.stringify(v)),name=v=>String(v??'').trim();
const fail=(code,message)=>{const e=new Error(message);e.code=code;throw e;};
const qty=(n,allowZero=false)=>{n=Number(n);if(!Number.isSafeInteger(n)||n>(100000)||(allowZero?n<0:n<=0))fail('QUANTITY','Quantité entière valide requise');return n;};
function line(o,id){const r=(o.lines||[]).find(x=>x.id===id);if(!r)fail('LINE_UNKNOWN','Ligne de commande inconnue');return r;}
function editable(o){if(o.warehouse?.shippedAt)fail('SHIPPED','La commande a été expédiée : créer une demande complémentaire');if(o.cancelledAt)fail('CANCELLED','Commande annulée');}
function make({id,job='',address='',team='',requestedBy='',lines=[]}){
 if(!name(id)||!Array.isArray(lines)||!lines.length)fail('ORDER','Commande employé et lignes nécessaires');
 const ids=new Set();
 const entries=lines.map(x=>{const item=name(x.id);if(!item||ids.has(item)||!name(x.sku))fail('LINE_ID','Ligne dupliquée ou sans SKU');ids.add(item);
 return {id:item,sku:name(x.sku),name:name(x.name)||name(x.sku),unit:name(x.unit)||'pièce',requestedQty:qty(x.quantity),warehouseQty:0,pickedQty:0,supplierRoutes:[],sourceLineId:name(x.sourceLineId)||item};});
 return {id:name(id),job:name(job),address:name(address),team:name(team),requestedBy:name(requestedBy),
  revision:1,lines:entries,warehouse:{ackRevision:0,shippedAt:null,shippedBy:null},events:[{revision:1,type:'received',message:'Demande reçue'}],requests:{},cancelledAt:null};
}
function idempotency(o,requestId,payload){if(!name(requestId))fail('IDEMPOTENCY_KEY','Identifiant unique requis');const signature=JSON.stringify(payload),prior=o.requests[requestId];if(prior){if(prior.signature!==signature)fail('IDEMPOTENCY_CONFLICT','Référence réutilisée pour un autre mouvement');return {order:copy(o),result:copy(prior.result),replayed:true};}return signature;}
function change(o,requestId,signature,type,message,apply,extra={}){
 const next=copy(o);apply(next);next.revision++;
 const result={revision:next.revision,...copy(extra)};
 next.requests[requestId]={signature,result};next.events.push({revision:next.revision,type,message,...copy(extra)});
 return {order:next,result,replayed:false};
}
const allocated=l=>l.warehouseQty+l.supplierRoutes.reduce((n,r)=>n+r.quantity,0);
function route(o,id,{warehouseQty=0,suppliers=[]},requestId){
 editable(o);const current=line(o,id),w=qty(warehouseQty,true);if(w<current.pickedQty)fail('PICKED','Déjà préparé en entrepôt');
 if(!Array.isArray(suppliers)||suppliers.length>20)fail('SUPPLIERS','Fournisseurs invalides');
 const seen=new Set(),routes=suppliers.map(x=>{const supplierId=name(x.supplierId),q=qty(x.quantity);if(!supplierId||seen.has(supplierId))fail('SUPPLIER_DUPLICATE','Fournisseur dupliqué');seen.add(supplierId);
 const old=current.supplierRoutes.find(r=>r.supplierId===supplierId);if(old&&q<old.receivedQty)fail('RECEIVED','Quantité déjà reçue');if(old?.poId&&name(x.poId)&&name(x.poId)!==old.poId)fail('PO_LOCKED','Bon fournisseur déjà lié');
 return {supplierId,quantity:q,poId:name(x.poId)||old?.poId||null,receivedQty:old?.receivedQty||0};});
 if(current.supplierRoutes.some(r=>!routes.some(x=>x.supplierId===r.supplierId)&&r.receivedQty>0))fail('RECEIVED','Une ligne fournisseur déjà reçue ne peut pas être retirée');
 if(current.supplierRoutes.some(r=>!routes.some(x=>x.supplierId===r.supplierId)&&r.poId))fail('PO_LOCKED','Retirer d’abord le lien au bon fournisseur par une révision explicite');
 if(w+routes.reduce((n,r)=>n+r.quantity,0)>current.requestedQty)fail('OVER_ALLOCATED','La répartition dépasse la commande');
 const signature=idempotency(o,requestId,{action:'route',id,w,routes});if(typeof signature==='object')return signature;
 return change(o,requestId,signature,'routed','Répartition '+current.name,next=>{const l=line(next,id);l.warehouseQty=w;l.supplierRoutes=routes;},{lineId:id,unassigned:current.requestedQty-w-routes.reduce((n,r)=>n+r.quantity,0)});
}
function amend(o,id,delta,requestId,{actor='Adjointe'}={}){
 editable(o);const r=line(o,id),amount=qty(delta),signature=idempotency(o,requestId,{action:'add',id,amount});if(typeof signature==='object')return signature;
 return change(o,requestId,signature,'quantity_added','Commande #'+o.id+' modifiée : +'+amount+' '+r.unit+' '+r.name,next=>{line(next,id).requestedQty+=amount;},
 {lineId:id,delta:amount,oldQty:r.requestedQty,newQty:r.requestedQty+amount,actor});
}
function ack(o,actor){editable(o);if(!name(actor))fail('ACTOR','Préparateur requis');const next=copy(o);next.warehouse.ackRevision=next.revision;return next;}
function pick(o,id,quantity,requestId){editable(o);const r=line(o,id),n=qty(quantity);if(n>r.warehouseQty-r.pickedQty)fail('OVER_PICK','Plus de pièces scannées que prévu');const signature=idempotency(o,requestId,{action:'pick',id,n});if(typeof signature==='object')return signature;
 return change(o,requestId,signature,'picked','Préparé : '+n+' '+r.name,next=>{line(next,id).pickedQty+=n;},{lineId:id,quantity:n,stockDelta:-n});}
function linkPO(o,id,supplierId,poId,requestId){editable(o);const r=line(o,id),supplier=name(supplierId),po=name(poId),route=r.supplierRoutes.find(x=>x.supplierId===supplier);
 if(!po||!route)fail('PO_ROUTE','Fournisseur ou bon non affecté');if(route.poId&&route.poId!==po)fail('PO_LOCKED','Un autre bon est déjà lié');
 const signature=idempotency(o,requestId,{action:'po',id,supplier,po});if(typeof signature==='object')return signature;
 return change(o,requestId,signature,'po_linked','Bon '+po+' : '+r.name,next=>{line(next,id).supplierRoutes.find(x=>x.supplierId===supplier).poId=po;},{lineId:id,supplierId:supplier,poId:po});}
function supplierReceived(o,id,supplierId,quantity,requestId){const r=line(o,id),supplier=name(supplierId),amount=qty(quantity),route=r.supplierRoutes.find(x=>x.supplierId===supplier);
 if(!route?.poId)fail('PO_REQUIRED','Bon fournisseur requis');if(route.receivedQty+amount>route.quantity)fail('OVER_RECEIVED','Réception supérieure au bon');
 const signature=idempotency(o,requestId,{action:'receipt',id,supplier,amount});if(typeof signature==='object')return signature;
 return change(o,requestId,signature,'supplier_received','Réception fournisseur '+amount+' '+r.name,next=>{line(next,id).supplierRoutes.find(x=>x.supplierId===supplier).receivedQty+=amount;},{lineId:id,supplierId:supplier,quantity:amount});}
function latestNotice(o){return o.events.filter(e=>['received','routed','quantity_added'].includes(e.type)).reduce((n,e)=>Math.max(n,e.revision),0);}
function ready(o){if(o.warehouse.shippedAt)return {ok:false,reason:'shipped'};const lines=o.lines.filter(x=>x.warehouseQty>0);if(!lines.length)return {ok:false,reason:'no_items'};
 if(o.warehouse.ackRevision<latestNotice(o))return {ok:false,reason:'unread_changes'};
 const pending=lines.filter(x=>x.pickedQty!==x.warehouseQty).map(x=>({id:x.id,remaining:x.warehouseQty-x.pickedQty}));
 return pending.length?{ok:false,reason:'not_prepared',pending}:{ok:true};}
function ship(o,actor,requestId,{at='2026-11-07T00:00:00.000Z'}={}){const signature=idempotency(o,requestId,{action:'ship',actor:name(actor)});if(typeof signature==='object')return signature;
 editable(o);const check=ready(o);if(!check.ok)fail('NOT_READY','Préparation incomplète ou modification non lue : '+check.reason);
 return change(o,requestId,signature,'warehouse_shipped','Entrepôt expédié',next=>{next.warehouse.shippedAt=at;next.warehouse.shippedBy=name(actor);},{shippedAt:at});}
function status(o){const unassigned=o.lines.reduce((n,l)=>n+l.requestedQty-allocated(l),0);
 const warehouseQty=o.lines.reduce((n,l)=>n+l.warehouseQty,0),pickedQty=o.lines.reduce((n,l)=>n+l.pickedQty,0);
 const supplierQty=o.lines.reduce((n,l)=>n+l.supplierRoutes.reduce((s,r)=>s+r.quantity,0),0);
 const received=o.lines.reduce((n,l)=>n+l.supplierRoutes.reduce((s,r)=>s+r.receivedQty,0),0);
 const supplierUnlinked=o.lines.some(l=>l.supplierRoutes.some(r=>!r.poId));
 const warehouseStatus=warehouseQty===0?'none':o.warehouse.shippedAt?'shipped':pickedQty===warehouseQty?'ready':pickedQty?'preparing':'waiting';
 const overall=unassigned>0?'triage':warehouseQty>0&&!o.warehouse.shippedAt?'warehouse':supplierUnlinked?'supplier_po':received<supplierQty?'external':'completed';
 return {overall,warehouseStatus,warehouseQty,pickedQty,supplierQty,supplierReceived:received,supplierRemaining:supplierQty-received,unassigned,complete:overall==='completed'};}
function queue(o){const s=status(o),unread=o.events.filter(e=>['received','routed','quantity_added'].includes(e.type)&&e.revision>o.warehouse.ackRevision);
 return {orderId:o.id,job:o.job,address:o.address,team:o.team,warehouseStatus:s.warehouseStatus,unread,
 notifications:unread.filter(e=>e.type==='quantity_added').map(e=>e.message),
 lines:o.lines.filter(l=>l.warehouseQty>0).map(l=>({id:l.id,sku:l.sku,name:l.name,requested:l.warehouseQty,picked:l.pickedQty,remaining:l.warehouseQty-l.pickedQty}))};}
return Object.freeze({make,route,amend,ack,pick,linkPO,supplierReceived,ready,ship,status,queue,version:'1.0.0'});
});