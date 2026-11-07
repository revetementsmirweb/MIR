/* MIR Entrepôt — client authentifié, mouvements idempotents et aucune écriture locale de stock. */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.MIRWarehouseClient=api;})(typeof globalThis==='object'?globalThis:null,function(){
 'use strict';
 const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 function create({sdk,config,storage,uuid=()=>globalThis.crypto.randomUUID()}){
  if(!config?.enabled||!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(config.supabaseUrl||'')||
     !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey||''))
    throw Error('La connexion Entrepôt MIR n’est pas activée ou vérifiée.');
  if(!sdk?.createClient||!storage)throw Error('Module de connexion ou stockage sûr indisponible.');
  const db=sdk.createClient(config.supabaseUrl,config.publishableKey,{auth:{flowType:'pkce',persistSession:true,autoRefreshToken:true}});
  let userId=null,epoch=0;
  const pendingKey=id=>'mir_entrepot_pending_v1_'+id;
  function changed(){epoch++;userId=null;}
  const subscription=db.auth.onAuthStateChange?.((event,session)=>{
   const next=session?.user?.id||null;
   if(event==='SIGNED_OUT'||userId&&next&&userId!==next)changed();
  });
  async function verified(){
   const before=epoch,{data,error}=await db.auth.getUser();
   if(before!==epoch)throw Error('Session modifiée. Reconnecte-toi.');
   if(error||!data?.user?.id)throw Error('Connexion requise.');
   if(userId&&userId!==data.user.id){changed();throw Error('Session modifiée. Reconnecte-toi.');}
   userId=data.user.id;return {id:userId,epoch};
  }
  async function rpc(name,args){
   const user=await verified();
   const {data,error}=await db.rpc(name,args);
   if(user.epoch!==epoch||user.id!==userId)throw Error('Session modifiée. Aucune confirmation.');
   if(error)throw error;
   return data;
  }
  function pending(id){try{return JSON.parse(storage.getItem(pendingKey(id))||'null');}catch{throw Error('Ancien mouvement incertain. Vérification du stockage nécessaire.');}}
  async function memberships(){return rpc('mir_warehouse_memberships',{});}
  async function login(email,password){
   const {error}=await db.auth.signInWithPassword({email,password});if(error)throw error;
   await verified();
   const list=await memberships();
   if(!Array.isArray(list)||!list.length)throw Error('Aucune autorisation Entrepôt active pour ce compte.');
   return list;
  }
  async function logout(){
   changed();
   const {error}=await db.auth.signOut({scope:'local'});if(error)throw error;
  }
  async function snapshot(org,token){return rpc('mir_warehouse_snapshot',{org,qr:token});}
  async function search(org,term=''){return rpc('mir_warehouse_search',{org,term});}
  async function queue(org){return rpc('mir_warehouse_queue',{org});}
  async function register(org,data){
   return rpc('mir_warehouse_register',{org,kind:data.kind,source_ref:data.sourceRef,sku_code:data.sku,display_name:data.name,unit_name:data.unit,step:data.step});
  }
  async function move({org,token,lineId=null,delta,reason}){
   const user=await verified();
   if(!UUID.test(org||'')||!UUID.test(token||'')||lineId&&!UUID.test(lineId))throw Error('Référence de stock ou de commande invalide.');
   if(!Number.isFinite(delta)||delta===0||Math.abs(delta)>100000)throw Error('Quantité invalide.');
   const payload={org,qr:token,line_id:lineId,delta,reason:String(reason||'').trim()};
   if(payload.reason.length<3||payload.reason.length>300)throw Error('Ajoute un motif de mouvement.');
   const key=pendingKey(user.id),signature=JSON.stringify(payload);
   let saved=pending(user.id);
   if(saved&&(saved.signature!==signature||saved.org!==org))throw Error('Un mouvement attend confirmation. Reprends-le avant de saisir une autre sortie.');
   if(!saved){
    const id=uuid();if(!UUID.test(id||''))throw Error('Référence de mouvement sécurisée indisponible.');
    saved={id,org,signature,createdAt:new Date().toISOString()};
    try{storage.setItem(key,JSON.stringify(saved));if(storage.getItem(key)!==JSON.stringify(saved))throw Error('stockage');}
    catch{throw Error('Impossible de conserver l’identifiant de mouvement. Aucune sortie transmise.');}
   }
   try{
    const result=await rpc('mir_warehouse_move',{...payload,request_id:saved.id});
    try{storage.removeItem(key);}catch{}
    return result;
   }catch(error){
    // Une erreur réseau après commit est INCERTAINE : garder le request_id
    // et ne jamais créer une seconde sortie lors de la reprise.
    if(['22023','42501','40001','23505'].includes(error?.code)){
     try{storage.removeItem(key);}catch{}
    }
    throw error;
   }
  }
  function close(){changed();subscription?.data?.subscription?.unsubscribe?.();}
  return Object.freeze({login,logout,memberships,snapshot,search,queue,register,move,close,checkPending:async()=>pending((await verified()).id),version:'1.0.0'});
 }
 return Object.freeze({create});
});