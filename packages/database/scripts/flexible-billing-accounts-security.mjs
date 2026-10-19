import { readFile } from 'node:fs/promises';

const serviceUrl = new URL('../../../apps/api/src/billing/billing-account.service.ts', import.meta.url);
const controllerUrl = new URL('../../../apps/api/src/billing/billing-account.controller.ts', import.meta.url);
const guardUrl = new URL('../../../apps/api/src/billing/billing-account-human-ui.guard.ts', import.meta.url);
const migrationUrl = new URL('../migrations/0159_flexible_billing_accounts.sql', import.meta.url);

function mustInclude(source, text, label) {
  if (!source.includes(text)) throw new Error(`Flexible billing-account direct-human source contract missing ${label}.`);
}

export async function verifyFlexibleBillingAccountsSourceContract() {
  const [service, controller, guard, migration] = await Promise.all([
    readFile(serviceUrl, 'utf8'), readFile(controllerUrl, 'utf8'), readFile(guardUrl, 'utf8'), readFile(migrationUrl, 'utf8'),
  ]);
  for (const [text, label] of [
    ["context.principalType !== 'HUMAN_USER'", 'HUMAN_USER service gate'],
    ["context.source !== 'HUMAN_UI'", 'HUMAN_UI service gate'],
    ["context.actionRequestId !== undefined", 'Action Engine context rejection'],
    ["context.delegatedByPrincipalId !== undefined", 'delegation context rejection'],
    ['await this.recheckCurrentHuman(client, context);', 'pre-command current-human recheck'],
    ['require_current_direct_human_billing_account_actor', 'fixed direct-human database recheck'],
    ["set_config('app.hon_source'", 'transaction-bound source recheck'],
    ['read_current_organization_entitlement()', 'active-tier recheck'],
    ['FROM hon.people', 'current-school payer recheck'],
    ['lock_current_direct_human_billing_accounts', 'least-privilege canonical-account relation lock'],
    ["'billing.account.reuse'", 'reuse audit evidence'],
    ["'billing.account.create'", 'create audit evidence'],
    ["'billing.account.created'", 'inert creation outbox'],
    ['IDEMPOTENCY_KEY_REUSED', 'payload-bound idempotency conflict'],
  ]) mustInclude(service, text, label);
  for (const forbidden of ['hon.invoices', 'hon.payment_attempts', 'hon.memberships', 'hon.membership_payment_schedules', 'hon.communication_messages', 'hon.ai_usage_ledger', 'hon.action_requests']) {
    if (service.includes(forbidden)) throw new Error(`Flexible billing-account service acquired forbidden side-effect dependency: ${forbidden}.`);
  }
  for (const [text, label] of [
    ['@UseGuards(HonIdentityGuard, BillingAccountHumanUiGuard)', 'identity plus direct-human route guard'],
    ["resolveAuthorizedScope(identity.externalSubject, schoolId, 'billing.account.create')", 'server-derived exact school scope'],
    ["principalType: 'HUMAN_USER'", 'server-derived human principal type'],
    ["source: 'HUMAN_UI'", 'server-derived human source'],
  ]) mustInclude(controller, text, label);
  for (const [text, label] of [
    ["protected override readonly command = 'billing.account.create'", 'exact browser marker'],
    ["req.headers['sec-fetch-site'] !== 'same-origin'", 'same-origin fetch requirement'],
    ["req.headers['sec-fetch-mode'] !== 'same-origin'", 'same-origin mode requirement'],
    ["key.toLowerCase().startsWith('x-hon-')", 'unexpected authority-header rejection'],
    ['assertDirectHumanBillingAccountRequest(req)', 'delegated/context-shape rejection'],
  ]) mustInclude(guard, text, label);
  for (const [text, label] of [
    ['ORDER BY created_at ASC, id ASC', 'deterministic historical account ordering'],
    ["WHERE account_classification = 'CANONICAL'", 'partial canonical uniqueness predicate'],
    ['FORCE ROW LEVEL SECURITY', 'forced RLS reassertion'],
    ['require_current_direct_human_billing_account_actor', 'fixed direct-human authority function'],
    ["principal_type = 'HUMAN_USER'", 'active human principal recheck'],
    ['hq_operator_grants', 'HQ-plane rejection'],
    ['family_access_grants', 'family-plane rejection'],
    ['app.hon_action_request_id', 'Action Engine recheck'],
    ['app.hon_delegated_by_principal_id', 'delegation recheck'],
  ]) mustInclude(migration, text, label);
}

