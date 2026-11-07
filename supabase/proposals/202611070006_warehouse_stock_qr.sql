-- MIR Entrepôt — migration proposée, NON appliquée à Supabase hébergé.
-- Dépend de mir_core (migrations 001–004) et des comptes membres existants.
-- Exécuter uniquement après audit hébergé, sauvegarde et revue de sécurité.
begin;
do $$begin
 if to_regnamespace('mir_core') is null or to_regclass('mir_core.memberships') is null or to_regclass('mir_core.order_lines') is null then
  raise exception 'Socle MIR manquant : ne pas créer de schéma parallèle';
 end if;
end$$;

create table mir_core.warehouse_access (
 organization_id uuid not null,
 user_id uuid not null,
 active boolean not null default true,
 granted_by uuid not null references auth.users(id),
 granted_at timestamptz not null default now(),
 primary key(organization_id,user_id),
 foreign key(organization_id,user_id) references mir_core.memberships(organization_id,user_id)
);

-- Le QR est un lien opaque et permanent vers un SKU/variante, pas un mouvement.
create table mir_core.warehouse_skus (
 organization_id uuid not null references mir_core.organizations(id),
 id uuid not null default gen_random_uuid(),
 source_kind text not null check(source_kind in ('hardware','bending')),
 source_ref text not null check(length(source_ref) between 1 and 300),
 sku text not null check(length(sku) between 2 and 80),
 name text not null check(length(name) between 1 and 180),
 unit text not null check(length(unit) between 1 and 40),
 quantity_step numeric(15,3) not null default 1 check(quantity_step>0),
 qr_token uuid not null default gen_random_uuid(),
 archived boolean not null default false,
 created_at timestamptz not null default now(),
 primary key(organization_id,id),
 unique(organization_id,source_kind,source_ref),
 unique(organization_id,sku),
 unique(qr_token)
);
create index mir_warehouse_sku_lookup on mir_core.warehouse_skus(organization_id,lower(sku));

create table mir_core.warehouse_stock (
 organization_id uuid not null,
 sku_id uuid not null,
 on_hand numeric(15,3) not null default 0 check(on_hand>=0),
 revision bigint not null default 1 check(revision>0),
 updated_at timestamptz not null default now(),
 primary key(organization_id,sku_id),
 foreign key(organization_id,sku_id) references mir_core.warehouse_skus(organization_id,id)
);

-- Une seule ligne d'exécution pour chaque ligne immuable d'une commande MIR.
-- Ne transforme pas une commande brouillon en livraison automatique.
create table mir_core.warehouse_fulfillment (
 organization_id uuid not null,
 order_line_id uuid not null,
 sku_id uuid not null,
 delivered_qty numeric(15,3) not null default 0 check(delivered_qty>=0),
 cancelled_qty numeric(15,3) not null default 0 check(cancelled_qty>=0),
 updated_at timestamptz not null default now(),
 primary key(organization_id,order_line_id),
 foreign key(organization_id,order_line_id) references mir_core.order_lines(organization_id,id),
 foreign key(organization_id,sku_id) references mir_core.warehouse_skus(organization_id,id)
);
create index mir_warehouse_fulfillment_sku on mir_core.warehouse_fulfillment(organization_id,sku_id);

-- Registre append-only : pas d'écrasement ni suppression côté navigateur.
create table mir_core.warehouse_movements (
 organization_id uuid not null,
 id uuid not null default gen_random_uuid(),
 sku_id uuid not null,
 order_line_id uuid,
 actor_id uuid not null references auth.users(id),
 request_id uuid not null,
 delta numeric(15,3) not null check(delta<>0),
 reason text not null check(length(reason) between 3 and 300),
 kind text not null check(kind in ('delivery','adjustment','receipt')),
 stock_before numeric(15,3) not null check(stock_before>=0),
 stock_after numeric(15,3) not null check(stock_after>=0),
 remaining_after numeric(15,3),
 created_at timestamptz not null default now(),
 primary key(organization_id,id),
 unique(organization_id,request_id),
 foreign key(organization_id,sku_id) references mir_core.warehouse_skus(organization_id,id),
 foreign key(organization_id,order_line_id) references mir_core.warehouse_fulfillment(organization_id,order_line_id)
);

-- Interdiction d'accès direct aux écritures et aux identités étrangères.
do $$declare t text;begin
 foreach t in array array['warehouse_access','warehouse_skus','warehouse_stock','warehouse_fulfillment','warehouse_movements'] loop
  execute format('alter table mir_core.%I enable row level security',t);
  execute format('revoke all on mir_core.%I from public,anon,authenticated',t);
 end loop;
