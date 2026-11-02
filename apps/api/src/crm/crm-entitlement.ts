import { ForbiddenException } from '@nestjs/common';
import type { HonTier } from '@hon/contracts';
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
