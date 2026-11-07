'use strict';
const a=require('node:assert/strict'),w=require('../dist/mir-warehouse-core.js');
let count=0;const test=(name,run)=>{run();count++;console.log('PASS '+name);};
const stock={id:'40eb4980-3b74-48f4-9878-b74e5f0bf222',sku:'MIR-MONO',name:'Tube Mono',unit:'tube',onHand:85,step:1};
const line={id:'8025799e-2b83-47d6-880a-e4b15a904356',skuId:stock.id,requestedQty:25,deliveredQty:0,cancelledQty:0};
const token='02c8070d-d549-4298-833e-b1a8e6310981';
test('Commande 25, prélèvement -20, cinq à livrer',()=>{
 const out=w.preview({sku:stock,line,amount:'-20'});a.equal(out.stockAfter,65);a.deepEqual(out.order,{before:25,after:5});
});
test('Un nouveau -5 termine le reliquat et conserve le stock',()=>{const next={...line,deliveredQty:20};const out=w.preview({sku:{...stock,onHand:65},line:next,amount:'-5'});a.equal(out.order.after,0);a.equal(out.stockAfter,60)});
test('Aucune sortie excédant le bon',()=>a.throws(()=>w.preview({sku:stock,line,amount:'-26'}),/reliquat/));
test('Aucune sortie excédant le stock',()=>a.throws(()=>w.preview({sku:{...stock,onHand:10},line,amount:'-20'}),/insuffisant/));
test('Aucun mouvement sur une autre référence',()=>a.throws(()=>w.preview({sku:stock,line:{...line,skuId:token},amount:'-2'}),/correspond/));
test('La saisie -10 est interprétée comme dix unités sorties',()=>{const x=w.preview({sku:stock,amount:'-10',reason:'adjustment'});a.equal(x.stockAfter,75)});
test('La réception +10 ne diminue pas le stock',()=>a.equal(w.preview({sku:stock,amount:'+10',reason:'receipt'}).stockAfter,95));
test('Une réception ne valide pas une livraison',()=>a.throws(()=>w.preview({sku:stock,line,amount:'+10'}),/sortie/));
test('Un mouvement 0 est interdit',()=>a.throws(()=>w.parseSigned('0'),/différente/));
test('Format unitaire vérifié',()=>a.throws(()=>w.preview({sku:stock,line,amount:'-2.5'}),/format/));
test('Format d unités fractionnaires autorisé si étape explicite',()=>a.equal(w.preview({sku:{...stock,step:0.25},amount:'-1.5',reason:'adjustment'}).stockAfter,83.5));
test('Adresse QR stable pour un SKU',()=>{
 const url=w.qrUrl(token);a.equal(w.qrToken(url),token);a.equal(w.qrUrl(token),url);
});
test('Un QR externe ne donne pas accès au stock MIR',()=>a.equal(w.qrToken('https://evil.example/entrepot.html?qr='+token),null));
test('Un QR à identifiant malformé est rejeté',()=>a.equal(w.qrToken('xyz'),null));
test('QR sans quantités ni données employé',()=>{const url=w.qrUrl(token);a.ok(!url.includes('Mono')&&!url.includes('85')&&!url.includes('employee'))});
console.log('MIR Warehouse: '+count+' scénarios réussis');
