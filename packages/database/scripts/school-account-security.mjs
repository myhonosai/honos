import assert from 'node:assert/strict';
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
