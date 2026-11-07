-- MIR Coordination — proposition additive, NON exécutée sur Supabase hébergé.
-- Prérequis : socle mir_core + proposition 006 Entrepôt QR.
-- Les originaux des commandes et des bons restent conservés.
begin;
do $$begin
 if to_regclass('mir_core.orders') is null or to_regclass('mir_core.order_lines') is null or
    to_regclass('mir_core.warehouse_fulfillment') is null or to_regclass('mir_core.warehouse_stock') is null then
    raise exception 'Schémas MIR / Entrepôt manquants. Ne pas installer de double système de commandes.';
 end if;
end$$;

-- Adjointe = capacité accordée à un EMPLOYÉ actif par l'Admin; pas un rôle
-- ou un bouton que l'utilisateur peut se donner lui-même.
create table mir_core.coordination_access (
 organization_id uuid not null,
 user_id uuid not null,
 active boolean not null default true,
 granted_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 primary key(organization_id,user_id),
 foreign key(organization_id,user_id) references mir_core.memberships(organization_id,user_id)
);
create function mir_core.coordination_allowed(org uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,mir_core as $$
 select mir_core.has_role(org,array['admin']) or exists(
  select 1 from mir_core.memberships m join mir_core.coordination_access a
   on(a.organization_id,a.user_id)=(m.organization_id,m.user_id)
  where m.organization_id=org and m.user_id=auth.uid() and m.role='employee'
   and m.active and a.active
 );
$$;
revoke all on function mir_core.coordination_allowed(uuid) from public,anon;
grant execute on function mir_core.coordination_allowed(uuid) to authenticated;

-- Commande mère : un seul dossier employé avec états ENTREPROT / FOURNISSEURS
-- séparés. La ligne 'employee' d'origine et son snapshot ne sont pas remplacés.
create table mir_core.coordination_orders (
 organization_id uuid not null,
 id uuid not null default gen_random_uuid(),
 employee_order_id uuid not null,
 revision integer not null default 1 check(revision>0),
 job text not null default '',
 delivery_address text not null default '',
 team text not null default '',
 priority text not null default 'normal' check(priority in ('normal','urgent')),
 notes text not null default '',
 shipped_at timestamptz,
 shipped_by uuid references auth.users(id),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(organization_id,id),
 unique(organization_id,employee_order_id),
 foreign key(organization_id,employee_order_id) references mir_core.orders(organization_id,id)
);
create table mir_core.coordination_lines (
 organization_id uuid not null,
 id uuid not null default gen_random_uuid(),
 coordination_id uuid not null,
 employee_line_id uuid not null,
 origin text not null default 'original' check(origin in ('original','added')),
 requested_qty numeric(15,3) not null check(requested_qty>0),
 item_name text not null check(length(item_name) between 1 and 220),
 unit text not null check(length(unit) between 1 and 35),
 variant_key text not null default '',
 specification jsonb not null default '{}' check(jsonb_typeof(specification)='object'),
 added_by uuid references auth.users(id),
 created_at timestamptz not null default now(),
 primary key(organization_id,id),
 unique(organization_id,employee_line_id),
 foreign key(organization_id,coordination_id) references mir_core.coordination_orders(organization_id,id),
 foreign key(organization_id,employee_line_id) references mir_core.order_lines(organization_id,id)
);
create index coordination_lines_by_order on mir_core.coordination_lines(organization_id,coordination_id);

create table mir_core.coordination_routes (
 organization_id uuid not null,
 id uuid not null default gen_random_uuid(),
 coordination_line_id uuid not null,
 route text not null check(route in ('warehouse','supplier')),
 quantity numeric(15,3) not null check(quantity>0),
 supplier_id uuid,
 supplier_order_id uuid,
 supplier_line_id uuid,
 received_qty numeric(15,3) not null default 0 check(received_qty>=0 and received_qty<=quantity),
 production_status text not null default 'to_order' check(production_status in ('to_order','ordered','in_production','ready','received_partial','received')),
 notes text not null default '',
 created_at timestamptz not null default now(),
 primary key(organization_id,id),
 foreign key(organization_id,coordination_line_id) references mir_core.coordination_lines(organization_id,id),
 foreign key(organization_id,supplier_id) references mir_core.suppliers(organization_id,id),
 foreign key(organization_id,supplier_order_id) references mir_core.orders(organization_id,id),
 foreign key(organization_id,supplier_line_id) references mir_core.order_lines(organization_id,id),
 check((route='warehouse' and supplier_id is null and supplier_order_id is null and supplier_line_id is null and received_qty=0)
    or(route='supplier' and supplier_id is not null)),
 check((supplier_order_id is null)=(supplier_line_id is null))
);
create unique index coordination_one_warehouse_route
 on mir_core.coordination_routes(organization_id,coordination_line_id) where route='warehouse';
create unique index coordination_supplier_route_unique
 on mir_core.coordination_routes(organization_id,coordination_line_id,supplier_id) where route='supplier';
create index coordination_routes_by_order on mir_core.coordination_routes(organization_id,coordination_line_id);

-- Journal append-only et confirmations magasinier par utilisateur.
create table mir_core.coordination_events (
 organization_id uuid not null,
 id uuid not null default gen_random_uuid(),
 coordination_id uuid not null,
 revision integer not null,
 event_type text not null check(event_type in ('received','routed','quantity_added','po_linked','supplier_received','supplier_status','warehouse_shipped','note_changed')),
 payload jsonb not null default '{}' check(jsonb_typeof(payload)='object'),
 actor_id uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 primary key(organization_id,id),
 unique(organization_id,coordination_id,revision),
 foreign key(organization_id,coordination_id) references mir_core.coordination_orders(organization_id,id)
);
create table mir_core.coordination_acks (
 organization_id uuid not null,
 coordination_id uuid not null,
 user_id uuid not null references auth.users(id),
 seen_revision integer not null check(seen_revision>=0),
 seen_at timestamptz not null default now(),
 primary key(organization_id,coordination_id,user_id),
 foreign key(organization_id,coordination_id) references mir_core.coordination_orders(organization_id,id)
);
create table mir_core.coordination_shipments (
 organization_id uuid not null,
 id uuid not null default gen_random_uuid(),
 coordination_id uuid not null,
 revision integer not null,
 shipped_by uuid not null references auth.users(id),
 payload jsonb not null check(jsonb_typeof(payload)='object'),
 shipped_at timestamptz not null default now(),
 primary key(organization_id,id),
 unique(organization_id,coordination_id),
 foreign key(organization_id,coordination_id) references mir_core.coordination_orders(organization_id,id)
);
create table mir_core.coordination_ops (
 organization_id uuid not null,
 request_id uuid not null,
 actor_id uuid not null references auth.users(id),
 op text not null,
 signature jsonb not null,
 result jsonb not null,
 created_at timestamptz not null default now(),
 primary key(organization_id,request_id)
);

do $$declare t text;begin
 foreach t in array array['coordination_access','coordination_orders','coordination_lines',
  'coordination_routes','coordination_events','coordination_acks','coordination_shipments','coordination_ops'] loop
  execute format('alter table mir_core.%I enable row level security',t);
  execute format('revoke all on mir_core.%I from public,anon,authenticated',t);
 end loop;
end$$;
create policy coordination_access_view on mir_core.coordination_access for select to authenticated
 using(mir_core.has_role(organization_id,array['admin']) or user_id=auth.uid());
do $$declare t text;begin
 foreach t in array array['coordination_orders','coordination_lines','coordination_routes','coordination_events',
   'coordination_acks','coordination_shipments'] loop
  execute format('create policy coordination_read on mir_core.%I for select to authenticated using(mir_core.coordination_allowed(organization_id) or mir_core.warehouse_allowed(organization_id))',t);
 end loop;
end$$;
-- Ne pas GRANT INSERT/UPDATE/DELETE aux navigateurs : RPC uniquement.

-- Cette garde s'applique même si l'ancien RPC QR tente un prélèvement non réparti.
-- Il protège la séparation Entrepôt / À commander et bloque les sorties après expédition.
create function mir_core.coordination_guard_picking() returns trigger
language plpgsql security definer set search_path=pg_catalog,mir_core as $$
declare co mir_core.coordination_orders;max_pick numeric;begin
 select o.* into co from mir_core.coordination_orders o
 join mir_core.coordination_lines l on(l.organization_id,l.coordination_id)=(o.organization_id,o.id)
 where l.organization_id=new.organization_id and l.employee_line_id=new.order_line_id;
 if not found then return new;end if;
 if co.shipped_at is not null and new.delivered_qty>old.delivered_qty then
  raise exception 'Entrepôt déjà expédié : nouvelle demande requise' using errcode='40001';
 end if;
 select coalesce(sum(r.quantity),0) into max_pick from mir_core.coordination_routes r
 join mir_core.coordination_lines l on(l.organization_id,l.id)=(r.organization_id,r.coordination_line_id)
 where l.organization_id=new.organization_id and l.employee_line_id=new.order_line_id and r.route='warehouse';
 if new.delivered_qty>max_pick then
  raise exception 'Cette quantité ne fait pas partie du lot Entrepôt' using errcode='22023';
 end if;
 return new;
end$$;
revoke all on function mir_core.coordination_guard_picking() from public,anon,authenticated;
create trigger mir_coordination_limit_picking
 before update on mir_core.warehouse_fulfillment
 for each row execute function mir_core.coordination_guard_picking();

-- Autorisation Admin / magasinier ; aucune information de chantier dans le QR.
create function public.mir_coordination_memberships() returns jsonb
language sql stable security definer set search_path=pg_catalog,mir_core as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name,
  'assistant',mir_core.coordination_allowed(o.id),
  'warehouse',mir_core.warehouse_allowed(o.id),
  'admin',mir_core.has_role(o.id,array['admin']))),'[]'::jsonb)
 from mir_core.organizations o
 where mir_core.coordination_allowed(o.id) or mir_core.warehouse_allowed(o.id);
