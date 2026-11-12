// CS1 Creative Studio generations (proposed 0216): private deny-all tables on the CW1 school wallet, reachable only
// through four fixed SECURITY DEFINER entry points. Request fields are immutable (one SUBMITTING -> terminal move) and
// results are append-only evidence. HQ's own Creative Studio (0253, hq_creative_*) is a separate system with its own
// security proof (test-hq-creative-studio.mjs) and is excluded from this school inventory.
// A1 (0276) adds creative_avatars: one avatar per avatar.create generation, three runtime entry points, a private
// SECURITY DEFINER deferred guard that refuses an avatar.* generation without its avatar at commit.
// A2 (0277) adds creative_avatar_videos (one avatar.video generation each, three runtime entry points) and replaces that
// guard's body so each avatar.* operation needs its own record and any other avatar.* operation is refused.
export const creativeStudioTables = ['creative_generations', 'creative_generation_assets', 'creative_avatars', 'creative_avatar_videos'];
// [signature, runtime may execute, SECURITY DEFINER]
export const creativeStudioFunctions = [
  ['hon.creative_prompt_ok(text)', false, false],
  ['hon.guard_creative_generation()', false, false],
  ['hon.creative_generation_json(hon.creative_generations)', false, false],
  ['hon.creative_generation_fingerprint(uuid,jsonb)', false, false],
  ['hon.create_creative_generation(text,uuid,jsonb,jsonb,uuid,uuid,uuid)', true, true],
  ['hon.record_creative_generation_result(text,uuid,jsonb)', true, true],
  ['hon.read_creative_generations(text,uuid)', true, true],
  ['hon.read_creative_generation(text,uuid,uuid)', true, true],
  ['hon.creative_avatar_name_ok(text)', false, false],
  ['hon.guard_creative_avatar_generation()', false, true],
  ['hon.creative_avatar_json(hon.creative_avatars)', false, false],
  ['hon.creative_avatar_fingerprint(uuid,jsonb)', false, false],
  ['hon.create_creative_avatar(text,uuid,jsonb,jsonb,uuid,uuid,uuid)', true, true],
  ['hon.read_creative_avatars(text,uuid)', true, true],
  ['hon.read_creative_avatar(text,uuid,uuid)', true, true],
  ['hon.creative_avatar_video_json(hon.creative_avatar_videos)', false, false],
  ['hon.creative_avatar_video_fingerprint(uuid,jsonb)', false, false],
  ['hon.create_creative_avatar_video(text,uuid,jsonb,jsonb,uuid,uuid,uuid)', true, true],
  ['hon.read_creative_avatar_videos(text,uuid)', true, true],
  ['hon.read_creative_avatar_video(text,uuid,uuid)', true, true],
];
const triggers = [
  ['creative_generations', 'creative_generation_guarded', 27, 'guard_creative_generation'],
  ['creative_generations', 'creative_generation_no_truncate', 34, 'guard_creative_generation'],
  ['creative_generation_assets', 'creative_generation_asset_immutable', 27, 'guard_saas_evidence'],
  ['creative_generation_assets', 'creative_generation_asset_no_truncate', 34, 'guard_saas_evidence'],
  ['creative_generations', 'creative_generation_avatar_required', 5, 'guard_creative_avatar_generation'],
  ['creative_avatars', 'creative_avatar_immutable', 27, 'guard_saas_evidence'],
  ['creative_avatars', 'creative_avatar_no_truncate', 34, 'guard_saas_evidence'],
  ['creative_avatar_videos', 'creative_avatar_video_immutable', 27, 'guard_saas_evidence'],
  ['creative_avatar_videos', 'creative_avatar_video_no_truncate', 34, 'guard_saas_evidence'],
];
export async function verifyCreativeStudioSecurity(client, runtime) {
  if (!/^hon_[a-z_]+$/.test(runtime)) throw new Error('Unsafe Creative Studio runtime role.');
  for (const table of creativeStudioTables) {
    const r = (await client.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>$2
      AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND a.grantee<>c.relowner) safe
      FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=$1::regclass`, [`hon.${table}`, runtime])).rows[0];
    if (r?.safe !== true) throw new Error(`Unsafe Creative Studio table ${table}`);
  }
  for (const [table, name, type, fn] of triggers) {
    const t = (await client.query(`SELECT count(*)=1 safe FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2 AND tgtype=$3
      AND tgfoid=$4::regprocedure AND tgenabled='O' AND NOT tgisinternal`, [`hon.${table}`, name, type, `hon.${fn}()`])).rows[0];
    if (t.safe !== true) throw new Error(`Unsafe Creative Studio trigger ${table}.${name}`);
  }
  // The avatar guard must run at commit (after the avatar wrapper inserts the avatar row), never be skipped per statement.
  const deferred = (await client.query(`SELECT tgdeferrable AND tginitdeferred AND tgconstraint<>0 ok FROM pg_trigger
    WHERE tgrelid='hon.creative_generations'::regclass AND tgname='creative_generation_avatar_required'`)).rows[0];
  if (deferred?.ok !== true) throw new Error('Unsafe Creative Studio avatar guard: not a deferred constraint trigger');
  const total = (await client.query("SELECT count(*)::int n FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname ~ '(^|_)creative_(prompt|generation|avatar)|creative_generations?$|_creative_generation' AND proname !~ '(^|_)hq_creative_'")).rows[0].n;
  if (total !== creativeStudioFunctions.length) throw new Error(`Untracked Creative Studio functions: ${total}`);
  for (const [signature, execute, definer] of creativeStudioFunctions) {
    const r = (await client.query(`SELECT p.prosecdef=$3 AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>$2
      AND has_function_privilege($2,p.oid,'EXECUTE')=$4
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner
        AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2) OR NOT $4 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) safe
      FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=$1::regprocedure`, [signature, runtime, definer, execute])).rows[0];
    if (r?.safe !== true) throw new Error(`Unsafe Creative Studio function ${signature}`);
    for (const role of (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows) {
      if ((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [role.rolname, signature])).rows[0].allowed) throw new Error(`Forbidden client Creative Studio function ${role.rolname}`);
    }
  }
}
