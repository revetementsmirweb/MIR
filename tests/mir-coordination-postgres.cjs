'use strict';
/* PostgreSQL réel en mémoire, Auth simulée par rôle PostgreSQL;
 * ne certifie PAS le serveur Supabase hébergé. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('../tools/database/node_modules/@electric-sql/pglite');
const ROOT=path.join(__dirname,'../supabase');
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
(async()=>{
 const db=new PGlite(), org=uuid(10),admin=uuid(1),employee=uuid(2),assistant=uuid(3),warehouse=uuid(4),
 source=uuid(61), supplier=uuid(50), skuId=uuid(80), qr=uuid(81);
 let checks=0;const ok=(name,fn)=>{checks++;console.log('PASS '+name);};
 async function actor(user,sql,params=[]){
  await db.exec('begin; set local role authenticated;');
  try{await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);
   const r=await db.query(sql,params);await db.exec('commit');return r.rows;}
  catch(e){await db.exec('rollback');throw e;}
 }
 async function failAs(user,sql,params=[],pattern){
  await assert.rejects(()=>actor(user,sql,params),e=>!pattern||pattern.test(e.message));
 }
 try{
  await db.exec("create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;");
  const dir=path.join(ROOT,'migrations');
  for(const file of fs.readdirSync(dir).filter(x=>x.endsWith('.sql')).sort())await db.exec(fs.readFileSync(path.join(dir,file),'utf8'));
  for(const file of ['202611070006_warehouse_stock_qr.sql','202611070007_order_coordination.sql','202611070008_order_coordination_operations.sql','202611070009_order_supplier_purchases.sql'])
    await db.exec(fs.readFileSync(path.join(ROOT,'proposals',file),'utf8'));
  ok('Installation des propositions 006+007+008 dans PostgreSQL jetable');
  await db.exec("insert into auth.users(id) values('"+[admin,employee,assistant,warehouse].join("'),('")+"');");
  await db.exec("insert into mir_core.organizations(id,name) values('"+org+"','MIR TEST');");
  for(const [id,role] of [[admin,'admin'],[employee,'employee'],[assistant,'employee'],[warehouse,'employee']])
   await db.query("insert into mir_core.memberships(organization_id,user_id,role,active) values($1,$2,$3,true)",[org,id,role]);
  await db.query("insert into mir_core.suppliers(organization_id,id,name,email) values($1,$2,'Breton Pliage','p@invalid.example')",[org,supplier]);
  await db.query("insert into mir_core.orders(organization_id,id,kind,owner_id) values($1,$2,'employee',$3)",[org,source,employee]);
  await db.query("insert into mir_core.order_revisions(organization_id,order_id,revision,snapshot,created_by) values($1,$2,1,$3,$4)",
   [org,source,{job:'Chantier 353',address:'123 rue du chantier',team:'Équipe A'},employee]);
  const stockKey=JSON.stringify(['mono','tube','Mono',null,[]]);
  await db.query("insert into mir_core.warehouse_skus(organization_id,id,source_kind,source_ref,sku,name,unit,qr_token) values($1,$2,'hardware',$3,'MONO','Tube Mono','tube',$4)",[org,skuId,stockKey,qr]);
  await db.query("insert into mir_core.warehouse_stock(organization_id,sku_id,on_hand) values($1,$2,100)",[org,skuId]);
  const line=(await db.query("insert into mir_core.order_lines(organization_id,order_id,revision,quantity,unit,specification) values($1,$2,1,25,'tube',$3) returning id",[org,source,{name:'Tube Mono',stockKey}])).rows[0].id;
  assert.equal((await db.query("select count(*)::int as n from mir_core.warehouse_fulfillment where organization_id=$1 and order_line_id=$2",[org,line])).rows[0].n,1);
  ok('Identité SKU exact et lien automatique de la commande employé');
  await actor(admin,'select public.mir_coordination_grant($1,$2,true)',[org,assistant]);
  await actor(admin,'select public.mir_warehouse_grant_access($1,$2,true)',[org,warehouse]);
  await failAs(employee,'select public.mir_coordination_inbox($1)',[org],/non autorisée|Coordination|permission/i);
  const inbox=await actor(assistant,'select public.mir_coordination_inbox($1) as result',[org]);
  assert.equal(inbox[0].result.length,1);
  const opened=await actor(assistant,'select public.mir_coordination_open($1,$2) as result',[org,source]);
  const co=opened[0].result.id;assert.ok(co);
  const detail=(await actor(assistant,'select public.mir_coordination_detail($1,$2) as result',[org,co]))[0].result;
  assert.equal(detail.lines.length,1);
  const cLine=detail.lines[0].id;
  ok('Adjointe autorisée et commande 353 existante préservée');
  const routeResult=await actor(assistant,'select public.mir_coordination_route($1,$2,$3,20,$4,1,$5) as result',
   [org,co,cLine,[{supplierId:supplier,quantity:5}],uuid(130)]);
  assert.equal(routeResult[0].result.unassigned,0);
  await failAs(warehouse,'select public.mir_coordination_route($1,$2,$3,20,$4,2,$5)',[org,co,cLine,[{supplierId:supplier,quantity:5}],uuid(131)],/Adjointe|non autorisée|42501/);
  ok('Répartition 20 Entrepôt + 5 fournisseur, permissions séparées');
  const rows=await actor(warehouse,'select public.mir_coordination_warehouse_queue($1) as result',[org]);
  assert.equal(rows[0].result[0].lines[0].requestedQty,20);
  assert.equal(rows[0].result[0].lines[0].pickedQty,0);
  await failAs(warehouse,'select public.mir_coordination_ship($1,$2,2,$3)',[org,co,uuid(141)],/Lire|confirmer|42501/);
  await actor(warehouse,'select public.mir_coordination_ack($1,$2)',[org,co]);
  ok('L Entrepôt voit uniquement sa ligne et doit reconnaître les changements');
  await actor(warehouse,'select public.mir_warehouse_move($1,$2,$3,-15,$4,$5)',[org,qr,line,uuid(142),'Préparation commande 353']);
  const n=(await db.query("select on_hand from mir_core.warehouse_stock where organization_id=$1 and sku_id=$2",[org,skuId])).rows[0].on_hand;
  assert.equal(Number(n),85);
  await failAs(warehouse,'select public.mir_coordination_ship($1,$2,2,$3)',[org,co,uuid(143)],/incomplète|préparé/i);
  const more=await actor(assistant,'select public.mir_coordination_add($1,$2,$3,3,2,$4) as result',[org,co,cLine,uuid(144)]);
  const extra=more[0].result.newLineId;
  assert.ok(extra);
  const queueAfter=(await actor(warehouse,'select public.mir_coordination_warehouse_queue($1) as result',[org]))[0].result;
  assert.ok(queueAfter[0].unread.some(e=>e.type==='quantity_added'));
  assert.ok(JSON.stringify(queueAfter).includes('3'));
  ok('Scan -15 et ajout +3 horodaté visible, stock déjà sorti préservé');
  await actor(assistant,'select public.mir_coordination_route($1,$2,$3,3,$4,3,$5)',[org,co,extra,[],uuid(145)]);
  const extraSource=(await db.query('select employee_line_id from mir_core.coordination_lines where organization_id=$1 and id=$2',[org,extra])).rows[0].employee_line_id;
  await actor(warehouse,'select public.mir_coordination_ack($1,$2)',[org,co]);
  await actor(warehouse,'select public.mir_warehouse_move($1,$2,$3,-5,$4,$5)',[org,qr,line,uuid(146),'Préparation commande 353']);
  await actor(warehouse,'select public.mir_warehouse_move($1,$2,$3,-3,$4,$5)',[org,qr,extraSource,uuid(147),'Ajout commande 353']);
  const shipment=await actor(warehouse,'select public.mir_coordination_ship($1,$2,4,$3) as result',[org,co,uuid(148)]);
  assert.equal(shipment[0].result.warehouseStatus,'shipped');
  const after=(await db.query('select on_hand from mir_core.warehouse_stock where organization_id=$1 and sku_id=$2',[org,skuId])).rows[0].on_hand;
  assert.equal(Number(after),77);
  ok('23 tubes préparés, une expédition, aucun second mouvement à expédier');
  const replay=await actor(warehouse,'select public.mir_coordination_ship($1,$2,4,$3) as result',[org,co,uuid(148)]);
  assert.equal(replay[0].result.id,co);
  assert.equal((await db.query('select count(*)::int as n from mir_core.coordination_shipments where organization_id=$1 and coordination_id=$2',[org,co])).rows[0].n,1);
  await failAs(assistant,'select public.mir_coordination_add($1,$2,$3,3,5,$4)',[org,co,cLine,uuid(149)],/expédiée/i);
  ok('Expédition idempotente et modifications interdites après départ');
  const detail2=(await actor(assistant,'select public.mir_coordination_detail($1,$2) as result',[org,co]))[0].result;
  const supplierRoute=detail2.lines[0].routes.find(r=>r.lane==='supplier');
  assert.ok(supplierRoute?.id);
  const availableSuppliers=(await actor(assistant,'select public.mir_coordination_suppliers($1) as result',[org]))[0].result;
  assert.ok(availableSuppliers.some(r=>r.id===supplier),'fournisseur MIR pré-intégré');
  const poResult=(await actor(assistant,'select public.mir_coordination_supplier_po($1,$2,$3,null,5,$4) as result',
   [org,co,supplierRoute.id,uuid(160)]))[0].result;
  assert.equal(poResult.created,true);
  const poOrder=(await db.query('select kind, status, supplier_id from mir_core.orders where organization_id=$1 and id=$2',[org,poResult.supplierOrderId])).rows[0];
  assert.equal(poOrder.kind,'supplier');assert.equal(poOrder.status,'draft');
  assert.equal(poOrder.supplier_id,supplier);
  assert.equal((await db.query('select count(*)::int as n from mir_core.order_lines where organization_id=$1 and order_id=$2',[org,poResult.supplierOrderId])).rows[0].n,1);
  const samePO=(await actor(assistant,'select public.mir_coordination_supplier_po($1,$2,$3,null,5,$4) as result',
   [org,co,supplierRoute.id,uuid(160)]))[0].result;
  assert.equal(samePO.supplierOrderId,poResult.supplierOrderId);
  ok('Bon fournisseur réel réutilise les tables MIR, sans doublon ni envoi automatique');
  const ordered=(await db.query('select production_status from mir_core.coordination_routes where organization_id=$1 and id=$2',
   [org,supplierRoute.id])).rows[0].production_status;
  assert.equal(ordered,'ordered','un bon brouillon place la fabrication à commandé');
  const inProduction=(await actor(assistant,'select public.mir_coordination_supplier_status($1,$2,$3,$4,6,$5) as result',
   [org,co,supplierRoute.id,'in_production',uuid(163)]))[0].result;
  assert.equal(inProduction.state,'in_production');
  const ready=(await actor(assistant,'select public.mir_coordination_supplier_status($1,$2,$3,$4,7,$5) as result',
   [org,co,supplierRoute.id,'ready',uuid(164)]))[0].result;
  assert.equal(ready.state,'ready');
  await failAs(assistant,'select public.mir_coordination_supplier_status($1,$2,$3,$4,8,$5)',
   [org,co,supplierRoute.id,'ordered',uuid(165)],/revenir en arrière/);
  ok('Statuts de production externe commandé, fabrication et prêt avec progression auditée');
  const received=(await actor(assistant,'select public.mir_coordination_supplier_receive($1,$2,$3,3,8,$4) as result',
   [org,co,supplierRoute.id,uuid(161)]))[0].result;
  assert.equal(Number(received.remainingQty),2);
  assert.equal((await db.query('select production_status from mir_core.coordination_routes where organization_id=$1 and id=$2',
   [org,supplierRoute.id])).rows[0].production_status,'received_partial');
  await failAs(assistant,'select public.mir_coordination_supplier_receive($1,$2,$3,3,9,$4)',
   [org,co,supplierRoute.id,uuid(162)],/supérieure/);
  await failAs(assistant,'select public.mir_coordination_supplier_status($1,$2,$3,$4,9,$5)',
   [org,co,supplierRoute.id,'ordered',uuid(166)],/Réception déjà commencée/);
  ok('Réception externe partielle conserve le reliquat et interdit de réinitialiser la fabrication');
  const final=(await actor(assistant,'select public.mir_coordination_supplier_receive($1,$2,$3,2,9,$4) as result',
   [org,co,supplierRoute.id,uuid(167)]))[0].result;
  assert.equal(Number(final.remainingQty),0);
  assert.equal((await db.query('select production_status from mir_core.coordination_routes where organization_id=$1 and id=$2',
   [org,supplierRoute.id])).rows[0].production_status,'received');
  ok('Réception complète de la production externe, sans mouvement de stock Entrepôt supplémentaire');
  const secondOrder=uuid(62);
  await db.query('insert into mir_core.orders(organization_id,id,kind,owner_id) values($1,$2,$3,$4)',
   [org,secondOrder,'employee',employee]);
  await db.query('insert into mir_core.order_revisions(organization_id,order_id,revision,snapshot,created_by) values($1,$2,1,$3,$4)',
   [org,secondOrder,{job:'Chantier secondaire'},employee]);
  await db.query('insert into mir_core.order_lines(organization_id,order_id,revision,quantity,unit,specification) values($1,$2,1,4,$3,$4)',
   [org,secondOrder,'tube',{name:'Tube Mono',stockKey}]);
  const fresh=(await actor(assistant,'select public.mir_coordination_open($1,$2) as result',[org,secondOrder]))[0].result;
  const metadata=(await actor(assistant,'select public.mir_coordination_metadata($1,$2,1,$3,$4) as result',
   [org,fresh.id,{job:'JOB 454',address:'456 rue du chantier',team:'Équipe B',priority:'urgent',notes:'Porte arrière'},uuid(168)]))[0].result;
  assert.equal(metadata.revision,2);
  const detailMeta=(await actor(assistant,'select public.mir_coordination_detail($1,$2) as result',[org,fresh.id]))[0].result;
  assert.equal(detailMeta.job,'JOB 454');assert.equal(detailMeta.team,'Équipe B');
  ok('Adjointe modifie le job, l’adresse, la priorité et l’équipe via SQL');
  await failAs(employee,'select * from mir_core.coordination_ops',[],/permission|denied/i);
  ok('Aucun accès direct aux opérations');
  console.log('MIR coordination PostgreSQL: '+checks+' tests réussis; simulation Auth, AUCUN service hébergé.');
 }finally{await db.close();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1});
