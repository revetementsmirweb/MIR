-- PROPOSAL ONLY. Not applied to hosted Supabase by tests or deployment.
-- Preserve material/color permissions when adding geometry revisions.
begin;
create or replace function public.mir_add_master_version(org uuid,model uuid,expected_revision integer,template jsonb) returns integer
language plpgsql security definer set search_path=pg_catalog,mir_core as $$
declare v integer;p mir_core.model_publications;begin
 if not mir_core.has_role(org,array['admin']) then raise exception 'Admin requis' using errcode='42501';end if;
 perform 1 from mir_core.models where organization_id=org and id=model for update;
 select * into p from mir_core.model_publications where organization_id=org and model_id=model;
 if not found or p.revision<>expected_revision then raise exception 'Conflit de révision' using errcode='40001';end if;
 if template->>'schema' is distinct from 'mir-production-template-1' or jsonb_typeof(template->'fields') is distinct from 'array' then raise exception 'Géométrie inconnue';end if;
 select max(version)+1 into v from mir_core.model_versions where organization_id=org and model_id=model;
 if (template->>'version')::integer is distinct from v then raise exception 'Numéro de version suivant requis';end if;
 insert into mir_core.model_versions(organization_id,model_id,version,specification) values(org,model,v,jsonb_build_object('template',template,'allowed',(select specification->'allowed' from mir_core.model_versions where organization_id=org and model_id=model and version=p.version)));
 update mir_core.model_publications set version=v,revision=revision+1,boutique=false,store=false where organization_id=org and model_id=model;
 return p.revision+1;
end $$;
revoke all on function public.mir_add_master_version(uuid,uuid,integer,jsonb) from public,anon;
grant execute on function public.mir_add_master_version(uuid,uuid,integer,jsonb) to authenticated;
commit;
