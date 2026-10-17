import type { HonTier } from '@hon/contracts';

/** The only tiers that may be shown or selected as a new public plan. */
export const PUBLIC_PLAN_TIERS = ['CORE', 'COMPLETE'] as const satisfies readonly HonTier[];
export type PublicPlanTier = (typeof PUBLIC_PLAN_TIERS)[number];

export interface PublicPlanCatalogEntry {
  tier: PublicPlanTier;
  displayName: string;
  monthlyDisplayPriceUsd: number;
  premiumAiCreditPlanningAllowance: number;
  publicDisplayable: true;
  publicSelectable: true;
  pricingStatus: 'NON_BINDING_DISPLAY_METADATA';
  creditAllowanceStatus: 'PLANNING_ONLY_NOT_A_CREDIT_GRANT';
}

/**
 * Public-facing display and planning metadata only. This catalog has no billing,
 * offer activation, subscription, invoice, payment, entitlement, or credit-grant
 * behavior. Those concerns retain their existing separately governed boundaries.
 */
export const PUBLIC_PLAN_CATALOG = [
  {
    tier: 'CORE',
    displayName: 'Core',
    monthlyDisplayPriceUsd: 149,
    premiumAiCreditPlanningAllowance: 5_000,
    publicDisplayable: true,
    publicSelectable: true,
    pricingStatus: 'NON_BINDING_DISPLAY_METADATA',
    creditAllowanceStatus: 'PLANNING_ONLY_NOT_A_CREDIT_GRANT',
  },
  {
    tier: 'COMPLETE',
    displayName: 'Complete',
    monthlyDisplayPriceUsd: 249,
    premiumAiCreditPlanningAllowance: 12_000,
    publicDisplayable: true,
    publicSelectable: true,
    pricingStatus: 'NON_BINDING_DISPLAY_METADATA',
    creditAllowanceStatus: 'PLANNING_ONLY_NOT_A_CREDIT_GRANT',
  },
] as const satisfies readonly PublicPlanCatalogEntry[];

/** New public choices begin at Core; ESSENTIAL is never the public default. */
export const DEFAULT_PUBLIC_PLAN_TIER: PublicPlanTier = 'CORE';

/**
 * ESSENTIAL remains a valid HonTier for historical subscriptions and existing
 * entitlements. It is deliberately excluded from the public catalog and may not
 * be made a new public selection or default through this configuration.
 */
export const LEGACY_ESSENTIAL_PLAN = {
  tier: 'ESSENTIAL',
  historicalSubscriptionCompatible: true,
  publicSelectable: false,
  publicDisplayable: false,
  defaultForNewPublicSelection: false,
} as const;

export function isPublicPlanTier(tier: HonTier): tier is PublicPlanTier {
  return (PUBLIC_PLAN_TIERS as readonly HonTier[]).includes(tier);
}
