export const A2P_SCOPE_BODY_SHA256='b43923e631e0754e70c4c039c2cddceb7b8a00a7a1f4ac41bb2da03d7b136419';
export async function verifyA2pPreparationSecurity(client,runtime='hon_runtime') {
  if(!/^hon_[a-z_]+$/.test(runtime))throw Error('Unsafe A2P runtime alias');
  const row=(await client.query(`SELECT p.prosecdef,p.provolatile,p.proconfig,
    encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') body_hash,(o.rolsuper OR o.rolbypassrls) trusted,
    has_function_privilege($1,p.oid,'EXECUTE') allowed,
    (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname) overloads,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$1) OR a.is_grantable OR a.privilege_type<>'EXECUTE')) unsafe
    FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid='hon.read_a2p_preparation_scope(text)'::regprocedure`,[runtime])).rows[0];
  if(!row?.prosecdef||row.provolatile!=='v'||!row.trusted||!row.allowed||row.unsafe||Number(row.overloads)!==1
    ||JSON.stringify(row.proconfig)!==JSON.stringify(['search_path=pg_catalog, hon'])||row.body_hash!==A2P_SCOPE_BODY_SHA256)throw Error('A2P exact scope function security drift');
  const permission=(await client.query("SELECT is_sensitive,is_staff_assignable FROM hon.permissions WHERE code='communication.a2p.prepare'")).rows[0];
  if(!permission?.is_sensitive||!permission.is_staff_assignable)throw Error('A2P permission boundary drift');
}
