'use strict';
// Real PostgreSQL execution in WASM, not an RLS mock. Supabase auth schema is
// represented by the minimal users/uid contract; hosted Auth/Storage need staging QA.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('../tools/database/node_modules/@electric-sql/pglite');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
test('Socle PostgreSQL : contraintes, RLS et sauvegardes',async t=>{
  const db=new PGlite();
  async function actor(user,sql,params=[]){
    await db.exec('begin; set local role authenticated;');
    try{
      await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);
      const r=await db.query(sql,params);await db.exec('commit');return r.rows;
    }catch(e){await db.exec('rollback');throw e;}
  }
  const count=(table,where='')=>`select count(*)::int as n from mir_core.${table} ${where}`;
  const reject=(user,sql,params,code)=>assert.rejects(actor(user,sql,params),e=>{assert.equal(e.code,code);return true;});
  try{
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
    await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/202611060001_shared_foundation.sql'),'utf8'));
    await db.exec(`insert into auth.users values ${[1,2,3,4,5,6].map(n=>`('${id(n)}')`).join(',')};
      insert into mir_core.organizations values('${id(10)}','MIR'),('${id(20)}','Autre');
      insert into mir_core.memberships values
      ('${id(10)}','${id(1)}','admin',true),('${id(10)}','${id(2)}','employee',true),
      ('${id(10)}','${id(3)}','client',true),('${id(20)}','${id(4)}','admin',true),
      ('${id(10)}','${id(5)}','employee',false),('${id(10)}','${id(6)}','client',true);
      insert into mir_core.catalogue_items(organization_id,id,name,channel,published,specification) values
      ('${id(10)}','${id(31)}','Magasin','store',true,'{}'),
      ('${id(10)}','${id(32)}','Boutique','boutique',true,'{}'),
      ('${id(10)}','${id(33)}','Brouillon','store',false,'{}');`);
    await t.test('Admin voit son organisation; aucune fuite inter-organisations',async()=>{
      assert.equal((await actor(id(1),count('catalogue_items')))[0].n,3);
      assert.equal((await actor(id(4),count('catalogue_items')))[0].n,0);
      assert.equal((await actor(id(1),count('organizations')))[0].n,1);
    });
    await t.test('Employé : Magasin publié; client : Boutique publiée; inactif refusé',async()=>{
      assert.deepEqual((await actor(id(2),'select name from mir_core.catalogue_items')).map(r=>r.name),['Magasin']);
      assert.deepEqual((await actor(id(3),'select name from mir_core.catalogue_items')).map(r=>r.name),['Boutique']);
      assert.equal((await actor(id(5),count('catalogue_items')))[0].n,0);
      assert.equal((await actor(id(2),count('suppliers')))[0].n,0);
    });
    await t.test('Accès anonyme et élévation de rôle interdits',async()=>{
      await db.exec('set role anon');
      await assert.rejects(db.query(count('catalogue_items')),e=>e.code==='42501');await db.exec('reset role');
      await reject(id(2),"insert into mir_core.memberships values($1,$2,'admin',true)",[id(20),id(2)],'42501');
      await reject(id(2),"insert into mir_core.models(organization_id,name) values($1,'forgé')",[id(10)],'42501');
      // Client-side metadata cannot override the authoritative membership.
      await db.query("select set_config('request.jwt.claim.role','admin',false)");
      assert.equal((await actor(id(2),'select mir_core.has_role($1,array[\'admin\']) as ok',[id(10)]))[0].ok,false);
    });
    await t.test('Modèles versionnés : isolation et instantanés immuables',async()=>{
      await actor(id(1),'insert into mir_core.models(organization_id,id,name) values($1,$2,$3)',[id(10),id(40),'Moulure']);
      await actor(id(1),'insert into mir_core.model_versions(organization_id,model_id,version,specification) values($1,$2,1,$3)',[id(10),id(40),{dimensions:{A:'1 1/2'},material:'acier',color:'noir'}]);
      await reject(id(1),"update mir_core.model_versions set specification='{}'",[],'42501');
      await reject(id(1),"insert into mir_core.model_versions(organization_id,model_id,version,specification) values($1,$2,1,'{}')",[id(10),id(40)],'23505');
      await reject(id(4),"insert into mir_core.model_versions(organization_id,model_id,version,specification) values($1,$2,1,'{}')",[id(20),id(40)],'23503');
      assert.equal((await actor(id(2),count('model_versions')))[0].n,0);
    });
    await db.exec(`insert into mir_core.suppliers(organization_id,id,name,email) values('${id(10)}','${id(50)}','Test','supplier@example.invalid');
      insert into mir_core.orders(organization_id,id,kind,owner_id,supplier_id) values
      ('${id(10)}','${id(60)}','supplier','${id(1)}','${id(50)}'),
      ('${id(10)}','${id(61)}','employee','${id(2)}',null),
      ('${id(10)}','${id(62)}','client','${id(3)}',null),
      ('${id(10)}','${id(63)}','client','${id(6)}',null);
      insert into mir_core.order_revisions(organization_id,order_id,revision,snapshot,created_by)
      select organization_id,id,1,'{}','${id(1)}' from mir_core.orders;`);
    await t.test('Employé et client lisent uniquement leurs propres demandes',async()=>{
      assert.deepEqual((await actor(id(2),'select id from mir_core.orders')).map(r=>r.id),[id(61)]);
      assert.deepEqual((await actor(id(3),'select id from mir_core.orders')).map(r=>r.id),[id(62)]);
      assert.equal((await actor(id(3),count('order_revisions')))[0].n,1);
      await reject(id(3),"insert into mir_core.orders(organization_id,kind,owner_id) values($1,'client',$2)",[id(10),id(3)],'42501');
    });
    await t.test('Une pièce peut être ajoutée sans modèle; quantités invalides refusées',async()=>{
      const sql="insert into mir_core.order_lines(organization_id,order_id,revision,quantity,unit,specification) values($1,$2,1,$3,'po',$4)";
      await actor(id(1),sql,[id(10),id(60),2,{dimensions:{A:'1/2'},length:120}]);
      assert.equal((await actor(id(1),'select model_id from mir_core.order_lines'))[0].model_id,null);
      await reject(id(1),sql,[id(10),id(60),-1,{}],'23514');
      assert.equal((await actor(id(2),count('order_lines')))[0].n,0);
    });
    await t.test('Suppression des historiques et écritures directes des envois interdites',async()=>{
      await reject(id(1),'delete from mir_core.order_revisions',[],'42501');
      await reject(id(1),"insert into mir_core.send_jobs(organization_id) values($1)",[id(10)],'42501');
      assert.equal((await actor(id(2),count('send_jobs')))[0].n,0);
    });
    await t.test('Document lié à la révision; contrainte empêche deux envois de la même révision',async()=>{
      await db.query('insert into mir_core.documents(organization_id,id,order_id,revision,object_path,sha256) values($1,$2,$3,1,$4,$5)',[id(10),id(70),id(60),'private/test.pdf','a'.repeat(64)]);
      const sql="insert into mir_core.send_jobs(organization_id,order_id,revision,document_id,operation,idempotency_key,recipient) values($1,$2,1,$3,'purchase-order',$4,'supplier@example.invalid')";
      await db.query(sql,[id(10),id(60),id(70),id(80)]);
      await assert.rejects(db.query(sql,[id(10),id(60),id(70),id(81)]),e=>e.code==='23505');
      await assert.rejects(db.query(sql,[id(10),id(61),id(70),id(82)]),e=>e.code==='23503');
      assert.equal((await actor(id(3),count('documents')))[0].n,0);
      const job=(await db.query('select id from mir_core.send_jobs')).rows[0].id;
      await assert.rejects(db.query("insert into mir_core.send_attempts(organization_id,job_id,status) values($1,$2,'accepted')",[id(10),job]),e=>e.code==='23514');
    });
    const backup={schema:'mir-local-backup-1',entries:[{key:'mir_production_templates_v1',raw:'{"version":1,"records":[]}'}]};
    const stage=(user,payload=backup)=>actor(user,'select mir_core.stage_local_backup($1,$2) as id',[id(10),payload]);
    await t.test('Migration en quarantaine : confirmation, dédoublonnage et aucune commande créée',async()=>{
      const a=await stage(id(1)),b=await stage(id(1));assert.equal(a[0].id,b[0].id);
      assert.equal((await actor(id(1),count('import_batches')))[0].n,1);
      assert.equal((await actor(id(1),count('orders')))[0].n,4);
      assert.deepEqual((await actor(id(1),'select backup from mir_core.import_batches'))[0].backup,backup);
      await actor(id(1),'select mir_core.revert_staged_backup($1,$2)',[id(10),a[0].id]);
      assert.equal((await actor(id(1),'select state from mir_core.import_batches'))[0].state,'reverted');
    });
    await t.test('Serveur refuse import étranger, employé, clé Auth, JSON corrompu et format absent',async()=>{
      for(const u of [id(2),id(3),id(4),id(5)])await assert.rejects(stage(u),e=>e.code==='42501');
      for(const payload of [{},null,{...backup,entries:[{key:'sb-auth-token',raw:'{}'}]}, {...backup,entries:[{key:backup.entries[0].key,raw:'null'}]}, {...backup,entries:[backup.entries[0],backup.entries[0]]}])
        await assert.rejects(stage(id(1),payload),e=>e.code==='22023');
    });
    await t.test('Désactivation : permissions révoquées à la prochaine requête',async()=>{
      await db.query('update mir_core.memberships set active=false where user_id=$1',[id(2)]);
      assert.equal((await actor(id(2),count('orders')))[0].n,0);
      assert.equal((await actor(id(2),count('catalogue_items')))[0].n,0);
    });
    await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/202611060003_shared_catalogue.sql'),'utf8'));
    await t.test('Publication unique, prix serveur et isolation du catalogue',async()=>{
      const sql='select mir_core.publish_model($1,$2,1,$3,$4) as revision';
      const settings={boutique:true,store:true,supplier_po:true,aluminum_cents:2500,steel_cents:3000,locked_measures:{A:'3 1/2'}};
      await reject(id(3),sql,[id(10),id(40),0,settings],'42501');
      assert.equal((await actor(id(1),sql,[id(10),id(40),0,settings]))[0].revision,1);
      assert.equal((await actor(id(3),count('model_publications')))[0].n,1);
      assert.equal((await actor(id(4),count('model_publications')))[0].n,0);
      await reject(id(3),'update mir_core.model_publications set steel_cents=1',[],'42501');
      await reject(id(1),sql,[id(10),id(40),0,settings],'40001');
      await actor(id(1),sql,[id(10),id(40),1,{...settings,archived:true}]);
      assert.equal((await actor(id(3),count('model_publications')))[0].n,0);
    });
    await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/202611060004_connected_catalogue.sql'),'utf8'));
    await t.test('Demandes partagées : sessions indépendantes, prix serveur et reprise idempotente',async()=>{
      await db.exec("update mir_core.memberships set active=true;update mir_core.model_publications set archived=false");
      const snapshot=(await actor(id(3),'select public.mir_shared_snapshot($1) as data',[id(10)]))[0].data;
      assert.equal(snapshot.catalogue.length,1);
      const model=snapshot.catalogue[0],config={metal:'acier',quantity:2,color:'Noir',measures:{A:'3 1/2',length:'120'}};
      const sql='select public.mir_submit_request($1,$2,$3,$4,$5) as id',args=[id(10),id(91),id(40),model.revision,config];
      const first=(await actor(id(3),sql,args))[0].id;
      assert.equal((await actor(id(3),sql,args))[0].id,first);
      await reject(id(3),sql,[...args.slice(0,4),{...config,quantity:3}],'22023');
      await assert.rejects(actor(id(3),sql,[id(10),id(92),id(40),model.revision,{...config,measures:{A:'99'}}]));
      await assert.rejects(actor(id(3),sql,[id(10),id(93),id(40),model.revision,{...config,price:1}]));
      const before=(await actor(id(3),'select public.mir_shared_snapshot($1) as data',[id(10)]))[0].data.orders.find(o=>o.id===first);
      assert.equal(before.snapshot.unitPriceCents,3000);assert.equal(before.snapshot.totalCents,6000);
      await db.exec('update mir_core.model_publications set steel_cents=9000,revision=revision+1');
      const after=(await actor(id(3),'select public.mir_shared_snapshot($1) as data',[id(10)]))[0].data;
      assert.equal(after.catalogue[0].steelCents,9000);assert.equal(after.orders.find(o=>o.id===first).snapshot.totalCents,6000);
      assert.equal((await actor(id(6),'select public.mir_shared_snapshot($1) as data',[id(10)]))[0].data.orders.some(o=>o.id===first),false);
      const admin=(await actor(id(1),'select public.mir_shared_snapshot($1) as data',[id(10)]))[0].data;assert.ok(admin.orders.some(o=>o.id===first));
      const employee=(await actor(id(2),'select public.mir_shared_snapshot($1) as data',[id(10)]))[0].data;
      assert.equal(employee.catalogue[0].steelCents,null);
      await actor(id(1),'select public.mir_assign_job($1,$2,$3)',[id(10),'Chantier test',id(2)]);
      const jid=(await actor(id(2),'select public.mir_shared_snapshot($1) as data',[id(10)]))[0].data.jobs[0].id;
      await actor(id(2),sql,[id(10),id(94),id(40),employee.catalogue[0].revision,{...config,chantier:jid}]);
      await reject(id(4),'select public.mir_shared_snapshot($1)',[id(10)],'42501');
    });
    // Proposed repair is evaluated ONLY in this disposable local database.
    await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/proposals/202611060005_preserve_version_options.sql'),'utf8'));
    await t.test('Import explicite sans doublon et nouvelle version sans écrasement',async()=>{
      const M=require('../dist/production-model.js'),template=M.createTemplate({kind:'profile',template:'l',unit:'in',dimensions:{A:3,B:2}},{id:'local',name:'Solin'}).template;
      const record={id:'local',name:'Solin',currentVersion:1,versions:[template],allowed:{materials:['aluminium'],colorSystems:['manufacturer']}};
      const query='select public.mir_import_master($1,$2) as id';
      await reject(id(2),query,[id(10),record],'42501');
      const model=(await actor(id(1),query,[id(10),record]))[0].id;
      assert.equal((await actor(id(1),query,[id(10),record]))[0].id,model);
      await reject(id(1),query,[id(10),{...record,name:'Autre'}],'40001');
      const next=M.createTemplate({kind:'profile',template:'l',unit:'in',dimensions:{A:4,B:2}},{id:'local',name:'Solin',version:2}).template;
      await actor(id(1),'select public.mir_add_master_version($1,$2,1,$3)',[id(10),model,next]);
      const versions=await actor(id(1),'select version from mir_core.model_versions where model_id=$1 order by version',[model]);assert.deepEqual(versions.map(r=>r.version),[1,2]);
      const p=(await actor(id(1),'select * from mir_core.model_publications where model_id=$1',[model]))[0];assert.equal(p.boutique,false);assert.equal(p.store,false);assert.equal(p.revision,2);
      const nextSpec=(await actor(id(1),'select specification from mir_core.model_versions where model_id=$1 and version=2',[model]))[0].specification;assert.deepEqual(nextSpec.allowed,record.allowed,'une révision ne doit pas élargir les métaux autorisés');
      const originalSpec=(await actor(id(1),'select specification from mir_core.model_versions where model_id=$1 and version=1',[model]))[0].specification;assert.deepEqual(originalSpec.template,template,'la version originale reste intacte');
    });
    await t.test('J à soffite 12 pi : demande de soumission sans prix inventé',async()=>{
      const M=require('../dist/production-model.js'),t=M.createTemplate({kind:'profile',template:'j',unit:'in',dimensions:{A:1,B:3,C:1}},{id:'j-soffite',name:'J à soffite'}).template;
      const model=(await actor(id(1),'select public.mir_import_master($1,$2) as id',[id(10),{id:'j-soffite',name:'J à soffite',currentVersion:1,versions:[t]}]))[0].id;
      const settings={boutique:true,store:true,sale_length_in:144,standard_measures:{},locked_measures:{}};
      await actor(id(1),'select public.mir_admin_publish_model($1,$2,1,$3)',[id(10),model,settings]);
      const oid=(await actor(id(3),'select public.mir_submit_request($1,$2,$3,2,$4) as id',[id(10),id(97),model,{metal:'acier',quantity:1,color:'Noir',measures:{A:'1',B:'3',C:'1',length:'144'}}]))[0].id;
      const snap=(await actor(id(3),'select snapshot from mir_core.order_revisions where order_id=$1',[oid]))[0].snapshot;assert.equal(snap.saleLengthIn,144);assert.equal(snap.unitPriceCents,null);
    });
    await t.test('Toutes les tables du schéma sont sous RLS',async()=>{
      const r=await db.query("select relname from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname='mir_core' and relkind='r' and not relrowsecurity");assert.equal(r.rows.length,0);
    });
  }finally{await db.close();}
});