end$$;

-- Même identité Auth / organisation que les autres services MIR. Le rôle Entrepôt
-- est un droit explicite sur un compte employé actif, jamais un drapeau navigateur.
create function mir_core.warehouse_allowed(org uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,mir_core as $$
 select exists (
   select 1 from mir_core.memberships m
   where m.organization_id=org and m.user_id=auth.uid() and m.active
     and (m.role='admin' or (m.role='employee' and exists (
       select 1 from mir_core.warehouse_access a
       where a.organization_id=org and a.user_id=auth.uid() and a.active
     )))
 );
$$;
revoke all on function mir_core.warehouse_allowed(uuid) from public,anon;
grant execute on function mir_core.warehouse_allowed(uuid) to authenticated;

create policy warehouse_access_read on mir_core.warehouse_access for select to authenticated
 using(mir_core.has_role(organization_id,array['admin']) or user_id=auth.uid());
create policy warehouse_sku_read on mir_core.warehouse_skus for select to authenticated
 using(mir_core.warehouse_allowed(organization_id));
create policy warehouse_stock_read on mir_core.warehouse_stock for select to authenticated
 using(mir_core.warehouse_allowed(organization_id));
create policy warehouse_fulfillment_read on mir_core.warehouse_fulfillment for select to authenticated
 using(mir_core.warehouse_allowed(organization_id));
create policy warehouse_movements_read on mir_core.warehouse_movements for select to authenticated
 using(mir_core.warehouse_allowed(organization_id));
grant select on mir_core.warehouse_access,mir_core.warehouse_skus,mir_core.warehouse_stock,
 mir_core.warehouse_fulfillment,mir_core.warehouse_movements to authenticated;

create function public.mir_warehouse_memberships() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,mir_core as $$
declare out jsonb;begin
 if auth.uid() is null then raise exception 'Connexion requise' using errcode='42501';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name,'isAdmin',mir_core.has_role(o.id,array['admin']))), '[]'::jsonb)
 into out from mir_core.organizations o where mir_core.warehouse_allowed(o.id);
 return out;
end$$;

create function public.mir_warehouse_grant_access(org uuid,member uuid,allow_access boolean)
returns boolean language plpgsql security definer set search_path=pg_catalog,mir_core as $$
begin
 if not mir_core.has_role(org,array['admin']) then raise exception 'Admin requis' using errcode='42501';end if;
 if member is null or allow_access is null or not exists(
  select 1 from mir_core.memberships m where m.organization_id=org
    and m.user_id=member and m.role='employee' and m.active
 ) then raise exception 'Employé MIR actif requis' using errcode='22023';end if;
 insert into mir_core.warehouse_access(organization_id,user_id,active,granted_by)
 values(org,member,allow_access,auth.uid())
 on conflict(organization_id,user_id) do update set active=excluded.active,
 granted_by=excluded.granted_by,granted_at=now();
 return true;
end$$;

create function public.mir_warehouse_register(org uuid,kind text,source_ref text,sku_code text,display_name text,unit_name text,step numeric)
returns jsonb language plpgsql security definer set search_path=pg_catalog,mir_core as $$
declare sku_row mir_core.warehouse_skus;begin
 if not mir_core.has_role(org,array['admin']) then raise exception 'Admin requis' using errcode='42501';end if;
 if kind not in ('hardware','bending') or source_ref is null or length(btrim(source_ref)) not between 1 and 300
  or sku_code is null or sku_code !~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$'
  or display_name is null or length(btrim(display_name)) not between 1 and 180
  or unit_name is null or length(btrim(unit_name)) not between 1 and 40
  or step is null or step<=0 or step>1000 or scale(step)>3 then
  raise exception 'Référence de stock invalide' using errcode='22023';
 end if;
 if kind='bending' and not exists(
   select 1 from mir_core.models m where m.organization_id=org
   and m.id::text=source_ref and not m.archived
 ) then raise exception 'Moulure introuvable dans Mes pliages partagés' using errcode='22023';end if;
 insert into mir_core.warehouse_skus(organization_id,source_kind,source_ref,sku,name,unit,quantity_step)
 values(org,kind,source_ref,sku_code,btrim(display_name),btrim(unit_name),step)
 on conflict(organization_id,source_kind,source_ref) do nothing;
 select * into sku_row from mir_core.warehouse_skus
 where organization_id=org and source_kind=kind and warehouse_skus.source_ref=mir_warehouse_register.source_ref;
 if sku_row.sku<>sku_code or sku_row.name<>btrim(display_name) or sku_row.unit<>btrim(unit_name) or sku_row.quantity_step<>step then
  raise exception 'Référence existante : aucune modification silencieuse de SKU/QR' using errcode='40001';end if;
 insert into mir_core.warehouse_stock(organization_id,sku_id) values(org,sku_row.id) on conflict do nothing;
 return jsonb_build_object('id',sku_row.id,'sku',sku_row.sku,'qrToken',sku_row.qr_token);
