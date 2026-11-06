-- Run only in the existing project's SQL Editor (postgres administrator).
-- SELECT only. No migration, account provisioning, JWT impersonation or writes.
BEGIN READ ONLY;
WITH expected_tables(name) AS (VALUES
 ('organizations'),('memberships'),('models'),('model_versions'),('catalogue_items'),
 ('suppliers'),('orders'),('order_revisions'),('order_lines'),('order_events'),
 ('documents'),('send_jobs'),('send_attempts'),('import_batches'),('model_publications'),
 ('request_keys'),('jobs'),('job_memberships'),('model_sources')),
expected_functions(signature) AS (VALUES
 ('public.mir_my_memberships()'),('public.mir_shared_snapshot(uuid)'),
 ('public.mir_submit_request(uuid,uuid,uuid,integer,jsonb)'),
 ('public.mir_import_master(uuid,jsonb)'),
 ('public.mir_admin_publish_model(uuid,uuid,integer,jsonb)'),
 ('public.mir_add_master_version(uuid,uuid,integer,jsonb)'),
 ('public.mir_assign_job(uuid,text,uuid)'))
SELECT jsonb_build_object(
 'schema','mir-mission-4-audit-1','observedAt',now(),
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',e.name,'exists',c.oid IS NOT NULL,'rls',coalesce(c.relrowsecurity,false)))
 FROM expected_tables e LEFT JOIN pg_namespace n ON n.nspname='mir_core'
 LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=e.name AND c.relkind='r'),
 'routines',(SELECT jsonb_agg(jsonb_build_object('signature',e.signature,'exists',p.oid IS NOT NULL,
 'securityDefiner',coalesce(p.prosecdef,false),'config',p.proconfig,
 'anonymousExecute',CASE WHEN p.oid IS NOT NULL THEN has_function_privilege('anon',p.oid,'EXECUTE') ELSE NULL END,
 'authenticatedExecute',CASE WHEN p.oid IS NOT NULL THEN has_function_privilege('authenticated',p.oid,'EXECUTE') ELSE NULL END,
 'definitionMd5',CASE WHEN p.oid IS NOT NULL THEN md5(pg_get_functiondef(p.oid)) ELSE NULL END))
 FROM expected_functions e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)),
 'policies',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',tablename,'name',policyname,'command',cmd,'roles',roles,'using',qual,'check',with_check)),'[]') FROM pg_policies WHERE schemaname='mir_core'),
 'saleLengthColumn',EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='mir_core' AND table_name='model_publications' AND column_name='sale_length_in'),
 'migrationHistoryPresent',to_regclass('supabase_migrations.schema_migrations') IS NOT NULL,
 'apiSchemasSetting',current_setting('pgrst.db_schemas',true),
 'note','Object presence verifies a contract, not that the exact migration file was executed. No migration was run.'
) AS audit;
ROLLBACK;
