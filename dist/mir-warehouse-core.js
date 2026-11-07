/* MIR Warehouse: pure validation. The live database is authoritative. */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.MIRWarehouseCore=api;})(typeof globalThis==='object'?globalThis:null,function(){
 'use strict';
 const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 const same=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();
 function qrToken(value,{origin='https://revetementsmirweb.github.io'}={}){
  const input=String(value??'').trim();
  if(UUID.test(input))return input.toLowerCase();
  let url;try{url=new URL(input);}catch{return null;}
  if(url.protocol!=='https:'||url.origin!==origin||!/\/(?:MIR\/)?entrepot\.html$/.test(url.pathname)||
     url.username||url.password||url.hash)return null;
  const token=url.searchParams.get('qr');
  return UUID.test(token||'')?token.toLowerCase():null;
 }
 function qrUrl(token,{origin='https://revetementsmirweb.github.io',prefix='/MIR/'}={}){
  if(!UUID.test(token||''))throw Error('Identifiant QR invalide');
  if(!/^https:\/\/[a-z0-9.-]+$/i.test(origin)||!/^\/(?:[A-Za-z0-9_-]+\/)?$/.test(prefix))throw Error('Adresse MIR invalide');
  return origin+prefix+'entrepot.html?qr='+token.toLowerCase();
 }
 function parseSigned(value){
  const str=String(value??'').trim().replace(/\s/g,'').replace(',','.');
  if(!/^[+-]?\d{1,8}(?:\.\d{1,3})?$/.test(str))throw Error('Entre une quantité comme -20 ou +10');
  const delta=Number(str);
  if(!Number.isFinite(delta)||Math.abs(delta)<1e-10)throw Error('La quantité doit être différente de zéro');
  return Math.round(delta*1000)/1000;
 }
 function remaining(row){
  const requested=Number(row?.requestedQty),delivered=Number(row?.deliveredQty||0),cancelled=Number(row?.cancelledQty||0);
  if(![requested,delivered,cancelled].every(Number.isFinite)||requested<0||delivered<0||cancelled<0||delivered+cancelled>requested)throw Error('Ligne de commande incohérente');
  return Math.max(0,Math.round((requested-delivered-cancelled)*1000)/1000);
 }
 function preview({sku,line=null,amount,reason='delivery'}){
  if(!sku||!UUID.test(sku.id||''))throw Error('Scanne la référence MIR du produit');
  const delta=parseSigned(amount),onHand=Number(sku.onHand),step=Number(sku.step||1);
  if(!Number.isFinite(onHand)||onHand<0||!Number.isFinite(step)||step<=0)throw Error('Stock non confirmé');
  const units=Math.abs(delta)/step;
  if(Math.abs(units-Math.round(units))>1e-7)throw Error('La quantité doit respecter le format de vente');
  if(onHand+delta<-1e-8)throw Error('Stock insuffisant pour cette sortie');
  let afterOrder=null,kind;
  if(line){
   if(!same(line.skuId,sku.id))throw Error('Cette ligne ne correspond pas au QR scanné');
   if(delta>=0)throw Error('Une livraison doit être une sortie négative');
   const before=remaining(line);
   if(-delta>before+1e-7)throw Error('Sortie supérieure au reliquat de commande');
   afterOrder={before,after:Math.max(0,Math.round((before+delta)*1000)/1000)};
   kind='delivery';
  }else{
   if(!['adjustment','receipt'].includes(reason))throw Error('Motif de mouvement obligatoire');
   if(reason==='receipt'&&delta<=0)throw Error('La réception fournisseur augmente le stock');
   kind=reason;
  }
  return {delta,kind,stockBefore:onHand,stockAfter:Math.round((onHand+delta)*1000)/1000,
   order:afterOrder,unit:sku.unit||'unité'};
 }
 return Object.freeze({qrToken,qrUrl,parseSigned,remaining,preview,version:'1.0.0'});
});