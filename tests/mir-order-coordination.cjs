'use strict';
const assert=require('node:assert/strict'),M=require('../dist/mir-order-coordination.js');
let count=0,serial=0;
const T=(label,fn)=>{fn();count++;console.log('PASS '+label);};
const id=()=>String(++serial),run=(fn,order,...args)=>fn(order,...args);
const initial=M.make({id:'353',job:'Chantier 353',address:'123 rue du Site, Québec',team:'Équipe Jack',requestedBy:'employe',
 lines:[{id:'mono',sku:'MONO-TUBE',name:'Tube Mono',quantity:25,unit:'tube'},
        {id:'solin',sku:'SOLIN-MIR',name:'Moulure 3 plis',quantity:12,unit:'pièce'},
        {id:'vis',sku:'VIS-COULEUR',name:'Vis couleur',quantity:4,unit:'boîte'}]});
let order=initial;
T('Une seule commande mère avec chantier/adresse/équipe',()=>{const q=M.queue(order);assert.equal(q.orderId,'353');assert.equal(q.job,'Chantier 353');assert.equal(q.team,'Équipe Jack');assert.equal(q.address,'123 rue du Site, Québec');});
T('Répartition Mono: 20 entrepôt + 5 à commander',()=>{
 order=M.route(order,'mono',{warehouseQty:20,suppliers:[{supplierId:'supplier-A',quantity:5}]},id()).order;
 assert.equal(order.lines[0].warehouseQty,20);assert.equal(order.lines[0].supplierRoutes[0].quantity,5);
});
T('Moulures et vis peuvent être envoyées à deux fournisseurs',()=>{
 order=M.route(order,'solin',{suppliers:[{supplierId:'Breton',quantity:12}]},id()).order;
 order=M.route(order,'vis',{suppliers:[{supplierId:'Unico',quantity:4}]},id()).order;
 assert.equal(M.status(order).supplierQty,21);assert.equal(M.status(order).unassigned,0);
});
T('Refuser un excès de quantité à répartir',()=>assert.throws(()=>M.route(order,'mono',{warehouseQty:21,suppliers:[{supplierId:'supplier-A',quantity:5}]},id()),/dépasse/));
T('Deux bons fournisseurs distincts sur la même commande',()=>{
 order=M.linkPO(order,'solin','Breton','PO-101',id()).order;
 order=M.linkPO(order,'vis','Unico','PO-102',id()).order;
 order=M.linkPO(order,'mono','supplier-A','PO-103',id()).order;
 assert.equal(order.lines[0].supplierRoutes[0].poId,'PO-103');
 assert.equal(order.lines[1].supplierRoutes[0].poId,'PO-101');
 assert.equal(order.lines[2].supplierRoutes[0].poId,'PO-102');
});
T('Entrepôt doit confirmer les notifications de répartition',()=>assert.equal(M.ready(order).reason,'unread_changes'));
T('Préparer 15 tubes sans déclarer commande expédiée',()=>{
 order=M.ack(order,'magasinier');
 order=M.pick(order,'mono',15,id()).order;
 assert.equal(M.status(order).warehouseStatus,'preparing');assert.equal(M.queue(order).lines[0].remaining,5);
});
T('Adjointe ajoute 3 tubes à la commande 353 sans effacer la préparation',()=>{
 order=M.amend(order,'mono',3,id(),{actor:'Adjointe'}).order;
 const notice=M.queue(order).notifications;
 assert.equal(order.lines[0].requestedQty,28);assert.equal(order.lines[0].pickedQty,15);
 assert.ok(notice.some(x=>x.includes('353')&&x.includes('+3')&&x.includes('Mono')));
});
T('Avant expédition, répartition des 3 tubes supplémentaires à l entrepôt',()=>{
 order=M.route(order,'mono',{warehouseQty:23,suppliers:[{supplierId:'supplier-A',quantity:5,poId:'PO-103'}]},id()).order;
 assert.equal(order.lines[0].requestedQty,28);
 assert.equal(order.lines[0].warehouseQty,23);
 assert.equal(order.lines[0].supplierRoutes[0].quantity,5);
});
T('Interdire la modification de quantités déjà scannées',()=>{
 assert.throws(()=>M.route(order,'mono',{warehouseQty:12,suppliers:[{supplierId:'supplier-A',quantity:5}]},id()),/déjà préparé/i);
});
T('Les notifications non lues bloquent la commande expédiée',()=>{
 order=M.pick(order,'mono',8,id()).order;
 assert.equal(M.ready(order).reason,'unread_changes');
 assert.throws(()=>M.ship(order,'magasinier',id()),/modification non lue/i);
});
T('Accusé de réception puis expédition : la tâche entrepôt est close',()=>{
 order=M.ack(order,'magasinier');assert.equal(M.ready(order).ok,true);
 order=M.ship(order,'magasinier','shipment-once').order;
 const s=M.status(order);assert.equal(s.warehouseStatus,'shipped');
 assert.equal(s.overall,'external','commandes fournisseurs encore ouvertes');
 assert.equal(s.complete,false);
});
T('Un double clic Expédier utilise la même référence sans deuxième expédition',()=>{
 const replay=M.ship(order,'magasinier','shipment-once');
 assert.equal(replay.replayed,true);assert.equal(replay.order.revision,order.revision);
});
T('Après expédition, impossible d ajouter des articles à cette expédition',()=>{
 assert.throws(()=>M.amend(order,'mono',3,id()),/expédiée/);
});
T('Réception externe partielle : la commande mère reste ouverte',()=>{
 order=M.supplierReceived(order,'solin','Breton',7,id()).order;
 assert.equal(M.status(order).overall,'external');
 assert.equal(M.status(order).supplierRemaining,14);
});
T('Réception de toutes les commandes externes clôture la commande mère',()=>{
 order=M.supplierReceived(order,'solin','Breton',5,id()).order;
 order=M.supplierReceived(order,'vis','Unico',4,id()).order;
 order=M.supplierReceived(order,'mono','supplier-A',5,id()).order;
 assert.equal(M.status(order).complete,true);
 assert.equal(M.status(order).supplierRemaining,0);
});
T('Ne jamais recevoir plus que la quantité fournisseur',()=>assert.throws(()=>M.supplierReceived(order,'mono','supplier-A',1,id()),/supérieure/));
T('Les événements de notification restent dans l historique horodatable',()=>{
 assert.ok(order.events.some(e=>e.type==='quantity_added'&&e.delta===3));
 assert.ok(order.events.some(e=>e.type==='warehouse_shipped'));
 assert.ok(order.events.some(e=>e.type==='supplier_received'));
});
T('Les opérations ne modifient pas les états précédents',()=>{
 assert.equal(initial.lines[0].requestedQty,25);
 assert.equal(initial.warehouse.shippedAt,null);
 assert.equal(initial.events.length,1);
});
T('Une requête réutilisée avec un contenu différent est refusée',()=>{
 const o=M.make({id:'X',lines:[{id:'item',sku:'SKU',quantity:10}]});
 const a=M.amend(o,'item',2,'fixed-request').order;
 assert.equal(M.amend(a,'item',2,'fixed-request').replayed,true);
 assert.throws(()=>M.amend(a,'item',1,'fixed-request'),/autre mouvement/);
});
console.log('MIR coordination métier: '+count+' tests réussis.');
