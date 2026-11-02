import { ForbiddenException } from '@nestjs/common';
import type { CommandContext, HonTier } from '@hon/contracts';
import { tierIncludesFeature } from '@hon/config';

interface Queryable {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * CRM access requires the organization's entitlement to be in effect, read from the central authority
 * (`hon.read_current_organization_entitlement()`: status ACTIVE and inside its effective window, for the
 * transaction's tenant). An authorized grace period keeps the entitlement ACTIVE, so CRM works normally; a SUSPENDED
 * school is refused. Lead creation and pipeline setup already apply this exact check; this helper applies it to the
 * remaining CRM paths. Refusal never deletes or changes any record.
 */
export async function assertCrmEntitlementInEffect(client: Queryable, detail: string): Promise<void> {
  const entitlement = await client.query<{ tier: HonTier }>('SELECT tier FROM hon.read_current_organization_entitlement()');
  const current = entitlement.rows[0];
  if (!current || !tierIncludesFeature(current.tier, 'crm.foundation')) {
    throw new ForbiddenException({ code: 'TIER_ENTITLEMENT_REQUIRED', detail });
  }
}

export type CrmReadResource = 'LEAD_LIST' | 'TRIAL_LIST' | 'TRIAL_DETAIL';
export type CrmReadAccess =
  | { mode: 'FULL' }
  | { mode: 'OWNER_READ_ONLY'; suspendedAt: string; readOnlyUntil: string; policyVersion: number };

interface DatabaseError { code?: string; message?: string }

/**
 * Historical CRM reads. With the entitlement in effect, any authorized reader gets full access. Without it, only the
 * verified school owner gets read-only access, and only inside the past-due suspension window recorded by the central
 * access authority (`hon.authorize_crm_owner_read_only`). That function checks identity, the exact school and tenant,
 * and expiry against the database clock, and it audits each granted read. Everyone else, and the owner once the window
 * has closed, is refused with 403 `TIER_ENTITLEMENT_REQUIRED`. Write paths never call this: they keep requiring
 * `assertCrmEntitlementInEffect`.
 */
export async function resolveCrmReadAccess(
  client: Queryable,
  externalSubject: string,
  context: CommandContext,
  resource: CrmReadResource,
  detail: string,
): Promise<CrmReadAccess> {
  const entitlement = await client.query<{ tier: HonTier }>('SELECT tier FROM hon.read_current_organization_entitlement()');
  const current = entitlement.rows[0];
  if (current) {
    if (tierIncludesFeature(current.tier, 'crm.foundation')) return { mode: 'FULL' };
    throw new ForbiddenException({ code: 'TIER_ENTITLEMENT_REQUIRED', detail });
  }
  let granted: { principalId: string; organizationId: string; schoolId: string; suspendedAt: string; readOnlyUntil: string; policyVersion: number } | undefined;
  try {
    const result = await client.query<{ data: NonNullable<typeof granted> }>(
      'SELECT hon.authorize_crm_owner_read_only($1, $2::uuid, $3, $4::uuid, $5::uuid) AS data',
      [externalSubject, context.schoolId, resource, context.requestId, context.correlationId],
    );
    granted = result.rows[0]?.data;
  } catch (error) {
    const failure = error as DatabaseError;
    // Only the authority's own refusals become 403; anything else (including a missing grant) is a server fault.
    if (failure?.code !== '42501' || !failure.message?.startsWith('CRM_OWNER_READ_ONLY_')) throw error;
    throw new ForbiddenException(failure.message === 'CRM_OWNER_READ_ONLY_EXPIRED'
      ? { code: 'TIER_ENTITLEMENT_REQUIRED', detail, crmAccess: 'LOCKED_BILLING_RECOVERY_OPEN' }
      : { code: 'TIER_ENTITLEMENT_REQUIRED', detail });
  }
  if (!granted || granted.principalId !== context.principalId || granted.organizationId !== context.organizationId
    || granted.schoolId !== context.schoolId) {
    throw new ForbiddenException({ code: 'TIER_ENTITLEMENT_REQUIRED', detail });
  }
  return { mode: 'OWNER_READ_ONLY', suspendedAt: granted.suspendedAt, readOnlyUntil: granted.readOnlyUntil, policyVersion: granted.policyVersion };
}

/**
 * Response metadata for a CRM read. Full access adds nothing, so every existing client sees an unchanged envelope; only
 * a verified owner's read-only response carries `crmAccess` (mode, suspension date and read-only end).
 */
export function crmAccessMeta(access: CrmReadAccess): { crmAccess?: CrmReadAccess } {
  return access.mode === 'FULL' ? {} : { crmAccess: access };
}