end$$;

-- Appariement explicite sur l'identité stable de variante, pas sur un nom approximatif.
create function public.mir_warehouse_link_order_line(org uuid,line_id uuid,sku_id uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,mir_core as $$
declare ln mir_core.order_lines;item mir_core.warehouse_skus;ord mir_core.orders;
 ref text;begin
 if not mir_core.has_role(org,array['admin']) then raise exception 'Admin requis' using errcode='42501';end if;
 select * into ln from mir_core.order_lines where organization_id=org and id=line_id;
 if not found then raise exception 'Ligne de commande introuvable' using errcode='22023';end if;
 select * into ord from mir_core.orders where organization_id=org and id=ln.order_id;
 if ord.kind<>'employee' or ord.status='cancelled' then raise exception 'Commande employé active requise' using errcode='22023';end if;
 select * into item from mir_core.warehouse_skus where organization_id=org and id=sku_id and not archived;
 if not found then raise exception 'Référence de stock introuvable' using errcode='22023';end if;
 ref:=coalesce(ln.specification->>'stockKey',ln.specification->>'inventoryKey');
 if ref is null or ref<>item.source_ref then raise exception 'SKU/variante différente de la commande' using errcode='22023';end if;
 insert into mir_core.warehouse_fulfillment(organization_id,order_line_id,sku_id)
 values(org,line_id,sku_id) on conflict do nothing;
 if not exists(select 1 from mir_core.warehouse_fulfillment
 where organization_id=org and order_line_id=line_id and warehouse_fulfillment.sku_id=sku_id) then
 raise exception 'Ligne déjà liée à une autre référence' using errcode='40001';end if;
 return true;
end$$;

create function public.mir_warehouse_search(org uuid,term text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,mir_core as $
declare out jsonb;q text;begin
 if not mir_core.warehouse_allowed(org) then raise exception 'Accès Entrepôt requis' using errcode='42501';end if;
 q:=left(btrim(coalesce(term,'')),100);
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'sku',x.sku,'name',x.name,
  'qrToken',x.qr_token,'unit',x.unit,'sourceKind',x.source_kind,'onHand',x.on_hand)
  order by x.name),'[]'::jsonb) into out
 from (select s.id,s.sku,s.name,s.qr_token,s.unit,s.source_kind,coalesce(b.on_hand,0) as on_hand
 from mir_core.warehouse_skus s left join mir_core.warehouse_stock b
 on (b.organization_id,b.sku_id)=(s.organization_id,s.id)
 where s.organization_id=org and not s.archived
 and (q='' or s.sku ilike '%'||q||'%' or s.name ilike '%'||q||'%')
 order by s.name limit 40)x;
 return out;
end$;

-- Les commandes employé sont reliées automatiquement UNIQUEMENT lorsqu'elles
-- enregistrent l'identité exacte de variante. Jamais de rapprochement par nom.
create function mir_core.warehouse_auto_link_line() returns trigger
language plpgsql security definer set search_path=pg_catalog,mir_core as $
declare candidate text;matched uuid;kind text;begin
 select o.kind into kind from mir_core.orders o
 where o.organization_id=new.organization_id and o.id=new.order_id;
 if kind is distinct from 'employee' then return new;end if;
 candidate:=coalesce(new.specification->>'stockKey',new.specification->>'inventoryKey');
 if candidate is null then return new;end if;
 select s.id into matched from mir_core.warehouse_skus s
 where s.organization_id=new.organization_id and s.source_ref=candidate
 and s.source_kind=case when new.model_id is null then 'hardware' else 'bending' end
 and not s.archived;
 if matched is not null then
  insert into mir_core.warehouse_fulfillment(organization_id,order_line_id,sku_id)
  values(new.organization_id,new.id,matched) on conflict do nothing;
 end if;
 return new;
end$;
revoke all on function mir_core.warehouse_auto_link_line() from public,anon,authenticated;
create trigger mir_warehouse_link_employee_lines
 after insert on mir_core.order_lines
 for each row execute function mir_core.warehouse_auto_link_line();