$$;
create function public.mir_coordination_grant(org uuid,member uuid,allowed boolean) returns boolean
language plpgsql security definer set search_path=pg_catalog,mir_core as $$
begin
 if not mir_core.has_role(org,array['admin']) then raise exception 'Admin requis' using errcode='42501';end if;
 if allowed is null or not exists(select 1 from mir_core.memberships where organization_id=org
 and user_id=member and role='employee' and active) then raise exception 'Employé actif requis' using errcode='22023';end if;
 insert into mir_core.coordination_access(organization_id,user_id,active,granted_by)
 values(org,member,allowed,auth.uid())
 on conflict(organization_id,user_id) do update set active=excluded.active,
 granted_by=excluded.granted_by,created_at=now();
 return true;
end$$;

-- Vue limitée de la boîte de réception ; les commandes sans lignes serveur sont
-- signalées, JAMAIS transformées en produits fictifs.
create function public.mir_coordination_inbox(org uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,mir_core as $$
declare out jsonb;begin
 if not mir_core.coordination_allowed(org) then raise exception 'Coordination non autorisée' using errcode='42501';end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'sourceOrderId',o.id,'id',c.id,'revision',c.revision,
  'job',coalesce(c.job,r.snapshot->'configuration'->>'chantier',r.snapshot->>'job',''),
  'address',coalesce(c.delivery_address,r.snapshot->>'address',''),
  'team',coalesce(c.team,''),
  'priority',coalesce(c.priority,'normal'),
  'lineCount',(select count(*) from mir_core.order_lines ol where ol.organization_id=org and ol.order_id=o.id),
  'status',case when c.shipped_at is not null then 'warehouse_shipped'
   when c.id is null then 'new' else 'in_progress' end
 ) order by o.created_at desc),'[]'::jsonb) into out
 from mir_core.orders o
 left join mir_core.coordination_orders c on (c.organization_id,c.employee_order_id)=(o.organization_id,o.id)
 left join mir_core.order_revisions r on(r.organization_id,r.order_id,r.revision)=(o.organization_id,o.id,o.revision)
 where o.organization_id=org and o.kind='employee' and o.status<>'cancelled';
 return out;
