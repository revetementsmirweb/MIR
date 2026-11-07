'use strict';
/* Static security contract for a PROPOSAL; does not replace hosted SQL/RLS tests. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const sql=fs.readFileSync(path.join(__dirname,'../supabase/proposals/202611070006_warehouse_stock_qr.sql'),'utf8');
for(const table of ['warehouse_access','warehouse_skus','warehouse_stock','warehouse_fulfillment','warehouse_movements']){
 assert.match(sql,new RegExp('create table mir_core\\.'+table+'\\b'),'table '+table);
}
assert.match(sql,/alter table mir_core\.%I enable row level security/);
assert.match(sql,/revoke all on mir_core\.%I from public,anon,authenticated/);
assert.match(sql,/warehouse_allowed\(org\)/);
assert.match(sql,/m\.user_id=auth\.uid\(\) and m\.active/);
assert.match(sql,/unique\(organization_id,request_id\)/);
assert.match(sql,/pg_advisory_xact_lock/);
assert.match(sql,/for update/);
assert.match(sql,/if balance\.on_hand\+delta<0/);
assert.match(sql,/if -delta>rem/);
assert.match(sql,/if prior\.actor_id<>auth\.uid\(\)/);
assert.match(sql,/warehouse_auto_link_line/);
assert.match(sql,/source_ref=candidate/);
assert.match(sql,/grant execute on function %s to authenticated/);
assert.doesNotMatch(sql,/grant (?:update|insert|delete) on mir_core\.warehouse_(?:stock|movements|fulfillment) to authenticated/i);
console.log('PASS MIR Entrepôt: RLS, accès employés, SQL atomique, stock non négatif, reliquat et idempotence (contrat statique).');