create function public.mir_warehouse_snapshot(org uuid,qr uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,mir_core as $$
declare product mir_core.warehouse_skus;stock mir_core.warehouse_stock;pending jsonb;log_rows jsonb;begin
 if not mir_core.warehouse_allowed(org) then raise exception 'Accès Entrepôt requis' using errcode='42501';end if;
 select * into product from mir_core.warehouse_skus where organization_id=org and qr_token=qr and not archived;
 if not found then raise exception 'Code QR inconnu ou article archivé' using errcode='22023';end if;
 select * into stock from mir_core.warehouse_stock where organization_id=org and sku_id=product.id;
 select coalesce(jsonb_agg(jsonb_build_object(
  'orderId',ol.order_id,'lineId',ol.id,'skuId',product.id,'requestedQty',ol.quantity,
  'deliveredQty',f.delivered_qty,'cancelledQty',f.cancelled_qty,
  'remainingQty',ol.quantity-f.delivered_qty-f.cancelled_qty,
  'job',coalesce(r.snapshot->>'job',''),'status',o.status
 ) order by o.created_at desc),'[]'::jsonb) into pending
 from mir_core.warehouse_fulfillment f
 join mir_core.order_lines ol on ol.organization_id=f.organization_id and ol.id=f.order_line_id
 join mir_core.orders o on o.organization_id=ol.organization_id and o.id=ol.order_id
 left join mir_core.order_revisions r on r.organization_id=o.organization_id and r.order_id=o.id and r.revision=o.revision
 where f.organization_id=org and f.sku_id=product.id and ol.quantity>f.delivered_qty+f.cancelled_qty and o.status<>'cancelled';
 select coalesce(jsonb_agg(jsonb_build_object('at',m.created_at,'delta',m.delta,'kind',m.kind,
 'reason',m.reason,'actorId',m.actor_id,'orderLineId',m.order_line_id)
 order by m.created_at desc),'[]'::jsonb) into log_rows
 from (select * from mir_core.warehouse_movements where organization_id=org and sku_id=product.id order by created_at desc limit 40)m;
 return jsonb_build_object(
  'sku',jsonb_build_object('id',product.id,'sku',product.sku,'name',product.name,'unit',product.unit,
    'sourceKind',product.source_kind,'sourceRef',product.source_ref,
    'step',product.quantity_step,'qrToken',product.qr_token,'onHand',coalesce(stock.on_hand,0),'revision',stock.revision),
  'orders',pending,'movements',log_rows
 );
end$$;

create function public.mir_warehouse_queue(org uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,mir_core as $$
declare out jsonb;begin
 if not mir_core.warehouse_allowed(org) then raise exception 'Accès Entrepôt requis' using errcode='42501';end if;
 select coalesce(jsonb_agg(jsonb_build_object(
 'orderId',c.order_id,'lineId',c.id,'skuId',s.id,'qrToken',s.qr_token,'sku',s.sku,'name',s.name,
 'requestedQty',c.quantity,'deliveredQty',f.delivered_qty,
 'remainingQty',c.quantity-f.delivered_qty-f.cancelled_qty,'unit',s.unit,
 'job',coalesce(r.snapshot->>'job','')
 ) order by o.created_at desc),'[]'::jsonb) into out
 from mir_core.warehouse_fulfillment f
 join mir_core.order_lines c on (c.organization_id,c.id)=(f.organization_id,f.order_line_id)
 join mir_core.orders o on (o.organization_id,o.id)=(c.organization_id,c.order_id)
 join mir_core.warehouse_skus s on (s.organization_id,s.id)=(f.organization_id,f.sku_id)
 left join mir_core.order_revisions r on (r.organization_id,r.order_id,r.revision)=(o.organization_id,o.id,o.revision)
 where f.organization_id=org and c.quantity>f.delivered_qty+f.cancelled_qty and o.status<>'cancelled';
 return out;
end$$;

-- Une seule transaction atomique pour le stock et le reliquat, avec idempotence.
create function public.mir_warehouse_move(
 org uuid,qr uuid,line_id uuid,delta numeric,request_id uuid,reason text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,mir_core as $$
declare sku_row mir_core.warehouse_skus;balance mir_core.warehouse_stock;
 fulfil mir_core.warehouse_fulfillment;line_row mir_core.order_lines;ord mir_core.orders;
 prior mir_core.warehouse_movements;kind text;rem numeric;out jsonb; note text;begin
 if not mir_core.warehouse_allowed(org) then raise exception 'Accès Entrepôt requis' using errcode='42501';end if;
 if qr is null or request_id is null or delta is null or delta=0 or abs(delta)>100000 or scale(delta)>3 then
  raise exception 'Mouvement invalide' using errcode='22023';end if;
 note:=btrim(coalesce(reason,''));
 if length(note) not between 3 and 300 then raise exception 'Motif requis' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(org::text||request_id::text,0));
 select * into prior from mir_core.warehouse_movements
  where organization_id=org and warehouse_movements.request_id=mir_warehouse_move.request_id;
 if found then
  if prior.actor_id<>auth.uid() or prior.delta<>delta or
    prior.order_line_id is distinct from line_id or prior.reason<>note or
    not exists(select 1 from mir_core.warehouse_skus p where p.organization_id=org
    and p.id=prior.sku_id and p.qr_token=qr) then
   raise exception 'La requête a déjà servi pour un mouvement différent' using errcode='40001';end if;
  return jsonb_build_object('movementId',prior.id,'stockAfter',prior.stock_after,
    'remainingAfter',prior.remaining_after,'replayed',true);
 end if;
 select * into sku_row from mir_core.warehouse_skus where organization_id=org and qr_token=qr and not archived;
 if not found then raise exception 'QR de stock inconnu' using errcode='22023';end if;
 if abs(delta)/sku_row.quantity_step<>trunc(abs(delta)/sku_row.quantity_step) then
  raise exception 'Format de vente incompatible avec cette quantité' using errcode='22023';end if;
 select * into balance from mir_core.warehouse_stock where organization_id=org and sku_id=sku_row.id for update;
 if not found then raise exception 'Stock non initialisé' using errcode='22023';end if;
 if balance.on_hand+delta<0 then raise exception 'Stock insuffisant' using errcode='22023';end if;
 rem:=null;
 if line_id is not null then
  if delta>=0 then raise exception 'Une livraison est une sortie de stock' using errcode='22023';end if;
  select * into fulfil from mir_core.warehouse_fulfillment where organization_id=org and order_line_id=line_id for update;
  if not found or fulfil.sku_id<>sku_row.id then raise exception 'Ligne non associée à ce QR' using errcode='22023';end if;
  select * into line_row from mir_core.order_lines where organization_id=org and id=line_id;
  select * into ord from mir_core.orders where organization_id=org and id=line_row.order_id;
  if ord.kind<>'employee' or ord.status='cancelled' then raise exception 'Commande non livrable' using errcode='22023';end if;
  rem:=line_row.quantity-fulfil.delivered_qty-fulfil.cancelled_qty;
  if -delta>rem then raise exception 'Quantité supérieure au reliquat' using errcode='22023';end if;
  update mir_core.warehouse_fulfillment set delivered_qty=delivered_qty-delta,updated_at=now()
   where organization_id=org and order_line_id=line_id;
  rem:=rem+delta;kind:='delivery';
 else
  if delta>0 then kind:='receipt';
  else kind:='adjustment';end if;
 end if;
 update mir_core.warehouse_stock set on_hand=on_hand+delta,revision=revision+1,updated_at=now()
   where organization_id=org and sku_id=sku_row.id;
 insert into mir_core.warehouse_movements(organization_id,sku_id,order_line_id,actor_id,request_id,
  delta,reason,kind,stock_before,stock_after,remaining_after)
 values(org,sku_row.id,line_id,auth.uid(),request_id,delta,note,kind,balance.on_hand,balance.on_hand+delta,rem)
 returning id into prior.id;
 return jsonb_build_object('movementId',prior.id,'stockAfter',balance.on_hand+delta,
   'remainingAfter',rem,'replayed',false);
end$$;

-- Les RPC sont des portes contrôlées; aucun UPDATE direct à l'inventaire.
do $$declare item record;begin
 for item in select * from (values
 ('public.mir_warehouse_memberships()'),
 ('public.mir_warehouse_grant_access(uuid,uuid,boolean)'),
 ('public.mir_warehouse_register(uuid,text,text,text,text,text,numeric)'),
 ('public.mir_warehouse_link_order_line(uuid,uuid,uuid)'),
 ('public.mir_warehouse_search(uuid,text)'),
 ('public.mir_warehouse_snapshot(uuid,uuid)'),
 ('public.mir_warehouse_queue(uuid)'),
 ('public.mir_warehouse_move(uuid,uuid,uuid,numeric,uuid,text)')
 ) as funcs(name) loop
  execute format('revoke all on function %s from public,anon',item.name);
  execute format('grant execute on function %s to authenticated',item.name);
 end loop;
end$$;
commit;