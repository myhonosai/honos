import type { AiUsageModality, HonTier, TenantScope } from './index.js';

/** Fixed, server-calculated thresholds for included AI-credit consumption. */
export const AI_USAGE_WARNING_LEVELS = ['NONE', '75', '90', '100'] as const;
export type AiUsageWarningLevel = (typeof AI_USAGE_WARNING_LEVELS)[number];

/**
 * Aggregate for one provider/model/modality combination. Individual ledger rows,
 * correlation IDs, principal IDs, and request data are deliberately not exposed.
 */
export interface AiUsageBreakdown {
  modality: AiUsageModality;
  providerCode: string;
  modelCode: string;
  customerCredits: number;
  providerCostMicrounits: number;
  inputUnits: number;
  outputUnits: number;
  entries: number;
}

/**
 * Read-only, school-scoped AI economics projection. `entitlementTier` is null
 * when the organization has no entitlement active at read time; in that case no
 * included credits are represented by this response.
 */
export interface AiUsageSummary extends TenantScope {
  from: string;
  to: string;
  entitlementTier: HonTier | null;
  customerCredits: number;
  includedCredits: number;
  remainingCredits: number;
  providerCostMicrounits: number;
  inputUnits: number;
  outputUnits: number;
  entries: number;
  warningLevel: AiUsageWarningLevel;
  breakdown: AiUsageBreakdown[];
}
