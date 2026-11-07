-- MIR Coordination — opérations atomiques proposées, NON appliquées en production.
-- Prérequis : proposition Entrepôt 006, schéma Coordination 007, audités en test.
begin;

-- Les opérations répétées conservent leur identifiant de requête : aucune
-- seconde route, aucun deuxième bon ni deuxième départ après une coupure.
create function mir_core.coordination_replay(org uuid,request_id uuid,operation text,payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,mir_core as $$
declare found_op mir_core.coordination_ops;begin
 if request_id is null then raise exception 'Identifiant de requête requis' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(org::text||request_id::text,0));
 select * into found_op from mir_core.coordination_ops
 where organization_id=org and coordination_ops.request_id=coordination_replay.request_id;
 if found then
  if found_op.actor_id<>auth.uid() or found_op.op<>operation or found_op.signature is distinct from payload then
    raise exception 'Cette référence a déjà servi pour une action différente' using errcode='40001';
  end if;
  return found_op.result||jsonb_build_object('replayed',true);
 end if;
 return null;
end$$;
create function mir_core.coordination_receipt(org uuid,request_id uuid,operation text,payload jsonb,result jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,mir_core as $$
begin
 insert into mir_core.coordination_ops(organization_id,request_id,actor_id,op,signature,result)
 values(org,request_id,auth.uid(),operation,payload,result);
 return result;
end$$;
revoke all on function mir_core.coordination_replay(uuid,uuid,text,jsonb),
mir_core.coordination_receipt(uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated;

create function public.mir_coordination_route(
 org uuid,coord_id uuid,coord_line uuid,warehouse_qty numeric,suppliers jsonb,
 expected_revision integer,request_id uuid
) returns jsonb language plpgsql security definer set search_path=pg_catalog,mir_core as $$
declare o mir_core.coordination_orders;l mir_core.coordination_lines;
 item jsonb; vendor uuid; q numeric; total numeric; prior jsonb;result jsonb;revision_next integer;
 old_routes integer; old_matched integer; picked numeric;payload jsonb;
begin
 if not mir_core.coordination_allowed(org) then raise exception 'Adjointe MIR requise' using errcode='42501';end if;
 payload:=jsonb_build_object('coordId',coord_id,'lineId',coord_line,'warehouseQty',warehouse_qty,
  'suppliers',suppliers,'expectedRevision',expected_revision);
 prior:=mir_core.coordination_replay(org,request_id,'route',payload);if prior is not null then return prior;end if;
 select * into o from mir_core.coordination_orders where organization_id=org and id=coord_id for update;
 if not found or o.shipped_at is not null then raise exception 'Commande expédiée ou inconnue' using errcode='40001';end if;
 if o.revision<>expected_revision then raise exception 'Commande modifiée : actualiser avant de répartir' using errcode='40001';end if;
 select * into l from mir_core.coordination_lines where organization_id=org and id=coord_line and coordination_id=o.id;
 if not found then raise exception 'Ligne inconnue' using errcode='22023';end if;
 if warehouse_qty is null or warehouse_qty<0 or warehouse_qty>l.requested_qty or scale(warehouse_qty)>3
 or jsonb_typeof(suppliers) is distinct from 'array' or jsonb_array_length(suppliers)>20
 then raise exception 'Répartition invalide' using errcode='22023';end if;
 select coalesce(f.delivered_qty,0) into picked from mir_core.warehouse_fulfillment f
 where f.organization_id=org and f.order_line_id=l.employee_line_id;
 if warehouse_qty<coalesce(picked,0) then raise exception 'Des pièces sont déjà scannées et sorties du stock' using errcode='22023';end if;
 if warehouse_qty>0 and not exists(
  select 1 from mir_core.warehouse_fulfillment f
  join mir_core.warehouse_skus s on(s.organization_id,s.id)=(f.organization_id,f.sku_id)
  where f.organization_id=org and f.order_line_id=l.employee_line_id
   and not s.archived and s.source_ref=l.variant_key
 ) then raise exception 'Lier la référence exacte au QR Entrepôt avant de répartir' using errcode='22023';end if;
 -- Un bon déjà créé ou une réception ne peut pas être effacé par changement de radio.
 if exists(select 1 from mir_core.coordination_routes r where r.organization_id=org
  and r.coordination_line_id=l.id and(r.supplier_order_id is not null or r.received_qty>0))
 then raise exception 'Bon fournisseur lié : créer une révision ou un complément; ne pas écraser les lignes' using errcode='40001';end if;
 total:=warehouse_qty;
 for item in select value from jsonb_array_elements(suppliers) loop
   if jsonb_typeof(item) is distinct from 'object' or item->>'supplierId' is null
    or item->>'quantity' is null then raise exception 'Fournisseur ou quantité manquante' using errcode='22023';end if;
   begin vendor:=(item->>'supplierId')::uuid;q:=(item->>'quantity')::numeric;
   exception when others then raise exception 'Référence fournisseur ou quantité invalide' using errcode='22023';end;
   if q<=0 or scale(q)>3 or q>l.requested_qty or not exists(
    select 1 from mir_core.suppliers s where s.organization_id=org and s.id=vendor and not s.archived
   ) then raise exception 'Fournisseur introuvable ou quantité hors limites' using errcode='22023';end if;
   total:=total+q;
 end loop;
 if total>l.requested_qty then raise exception 'Entrepôt + fournisseurs dépasse les quantités demandées' using errcode='22023';end if;
 delete from mir_core.coordination_routes where organization_id=org and coordination_line_id=l.id;
 if warehouse_qty>0 then insert into mir_core.coordination_routes(organization_id,coordination_line_id,route,quantity)
 values(org,l.id,'warehouse',warehouse_qty);end if;
 for item in select value from jsonb_array_elements(suppliers) loop
  insert into mir_core.coordination_routes(organization_id,coordination_line_id,route,quantity,supplier_id,notes)
  values(org,l.id,'supplier',(item->>'quantity')::numeric,(item->>'supplierId')::uuid,
   left(coalesce(item->>'note',''),500));
 end loop;
 revision_next:=o.revision+1;
 update mir_core.coordination_orders set revision=revision_next,updated_at=now() where organization_id=org and id=o.id;
 insert into mir_core.coordination_events(organization_id,coordination_id,revision,event_type,payload,actor_id)
 values(org,o.id,revision_next,'routed',jsonb_build_object('lineId',l.id,'name',l.item_name,
  'warehouse',warehouse_qty,'suppliers',suppliers,'unassigned',l.requested_qty-total),auth.uid());
 result:=jsonb_build_object('revision',revision_next,'lineId',l.id,'warehouse',warehouse_qty,'unassigned',l.requested_qty-total);
 return mir_core.coordination_receipt(org,request_id,'route',payload,result);
end$$;

-- +3 tubes Mono n'efface jamais la ligne 25 initiale. On ajoute une ligne
-- immuable au même dossier employé, et un événement clairement horodaté.
create function public.mir_coordination_add(
 org uuid,coord_id uuid,existing_coord_line uuid,additional_qty numeric,
 expected_revision integer,request_id uuid
) returns jsonb language plpgsql security definer set search_path=pg_catalog,mir_core as $$
declare o mir_core.coordination_orders;original mir_core.coordination_lines;
 src mir_core.order_lines;new_source uuid;new_line uuid;new_revision integer;prior jsonb;payload jsonb;result jsonb;begin
 if not mir_core.coordination_allowed(org) then raise exception 'Adjointe MIR requise' using errcode='42501';end if;
 payload:=jsonb_build_object('coordId',coord_id,'lineId',existing_coord_line,'additional',additional_qty,'expectedRevision',expected_revision);
 prior:=mir_core.coordination_replay(org,request_id,'add',payload);if prior is not null then return prior;end if;
 select * into o from mir_core.coordination_orders where organization_id=org and id=coord_id for update;
 if not found or o.shipped_at is not null then raise exception 'Commande déjà expédiée ou inconnue' using errcode='40001';end if;
 if o.revision<>expected_revision then raise exception 'Commande modifiée : actualiser avant ajout' using errcode='40001';end if;
 select * into original from mir_core.coordination_lines
 where organization_id=org and id=existing_coord_line and coordination_id=coord_id;
 if not found then raise exception 'Article inexistant dans cette commande' using errcode='22023';end if;
 if additional_qty is null or additional_qty<=0 or additional_qty>100000 or scale(additional_qty)>3
 then raise exception 'Quantité supplémentaire invalide' using errcode='22023';end if;
 select * into src from mir_core.order_lines where organization_id=org and id=original.employee_line_id;
 if not found or src.order_id<>o.employee_order_id then raise exception 'Source de l article introuvable' using errcode='22023';end if;
 insert into mir_core.order_lines(organization_id,order_id,revision,quantity,unit,specification,model_id,model_version)
 values(org,src.order_id,src.revision,additional_qty,src.unit,
  jsonb_set(src.specification,'{quantity}',to_jsonb(additional_qty),true)||jsonb_build_object('coordinationExtra',true),
  src.model_id,src.model_version) returning id into new_source;
 insert into mir_core.coordination_lines(organization_id,coordination_id,employee_line_id,origin,
  requested_qty,item_name,unit,variant_key,specification,added_by)
 values(org,o.id,new_source,'added',additional_qty,original.item_name,original.unit,
  original.variant_key,src.specification,auth.uid()) returning id into new_line;
 new_revision:=o.revision+1;
 update mir_core.coordination_orders set revision=new_revision,updated_at=now()
 where organization_id=org and id=o.id;
 insert into mir_core.coordination_events(organization_id,coordination_id,revision,event_type,payload,actor_id)
 values(org,o.id,new_revision,'quantity_added',
 jsonb_build_object('lineId',new_line,'sourceLineId',original.id,'sku',original.variant_key,
 'name',original.item_name,'unit',original.unit,'delta',additional_qty),auth.uid());
 result:=jsonb_build_object('revision',new_revision,'newLineId',new_line,
  'message','+'||additional_qty||' '||original.unit||' '||original.item_name);
 return mir_core.coordination_receipt(org,request_id,'add',payload,result);
end$$;

-- La préparation QR déduit le stock via la proposition 006. Cette action
-- clôture seulement la tâche Entrepôt, JAMAIS les commandes fournisseurs.
create function public.mir_coordination_ack(org uuid,coord_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,mir_core as $$
declare o mir_core.coordination_orders;begin
 if not mir_core.warehouse_allowed(org) then raise exception 'Entrepôt autorisé requis' using errcode='42501';end if;
 select * into o from mir_core.coordination_orders where organization_id=org and id=coord_id;
 if not found or o.shipped_at is not null then raise exception 'Commande inconnue ou expédiée' using errcode='40001';end if;
 insert into mir_core.coordination_acks(organization_id,coordination_id,user_id,seen_revision)
 values(org,coord_id,auth.uid(),o.revision)
 on conflict(organization_id,coordination_id,user_id) do update
 set seen_revision=excluded.seen_revision,seen_at=now();
 return jsonb_build_object('id',coord_id,'ackRevision',o.revision);
end$$;

create function public.mir_coordination_ship(
 org uuid,coord_id uuid,expected_revision integer,request_id uuid
) returns jsonb language plpgsql security definer set search_path=pg_catalog,mir_core as $$
declare o mir_core.coordination_orders;line record;num int;unread integer;
 payload jsonb;prior jsonb;result jsonb;new_revision integer;
begin
 if not mir_core.warehouse_allowed(org) then raise exception 'Entrepôt autorisé requis' using errcode='42501';end if;
 payload:=jsonb_build_object('coordId',coord_id,'expectedRevision',expected_revision);
 prior:=mir_core.coordination_replay(org,request_id,'ship',payload);if prior is not null then return prior;end if;
 select * into o from mir_core.coordination_orders where organization_id=org and id=coord_id for update;
 if not found or o.shipped_at is not null then raise exception 'Commande déjà expédiée ou introuvable' using errcode='40001';end if;
 if o.revision<>expected_revision then raise exception 'La commande a changé : actualiser avant expédition' using errcode='40001';end if;
 select coalesce(max(e.revision),0) into unread from mir_core.coordination_events e
 where e.organization_id=org and e.coordination_id=o.id
 and e.event_type in ('received','routed','quantity_added','note_changed');
 if not exists(select 1 from mir_core.coordination_acks a
 where a.organization_id=org and a.coordination_id=o.id
 and a.user_id=auth.uid() and a.seen_revision>=unread)
 then raise exception 'Lire et confirmer les modifications avant expédition' using errcode='42501';end if;
 select count(*) into num from mir_core.coordination_routes r
 join mir_core.coordination_lines l on(l.organization_id,l.id)=(r.organization_id,r.coordination_line_id)
 where l.organization_id=org and l.coordination_id=o.id and r.route='warehouse';
 if num=0 then raise exception 'Aucun article affecté à l Entrepôt' using errcode='22023';end if;
 for line in select l.item_name,r.quantity,coalesce(f.delivered_qty,0) as picked
  from mir_core.coordination_routes r
  join mir_core.coordination_lines l on(l.organization_id,l.id)=(r.organization_id,r.coordination_line_id)
  left join mir_core.warehouse_fulfillment f on(f.organization_id,f.order_line_id)=(l.organization_id,l.employee_line_id)
  where l.organization_id=org and l.coordination_id=o.id and r.route='warehouse'
 loop
  if line.picked<>line.quantity then
   raise exception 'Préparation incomplète : % (préparé %, demandé %)',
    line.item_name,line.picked,line.quantity using errcode='22023';
  end if;
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object(
 'name',l.item_name,'employeeLineId',l.employee_line_id,'quantity',r.quantity,'unit',l.unit)),
 '[]'::jsonb) into payload
 from mir_core.coordination_routes r
 join mir_core.coordination_lines l on(l.organization_id,l.id)=(r.organization_id,r.coordination_line_id)
 where l.organization_id=org and l.coordination_id=o.id and r.route='warehouse';
 payload:=jsonb_build_object('lines',payload,'job',o.job,'address',o.delivery_address,'team',o.team);
 new_revision:=o.revision+1;
 update mir_core.coordination_orders set shipped_at=now(),shipped_by=auth.uid(),
 revision=new_revision,updated_at=now() where organization_id=org and id=o.id;
 insert into mir_core.coordination_shipments(organization_id,coordination_id,revision,shipped_by,payload)
 values(org,o.id,new_revision,auth.uid(),payload);
 insert into mir_core.coordination_events(organization_id,coordination_id,revision,event_type,payload,actor_id)
 values(org,o.id,new_revision,'warehouse_shipped',payload,auth.uid());
 result:=jsonb_build_object('id',o.id,'revision',new_revision,'warehouseStatus','shipped',
  'overallStatus','external_if_pending','stockDeductedAtScan',true);
 return mir_core.coordination_receipt(org,request_id,'ship',
  jsonb_build_object('coordId',coord_id,'expectedRevision',expected_revision),result);
end$$;

-- La file de l'Entrepôt montre uniquement les articles ROUTÉS Entrepôt.
-- Une modification +3 reste visible jusqu'à acquittement, même après scan.
create function public.mir_coordination_warehouse_queue(org uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,mir_core as $$
declare out jsonb;begin
 if not mir_core.warehouse_allowed(org) then raise exception 'Entrepôt autorisé requis' using errcode='42501';end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',o.id,'sourceOrderId',o.employee_order_id,'revision',o.revision,'job',o.job,'address',o.delivery_address,
  'team',o.team,'priority',o.priority,'shippedAt',o.shipped_at,
  'unread',coalesce((select jsonb_agg(jsonb_build_object('revision',e.revision,'type',e.event_type,
   'payload',e.payload,'at',e.created_at) order by e.created_at)
   from mir_core.coordination_events e where e.organization_id=org and e.coordination_id=o.id
   and e.event_type in ('received','routed','quantity_added','note_changed')
   and e.revision>coalesce((select a.seen_revision from mir_core.coordination_acks a
    where a.organization_id=org and a.coordination_id=o.id and a.user_id=auth.uid()),0)),'[]'::jsonb),
  'lines',coalesce((select jsonb_agg(jsonb_build_object(
    'id',l.id,'sourceLineId',l.employee_line_id,'skuId',f.sku_id,'qrToken',s.qr_token,
    'name',l.item_name,'unit',l.unit,'requestedQty',r.quantity,
    'pickedQty',coalesce(f.delivered_qty,0),'remainingQty',r.quantity-coalesce(f.delivered_qty,0))
    order by l.created_at)
    from mir_core.coordination_routes r
    join mir_core.coordination_lines l on(l.organization_id,l.id)=(r.organization_id,r.coordination_line_id)
    left join mir_core.warehouse_fulfillment f on(f.organization_id,f.order_line_id)=(l.organization_id,l.employee_line_id)
    left join mir_core.warehouse_skus s on(s.organization_id,s.id)=(f.organization_id,f.sku_id)
    where l.organization_id=org and l.coordination_id=o.id and r.route='warehouse'),'[]'::jsonb)
  ) order by o.updated_at desc),'[]'::jsonb) into out
 from mir_core.coordination_orders o
 where o.organization_id=org and o.shipped_at is null and exists(
 select 1 from mir_core.coordination_lines l join mir_core.coordination_routes r
 on(r.organization_id,r.coordination_line_id)=(l.organization_id,l.id)
 where l.organization_id=org and l.coordination_id=o.id and r.route='warehouse');
 return out;
end$$;

do $$declare item record;begin
 for item in select * from (values
 ('public.mir_coordination_route(uuid,uuid,uuid,numeric,jsonb,integer,uuid)'),
 ('public.mir_coordination_add(uuid,uuid,uuid,numeric,integer,uuid)'),
 ('public.mir_coordination_ack(uuid,uuid)'),
 ('public.mir_coordination_ship(uuid,uuid,integer,uuid)'),
 ('public.mir_coordination_warehouse_queue(uuid)')
 ) as names(signature) loop
 execute format('revoke all on function %s from public,anon',item.signature);
 execute format('grant execute on function %s to authenticated',item.signature);
 end loop;
end$$;
commit;