export async function verifyFlexibleBillingAccountsSecurity(client, runtime = 'hon_runtime') {
  if (!/^hon_[a-z0-9_]+$/.test(runtime)) throw new Error('Unsafe flexible billing-account runtime alias.');
  await verifyFlexibleBillingAccountsSourceContract();
  const runtimePosture = (await client.query(`SELECT NOT(rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication) AS safe,
    NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) AS no_memberships
    FROM pg_roles WHERE rolname=$1`, [runtime])).rows[0];
  if (!runtimePosture?.safe || !runtimePosture.no_memberships) throw new Error('Flexible billing-account runtime role is privileged or inherits a role.');
  const table = (await client.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='hon.billing_accounts'::regclass`)).rows[0];
  if (!table?.relrowsecurity || !table.relforcerowsecurity) throw new Error('billing_accounts must retain enabled forced RLS.');
  const policy = (await client.query(`SELECT pg_get_expr(polqual,polrelid) AS using_expression, pg_get_expr(polwithcheck,polrelid) AS check_expression
    FROM pg_policy WHERE polrelid='hon.billing_accounts'::regclass AND polname='billing_accounts_tenant_isolation'`)).rows[0];
  if (!policy?.using_expression?.includes('current_organization_id') || !policy.using_expression.includes('current_school_id')
    || !policy?.check_expression?.includes('current_organization_id') || !policy.check_expression.includes('current_school_id')) {
    throw new Error('billing_accounts tenant RLS policy drifted.');
  }
  const acl = (await client.query(`SELECT
    has_table_privilege($1,'hon.billing_accounts','SELECT') AS account_select,
    has_table_privilege($1,'hon.billing_accounts','INSERT') AS account_insert,
    has_table_privilege($1,'hon.billing_accounts','UPDATE') AS account_update,
    has_table_privilege($1,'hon.billing_accounts','DELETE') AS account_delete,
    has_table_privilege($1,'hon.billing_accounts','TRUNCATE') AS account_truncate,
    has_table_privilege($1,'hon.principals','SELECT') AS principals_select,
    has_table_privilege($1,'hon.organization_entitlements','SELECT') AS entitlement_select,
    has_table_privilege($1,'hon.payment_attempts','INSERT') AS payment_attempt_insert,
    has_table_privilege($1,'hon.outbox_events','SELECT') AS outbox_select,
    has_function_privilege($1,'hon.principal_has_school_permission(uuid,uuid,uuid,text)','EXECUTE') AS permission_execute,
    has_function_privilege($1,'hon.read_current_organization_entitlement()','EXECUTE') AS entitlement_execute,
    has_function_privilege($1,'hon.require_current_direct_human_billing_account_actor(uuid)','EXECUTE') AS billing_actor_execute,
    has_function_privilege($1,'hon.lock_current_direct_human_billing_accounts(uuid)','EXECUTE') AS billing_lock_execute,
    has_function_privilege($1,'hon.require_current_school_crm_intake_stages_actor(text)','EXECUTE') AS unrelated_helper_execute,
    EXISTS(SELECT 1 FROM aclexplode(coalesce((SELECT relacl FROM pg_class WHERE oid='hon.billing_accounts'::regclass),acldefault('r',(SELECT relowner FROM pg_class WHERE oid='hon.billing_accounts'::regclass)))) privilege WHERE grantee=0 AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE')) AS public_account_access`, [runtime])).rows[0];
  if (!acl?.account_select || !acl.account_insert || acl.account_update || acl.account_delete || acl.account_truncate
    || acl.principals_select || acl.entitlement_select || acl.payment_attempt_insert || acl.outbox_select
    || !acl.permission_execute || !acl.entitlement_execute || !acl.billing_actor_execute || !acl.billing_lock_execute || acl.unrelated_helper_execute || acl.public_account_access) {
    throw new Error('Flexible billing-account restricted-runtime ACL boundary drifted.');
  }
  const actor = (await client.query(`SELECT prosecdef, provolatile, proconfig, prosrc
    FROM pg_proc WHERE oid='hon.require_current_direct_human_billing_account_actor(uuid)'::regprocedure`)).rows[0];
  if (!actor?.prosecdef || actor.provolatile !== 'v' || !Array.isArray(actor.proconfig) || !actor.proconfig.includes('search_path=pg_catalog, hon')) {
    throw new Error('Flexible billing-account actor function posture drifted.');
  }
  for (const text of ["'HUMAN_USER'", "'HUMAN_UI'", "'billing.account.create'", 'hq_operator_grants', 'family_access_grants', 'staff_member_eligible', 'app.hon_action_request_id', 'app.hon_delegated_by_principal_id']) {
    if (!actor.prosrc.includes(text)) throw new Error(`Flexible billing-account actor function lacks ${text}.`);
  }
  const lock = (await client.query(`SELECT prosecdef, provolatile, proconfig, prosrc
    FROM pg_proc WHERE oid='hon.lock_current_direct_human_billing_accounts(uuid)'::regprocedure`)).rows[0];
  if (!lock?.prosecdef || lock.provolatile !== 'v' || !Array.isArray(lock.proconfig) || !lock.proconfig.includes('search_path=pg_catalog, hon')
    || !lock.prosrc.includes('require_current_direct_human_billing_account_actor') || !lock.prosrc.includes('LOCK TABLE hon.billing_accounts IN SHARE ROW EXCLUSIVE MODE')) {
    throw new Error('Flexible billing-account lock function posture drifted.');
  }
  const permission = (await client.query("SELECT is_sensitive, is_staff_assignable FROM hon.permissions WHERE code='billing.account.create'")).rows[0];
  if (!permission || permission.is_sensitive || !permission.is_staff_assignable) throw new Error('billing.account.create must remain a staff-assignable non-sensitive permission.');
  const canonicalIndex = (await client.query(`SELECT indexdef FROM pg_indexes WHERE schemaname='hon' AND indexname='billing_accounts_one_canonical_per_payer_idx'`)).rows[0]?.indexdef ?? '';
  if (!canonicalIndex.includes('(organization_id, school_id, responsible_person_id)') || !canonicalIndex.includes("WHERE (account_classification = 'CANONICAL'::text)")) {
    throw new Error('Canonical billing-account partial unique index drifted.');
  }
}
