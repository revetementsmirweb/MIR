'use strict';
const assert=require('node:assert/strict'),W=require('../dist/mir-warehouse-client.js');
const uuid='40eb4980-3b74-48f4-9878-b74e5f0bf222',token='02c8070d-d549-4298-833e-b1a8e6310981',
 org='8025799e-2b83-47d6-880a-e4b15a904356',line='ed105621-549b-4cd2-a66c-69f818fa1574';
const storage=()=>{const map=new Map();return {getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k),entries:()=>[...map]};};
async function run(){
 const st=storage(),seen=[];let fail=true;
 const api={createClient:()=>({auth:{
   getUser:async()=>({data:{user:{id:uuid}}}),
   signInWithPassword:async()=>({error:null}),
   signOut:async()=>({error:null}),
   onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})
 },rpc:async(name,args)=>{seen.push({name,args});if(name==='mir_warehouse_memberships')return {data:[{id:org,name:'MIR'}]};if(fail&&name==='mir_warehouse_move')throw Error('Réseau coupé après envoi');return {data:{stockAfter:65,remainingAfter:5}};}})};
 const client=W.create({sdk:api,config:{enabled:true,supabaseUrl:'https://gccltmaulvrnthrbnrpd.supabase.co',publishableKey:'sb_publishable_testkey'},storage:st,uuid:()=>token});
 assert.equal((await client.login('test@mir.example','test')).length,1);
 const move={org,token,lineId:line,delta:-20,reason:'Commande chantier ABC'};
 await assert.rejects(()=>client.move(move),/Réseau/);
 assert.equal(st.entries().length,1,'mouvement gardé après erreur réseau');
 fail=false;
 const result=await client.move(move);assert.equal(result.remainingAfter,5);
 const same=seen.filter(x=>x.name==='mir_warehouse_move').map(x=>x.args.request_id);
 assert.deepEqual(same,[token,token],'même idempotency key après coupure');
 assert.equal(st.entries().length,0,'confirmation supprime mouvement incertain');
 fail=true;
 await assert.rejects(()=>client.move(move),/Réseau/);
 await assert.rejects(()=>client.move({...move,delta:-5}),/attend confirmation/);
 client.close();console.log('PASS entrepôt Auth, mouvement unique, reprise après coupure, refus de second mouvement');
}
run().catch(e=>{console.error(e);process.exitCode=1});
