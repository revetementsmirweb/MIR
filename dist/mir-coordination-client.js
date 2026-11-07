/* MIR Coordination — Auth réelle Supabase, aucune donnée de stock locale autoritative.
 * Le QR est une référence opaque : toute sortie physique reste dans MIRWarehouseClient.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.MIRCoordinationClient=api;})(typeof globalThis==='object'?globalThis:null,function(){
'use strict';
const uuidRe=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const signature=v=>JSON.stringify(v);
function create({sdk,config,storage,uuid=()=>globalThis.crypto?.randomUUID?.()}={}){
 if(config?.enabled!==true||!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(config.supabaseUrl||'')||
  !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey||''))throw Error('Connexion Coordination MIR non activée ou à vérifier.');
 if(!sdk?.createClient||!storage)throw Error('Module de connexion ou reprise manquant.');
 const db=sdk.createClient(config.supabaseUrl,config.publishableKey,{auth:{flowType:'pkce',persistSession:true,autoRefreshToken:true}});
 let actor=null,generation=0;
 const changed=()=>{generation++;actor=null;};
 const subscription=db.auth.onAuthStateChange?.((event,session)=>{
  const next=session?.user?.id||null;if(event==='SIGNED_OUT'||actor&&next&&actor!==next)changed();
 });
 async function verified(){
  const at=generation,{data,error}=await db.auth.getUser();
  if(at!==generation)throw Error('Session changée.');
  if(error||!data?.user?.id)throw Error('Connexion MIR requise.');
  if(actor&&actor!==data.user.id){changed();throw Error('Compte changé : reconnecte-toi.');}
  actor=data.user.id;return {id:actor,generation};
 }
 async function rpc(name,args={}){
  const user=await verified();
  const {data,error}=await db.rpc(name,args);
  if(user.generation!==generation||actor!==user.id)throw Error('Session changée : actualisation requise.');
  if(error)throw error;
  return data;
 }
 const pendingKey=id=>'mir_coordination_pending_v1_'+id;
 function getPending(id){try{return JSON.parse(storage.getItem(pendingKey(id))||'null');}catch{throw Error('Ancienne action non confirmée : vérifier le stockage.');}}
 function savePending(id,data){
  try{
   const value=JSON.stringify(data);storage.setItem(pendingKey(id),value);
   if(storage.getItem(pendingKey(id))!==value)throw Error('store');
  }catch{throw Error('Impossible de garder la référence de l action. Aucune modification envoyée.');}
 }
 async function operation(name,args){
  const user=await verified(),sig=signature({name,args}),old=getPending(user.id);
  if(old&&old.signature!==sig)throw Error('Une autre modification attend confirmation. Réessaie la précédente avant de modifier cette commande.');
  const id=old?.requestId||uuid();
  if(!uuidRe.test(id||''))throw Error('Identifiant d opération sécurisé indisponible.');
  if(!old)savePending(user.id,{signature:sig,requestId:id,name,args});
  try{
   const result=await rpc(name,{...args,request_id:id});
   try{storage.removeItem(pendingKey(user.id));}catch{}
   return result;
  }catch(error){
   if(['22023','42501','40001','23505'].includes(error?.code))try{storage.removeItem(pendingKey(user.id));}catch{}
   throw error;
  }
 }
 async function login(email,password){
  const {error}=await db.auth.signInWithPassword({email,password});if(error)throw error;
  await verified();const list=await memberships();
  if(!list.some(x=>x.assistant===true||x.admin===true))throw Error('Compte sans accès Adjointe/Coordination.');
  return list;
 }
 async function logout(){changed();const {error}=await db.auth.signOut({scope:'local'});if(error)throw error;}
 const memberships=()=>rpc('mir_coordination_memberships');
 const inbox=org=>rpc('mir_coordination_inbox',{org});
 const open=(org,sourceOrderId)=>rpc('mir_coordination_open',{org,source_order:sourceOrderId});
 const detail=(org,coordId)=>rpc('mir_coordination_detail',{org,coord_id:coordId});
 const suppliers=org=>rpc('mir_coordination_suppliers',{org});
 const supplierOrders=(org,supplier)=>rpc('mir_coordination_supplier_orders',{org,supplier});
 const route=(org,coordId,lineId,warehouseQty,ext,revision)=>operation('mir_coordination_route',{
  org,coord_id:coordId,coord_line:lineId,warehouse_qty:warehouseQty,suppliers:ext,expected_revision:revision});
 const add=(org,coordId,lineId,amount,revision)=>operation('mir_coordination_add',{
  org,coord_id:coordId,existing_coord_line:lineId,additional_qty:amount,expected_revision:revision});
 const metadata=(org,coordId,revision,values)=>operation('mir_coordination_metadata',{
  org,coord_id:coordId,expected_revision:revision,vals:values});
 const linkPO=(org,coordId,routeId,poId,revision)=>operation('mir_coordination_supplier_po',{
  org,coord_id:coordId,route_id:routeId,po_id:poId,expected_revision:revision});
 const supplierReceive=(org,coordId,routeId,amount,revision)=>operation('mir_coordination_supplier_receive',{
  org,coord_id:coordId,route_id:routeId,quantity:amount,expected_revision:revision});
 const supplierStatus=(org,coordId,routeId,state,revision)=>operation('mir_coordination_supplier_status',{
  org,coord_id:coordId,route_id:routeId,next_status:state,expected_revision:revision});
 const warehouseQueue=org=>rpc('mir_coordination_warehouse_queue',{org});
 const acknowledge=(org,coordId)=>rpc('mir_coordination_ack',{org,coord_id:coordId});
 const ship=(org,coordId,revision)=>operation('mir_coordination_ship',{org,coord_id:coordId,expected_revision:revision});
 const grant=(org,member,allowed)=>rpc('mir_coordination_grant',{org,member,allowed});
 function close(){changed();subscription?.data?.subscription?.unsubscribe?.();}
 return Object.freeze({login,logout,memberships,inbox,open,detail,suppliers,route,add,metadata,linkPO,
  supplierReceive,supplierStatus,warehouseQueue,acknowledge,ship,grant,checkPending:async()=>getPending((await verified()).id),
  supplierOrders,close,version:'1.1.0'});
}
return Object.freeze({create});
});