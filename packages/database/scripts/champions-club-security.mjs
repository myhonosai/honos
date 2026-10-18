// Champions Club foundation (0148): private deny-all tables reachable only through fixed functions.
export const championsClubTables = ['champions_policies','champions_referral_codes','champions_attributions','champions_attribution_history','champions_requests','champions_audit','champions_outbox',
 'champions_reward_policies','champions_reward_entries','champions_reward_history','champions_leaderboard_preferences','champions_leaderboard_holds',
 'champions_contests','champions_contest_prizes','champions_contest_schools','champions_contest_pauses','champions_contest_results','champions_contest_winners','champions_contest_history'];
const evidenceTables = ['champions_attribution_history','champions_requests','champions_audit','champions_outbox','champions_reward_history','champions_contest_results','champions_contest_history'];
const rewardTables = ['champions_reward_policies','champions_reward_entries'];
const leaderboardTables = ['champions_leaderboard_preferences','champions_leaderboard_holds'];
const contestTables = ['champions_contests','champions_contest_prizes','champions_contest_schools','champions_contest_pauses','champions_contest_winners'];
// [signature, runtime may execute, SECURITY DEFINER]
export const championsClubFunctions = [
 ['hon.guard_champions_evidence()',false,false],
 ['hon.guard_champions_records()',false,false],
 ['hon.champions_refuse_context()',false,false],
 ['hon.require_champions_hq_actor(text,boolean)',false,true],
 ['hon.require_champions_school_actor(text,uuid)',false,true],
 ['hon.champions_claim_request(uuid,uuid,text,text,uuid,uuid)',false,true],
 ['hon.champions_record(uuid,uuid,text,text,text,uuid,uuid,jsonb,jsonb,jsonb,timestamptz)',false,true],
 ['hon.champions_fingerprint(text[])',false,false],
 ['hon.champions_ts(timestamptz)',false,false],
 ['hon.champions_policy_json(hon.champions_policies)',false,false],
 ['hon.champions_attribution_json(hon.champions_attributions)',false,true],
 ['hon.champions_orgs_share_user(uuid,uuid)',false,false],
 ['hon.issue_champions_referral_code(text,uuid,uuid,uuid,uuid)',true,true],
 ['hon.read_champions_school_view(text,uuid)',true,true],
 ['hon.read_champions_program_from_hq(text)',true,true],
 ['hon.create_champions_policy_draft(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.publish_champions_policy(text,uuid,uuid,uuid,uuid)',true,true],
 ['hon.capture_champions_attribution(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.decide_champions_attribution(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.read_champions_attributions_from_hq(text,text)',true,true],
 // 0149 reward accounting
 ['hon.guard_champions_rewards()',false,false],
 ['hon.champions_reward_policy_json(hon.champions_reward_policies)',false,false],
 ['hon.champions_reward_json(hon.champions_reward_entries)',false,true],
 ['hon.read_champions_reward_program_from_hq(text)',true,true],
 ['hon.create_champions_reward_policy_draft(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.publish_champions_reward_policy(text,uuid,uuid,uuid,uuid)',true,true],
 ['hon.reconcile_champions_rewards(text,uuid,uuid,uuid,uuid)',true,true],
 ['hon.decide_champions_reward(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.read_champions_reward_ledger_from_hq(text,text)',true,true],
 ['hon.read_champions_school_rewards(text,uuid)',true,true],
 // 0150 leaderboard
 ['hon.guard_champions_leaderboard()',false,false],
 ['hon.champions_period_month(text,text)',false,false],
 ['hon.champions_standings(date)',false,false],
 ['hon.champions_milestone_progress(integer)',false,false],
 ['hon.champions_school_statistics_json(uuid,boolean)',false,false],
 ['hon.read_champions_leaderboard_from_hq(text,text,text)',true,true],
 ['hon.read_champions_school_statistics_from_hq(text,uuid)',true,true],
 ['hon.set_champions_leaderboard_hold(text,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.read_champions_leaderboard_for_school(text,uuid,text,text)',true,true],
 ['hon.read_champions_school_statistics(text,uuid)',true,true],
 ['hon.set_champions_leaderboard_preference(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 // 0152 contests
 ['hon.guard_champions_contests()',false,false],
 ['hon.champions_contest_counts(uuid,timestamptz)',false,false],
 ['hon.champions_contest_standings(uuid)',false,false],
 ['hon.champions_contest_json(hon.champions_contests)',false,false],
 ['hon.champions_contest_write_config(uuid,jsonb,boolean)',false,false],
 ['hon.command_champions_contest(text,uuid,jsonb,uuid,uuid,uuid)',true,true],
 ['hon.read_champions_contests_from_hq(text,text)',true,true],
 ['hon.read_champions_contest_from_hq(text,uuid)',true,true],
 ['hon.read_champions_contests_for_school(text,uuid)',true,true],
];
export async function verifyChampionsClubSecurity(client, runtime) {
 if (!/^hon_[a-z_]+$/.test(runtime)) throw new Error('Unsafe Champions Club runtime role.');
 for (const table of championsClubTables) {
  const r=(await client.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>$2
   AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
   AND NOT EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND a.grantee<>c.relowner) safe
   FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=$1::regclass`,[`hon.${table}`,runtime])).rows[0];
  if (r?.safe!==true) throw new Error(`Unsafe Champions Club table ${table}`);
  const guard = evidenceTables.includes(table) ? 'guard_champions_evidence' : rewardTables.includes(table) ? 'guard_champions_rewards' : leaderboardTables.includes(table) ? 'guard_champions_leaderboard' : contestTables.includes(table) ? 'guard_champions_contests' : 'guard_champions_records';
  const rowTrigger = evidenceTables.includes(table) ? 'champions_immutable' : 'champions_guarded';
  for (const [name,type] of [[rowTrigger,27],['champions_no_truncate',34]]) {
   const t=(await client.query(`SELECT count(*)=1 safe FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2 AND tgtype=$3
    AND tgfoid=$4::regprocedure AND tgenabled='O' AND NOT tgisinternal`,[`hon.${table}`,name,type,`hon.${guard}()`])).rows[0];
   if (t.safe!==true) throw new Error(`Unsafe Champions Club trigger ${table}.${name}`);
  }
 }
 const total=(await client.query("SELECT count(*)::int n FROM pg_proc WHERE pronamespace='hon'::regnamespace AND proname ~ 'champions'")).rows[0].n;
 if (total!==championsClubFunctions.length) throw new Error(`Untracked Champions Club functions: ${total}`);
 for (const [signature,execute,definer] of championsClubFunctions) {
  const r=(await client.query(`SELECT p.prosecdef=$3 AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AND (o.rolsuper OR o.rolbypassrls) AND o.rolname<>$2
   AND has_function_privilege($2,p.oid,'EXECUTE')=$4
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2) OR NOT $4 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) safe
   FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=$1::regprocedure`,[signature,runtime,definer,execute])).rows[0];
  if (r?.safe!==true) throw new Error(`Unsafe Champions Club function ${signature}`);
  for (const role of (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows) {
   if ((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed",[role.rolname,signature])).rows[0].allowed) throw new Error(`Forbidden client Champions Club function ${role.rolname}`);
  }
 }
}
