import assert from 'node:assert/strict';
// hon.lock_school_account_authority() (0191) takes these nine tables NOWAIT in SHARE ROW EXCLUSIVE mode.
// Autovacuum/autoanalyze hold SHARE UPDATE EXCLUSIVE, so a background worker that happens to start on one
// of them turns an expected 200/409 into the recoverable 503 ACCOUNT_BUSY (NOT_SUBMITTED). Disposable proofs
// pause background maintenance on exactly these tables and restore the defaults afterwards; recoverable busy
// itself stays covered deterministically by the explicit blocker-connection groups.
export const schoolAccountAuthorityTables=['organizations','schools','users','principals','principal_role_grants','hq_operator_grants','family_access_grants','roles','role_permissions'];
export async function pauseSchoolAccountAuthorityAutovacuum(client){
  const definition=(await client.query("SELECT pg_get_functiondef('hon.lock_school_account_authority()'::regprocedure) d")).rows[0].d;
  const locked=definition.match(/LOCK TABLE([^;]+)IN SHARE ROW EXCLUSIVE MODE NOWAIT/)?.[1].split(',').map(t=>t.trim().replace(/^hon\./,'')).sort();
  assert.deepEqual(locked,[...schoolAccountAuthorityTables].sort(),'Account authority lock set changed; update the paused tables.');
  for(const table of schoolAccountAuthorityTables)await client.query('ALTER TABLE hon.'+table+' SET (autovacuum_enabled=false)');
  return async()=>{for(const table of schoolAccountAuthorityTables)await client.query('ALTER TABLE hon.'+table+' RESET (autovacuum_enabled)');};
}
export const schoolAccountTables=['school_owner_invitations','school_account_requests','school_account_events','school_staff_invitations','school_staff_account_events','school_family_access_invitations','school_family_account_events'];
export async function verifySchoolAccountSecurity(client,runtime) {
  for(const table of schoolAccountTables){
    const q=(await client.query('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+table])).rows[0];assert(q.rls&&q.forced);
    assert.equal((await client.query("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[table])).rows[0].n,'0');
    for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']){
      assert.equal((await client.query('SELECT has_table_privilege($1,$2,$3) ok',[runtime,'hon.'+table,privilege])).rows[0].ok,false,table+':'+privilege);
    }
    const columns=(await client.query('SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped',['hon.'+table])).rows;
    for(const {attname}of columns)for(const privilege of ['SELECT','INSERT','UPDATE','REFERENCES'])assert.equal((await client.query('SELECT has_column_privilege($1,$2,$3,$4) ok',[runtime,'hon.'+table,attname,privilege])).rows[0].ok,false);
  }
  const fns=(await client.query("SELECT p.oid,p.proname,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname=ANY($1)",[['guard_school_account_evidence','guard_school_owner_invitation','lock_school_account_authority','check_school_owner_acceptance','school_invitation_json','school_account_result','school_account_record','manage_school_owner_invitation','accept_school_owner_invitation','read_school_owner_invitations']])).rows;
  assert.equal(fns.length,10);
  for(const f of fns){const allowed=['manage_school_owner_invitation','accept_school_owner_invitation','read_school_owner_invitations'].includes(f.proname);
    assert.equal(f.prosecdef,allowed);assert(f.proconfig.includes('search_path=pg_catalog, hon'));
    assert.equal((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime,f.oid])).rows[0].ok,allowed);
    assert.equal((await client.query("SELECT count(*) n FROM pg_proc, LATERAL aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE oid=$1 AND a.grantee=0 AND a.privilege_type='EXECUTE'",[f.oid])).rows[0].n,'0');
  }
}