end$$;

-- Seule une adjointe/admin peut ouvrir une commande mère.
create function public.mir_coordination_open(org uuid,source_order uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,mir_core as $$
declare o mir_core.orders;co mir_core.coordination_orders;src jsonb;count_lines integer;begin
 if not mir_core.coordination_allowed(org) then raise exception 'Coordination non autorisée' using errcode='42501';end if;
 select * into o from mir_core.orders where organization_id=org and id=source_order for update;
 if not found or o.kind<>'employee' or o.status='cancelled' then raise exception 'Commande employé introuvable' using errcode='22023';end if;
 select count(*) into count_lines from mir_core.order_lines where organization_id=org and order_id=source_order;
 if count_lines=0 then raise exception 'Commande sans lignes serveur : importer/valider la demande avant triage' using errcode='22023';end if;
 select snapshot into src from mir_core.order_revisions
 where organization_id=org and order_id=source_order and revision=o.revision;
 insert into mir_core.coordination_orders(organization_id,employee_order_id,created_by,job,delivery_address,team,notes)
 values(org,source_order,auth.uid(),coalesce(src->'configuration'->>'chantier',src->>'job',''),
 coalesce(src->>'address',src->>'shipTo',''),coalesce(src->>'team',''),coalesce(src->>'note',''))
 on conflict(organization_id,employee_order_id) do nothing;
 select * into co from mir_core.coordination_orders
 where organization_id=org and employee_order_id=source_order for update;
 insert into mir_core.coordination_lines(organization_id,coordination_id,employee_line_id,origin,requested_qty,
 item_name,unit,variant_key,specification)
 select org,co.id,ol.id,'original',ol.quantity,
 coalesce(ol.specification->>'name',ol.specification->>'itemName','Référence à identifier'),
 ol.unit,coalesce(ol.specification->>'stockKey',ol.specification->>'inventoryKey',''),
 ol.specification from mir_core.order_lines ol
 where ol.organization_id=org and ol.order_id=source_order
 on conflict(organization_id,employee_line_id) do nothing;
 insert into mir_core.coordination_events(organization_id,coordination_id,revision,event_type,actor_id)
 values(org,co.id,1,'received',auth.uid()) on conflict(organization_id,coordination_id,revision) do nothing;
 return jsonb_build_object('id',co.id,'revision',co.revision,'sourceOrderId',source_order);
end$$;

-- Détails réutilisés par l'écran Adjointe et le tableau de bord Entrepôt.
create function public.mir_coordination_detail(org uuid,coord_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,mir_core as $$
declare out jsonb;co mir_core.coordination_orders;begin
 if not(mir_core.coordination_allowed(org) or mir_core.warehouse_allowed(org)) then
 raise exception 'Accès interdit' using errcode='42501';end if;
 select * into co from mir_core.coordination_orders where organization_id=org and id=coord_id;
 if not found then raise exception 'Commande introuvable' using errcode='22023';end if;
 select jsonb_build_object('id',co.id,'sourceOrderId',co.employee_order_id,'revision',co.revision,
  'job',co.job,'address',co.delivery_address,'team',co.team,'priority',co.priority,
  'shippedAt',co.shipped_at,'notes',case when mir_core.coordination_allowed(org) then co.notes else '' end,
  'lines',coalesce((select jsonb_agg(jsonb_build_object(
    'id',l.id,'sourceLineId',l.employee_line_id,'name',l.item_name,'unit',l.unit,'requestedQty',l.requested_qty,
    'variantKey',l.variant_key,'routes',coalesce((select jsonb_agg(jsonb_build_object(
      'id',a.id,'lane',a.route,'quantity',a.quantity,'supplierId',a.supplier_id,
      'supplierOrderId',a.supplier_order_id,'receivedQty',a.received_qty,'productionStatus',a.production_status,
       'pickedQty',case when a.route='warehouse' then coalesce((select f.delivered_qty from mir_core.warehouse_fulfillment f where f.organization_id=l.organization_id and f.order_line_id=l.employee_line_id),0) else null end))
      from mir_core.coordination_routes a where a.organization_id=org and a.coordination_line_id=l.id),'[]'::jsonb))
    order by l.created_at) from mir_core.coordination_lines l
    where l.organization_id=org and l.coordination_id=co.id),'[]'::jsonb),
  'events',coalesce((select jsonb_agg(jsonb_build_object(
    'revision',e.revision,'type',e.event_type,'payload',e.payload,'actorId',e.actor_id,'at',e.created_at))
    from mir_core.coordination_events e where e.organization_id=org and e.coordination_id=co.id),'[]'::jsonb)
 ) into out;
 return out;
end$$;

do $$declare item record;begin
 for item in select * from (values
 ('public.mir_coordination_memberships()'),
 ('public.mir_coordination_grant(uuid,uuid,boolean)'),
 ('public.mir_coordination_inbox(uuid)'),
 ('public.mir_coordination_open(uuid,uuid)'),
 ('public.mir_coordination_detail(uuid,uuid)')
 ) as names(signature) loop
  execute format('revoke all on function %s from public,anon',item.signature);
  execute format('grant execute on function %s to authenticated',item.signature);
 end loop;
end$$;
commit;