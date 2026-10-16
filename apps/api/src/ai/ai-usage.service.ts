import { BadRequestException, Injectable } from '@nestjs/common';
import { INCLUDED_AI_CREDITS } from '@hon/config';
import {
  HON_TIERS,
  type AiUsageBreakdown,
  type AiUsageModality,
  type AiUsageSummary,
  type AiUsageWarningLevel,
  type HonTier,
} from '@hon/contracts';
import type { TenantTransactionContext } from '@hon/database';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const MAX_RANGE_MILLISECONDS = 92 * 24 * 60 * 60 * 1000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const AI_USAGE_MODALITIES: readonly AiUsageModality[] = [
  'TEXT',
  'VOICE_INPUT',
  'VOICE_OUTPUT',
  'IMAGE',
  'VIDEO',
  'EMBEDDING',
  'TOOL_EXECUTION',
];

export interface AiUsageRangeInput {
  from?: string;
  to?: string;
}

export interface NormalizedAiUsageRange {
  from: string;
  to: string;
}

interface AiUsageReadContext extends TenantTransactionContext {
  organizationId: string;
  schoolId: string;
}

interface UsageReadRow {
  entitlementTier: string | null;
  customerCredits: string | number;
  providerCostMicrounits: string | number;
  inputUnits: string | number;
  outputUnits: string | number;
  entries: string | number;
  breakdown: unknown;
}

interface UsageBreakdownRow {
  modality: unknown;
  providerCode: unknown;
  modelCode: unknown;
  customerCredits: unknown;
  providerCostMicrounits: unknown;
  inputUnits: unknown;
  outputUnits: unknown;
  entries: unknown;
}

function validationError(detail: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}

function parseIsoInstant(value: string, field: 'from' | 'to'): Date {
  const normalized = value.trim();
  if (!ISO_INSTANT.test(normalized)) {
    throw validationError(`${field} must be an ISO 8601 timestamp with a timezone.`);
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw validationError(`${field} must be a valid ISO 8601 timestamp.`);
  }
  return parsed;
}

function currentUtcMonth(): NormalizedAiUsageRange {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * A caller either provides both explicitly timezone-qualified bounds or receives
 * the whole current UTC calendar month. The upper bound is exclusive, ensuring
 * adjacent reports neither overlap nor omit an instant.
 */
export function normalizeAiUsageRange(input: AiUsageRangeInput): NormalizedAiUsageRange {
  if (input.from === undefined && input.to === undefined) return currentUtcMonth();
  if (typeof input.from !== 'string' || typeof input.to !== 'string') {
    throw validationError('from and to must be supplied together as ISO 8601 timestamps with timezones.');
  }
  const from = parseIsoInstant(input.from, 'from');
  const to = parseIsoInstant(input.to, 'to');
  const duration = to.getTime() - from.getTime();
  if (duration <= 0) throw validationError('to must be later than from.');
  if (duration > MAX_RANGE_MILLISECONDS) {
    throw validationError('The requested AI usage range cannot exceed 92 days.');
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function asSafeNonNegativeInteger(value: unknown, field: string): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`HON AI usage query returned an invalid ${field} aggregate.`);
  }
  return numeric;
}

function asTier(value: string | null): HonTier | null {
  if (value === null) return null;
  if (!HON_TIERS.includes(value as HonTier)) {
    throw new Error('HON AI usage query returned an invalid entitlement tier.');
  }
  return value as HonTier;
}

function asBreakdown(value: unknown): AiUsageBreakdown[] {
  if (!Array.isArray(value)) throw new Error('HON AI usage query did not return a breakdown array.');
  return value.map((entry): AiUsageBreakdown => {
    const row = entry as UsageBreakdownRow;
    if (!AI_USAGE_MODALITIES.includes(row.modality as AiUsageModality)) {
      throw new Error('HON AI usage query returned an invalid modality breakdown.');
    }
    if (typeof row.providerCode !== 'string' || typeof row.modelCode !== 'string') {
      throw new Error('HON AI usage query returned an invalid provider/model breakdown.');
    }
    return {
      modality: row.modality as AiUsageModality,
      providerCode: row.providerCode,
      modelCode: row.modelCode,
      customerCredits: asSafeNonNegativeInteger(row.customerCredits, 'breakdown customerCredits'),
      providerCostMicrounits: asSafeNonNegativeInteger(row.providerCostMicrounits, 'breakdown providerCostMicrounits'),
      inputUnits: asSafeNonNegativeInteger(row.inputUnits, 'breakdown inputUnits'),
      outputUnits: asSafeNonNegativeInteger(row.outputUnits, 'breakdown outputUnits'),
      entries: asSafeNonNegativeInteger(row.entries, 'breakdown entries'),
    };
  });
}

/** Deterministic usage threshold, calculated without provider calls or side effects. */
export function determineAiUsageWarningLevel(
  customerCredits: number,
  includedCredits: number,
): AiUsageWarningLevel {
  if (!Number.isSafeInteger(customerCredits) || customerCredits < 0
    || !Number.isSafeInteger(includedCredits) || includedCredits < 0) {
    throw new Error('HON AI usage warning inputs must be non-negative safe integers.');
  }
  if (customerCredits === 0) return 'NONE';
  if (includedCredits === 0) return '100';

  const used = BigInt(customerCredits);
  const included = BigInt(includedCredits);
  if (used >= included) return '100';
  if (used * 100n >= included * 90n) return '90';
  if (used * 100n >= included * 75n) return '75';
  return 'NONE';
}

@Injectable()
export class AiUsageService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  /**
   * This is a ledger projection only. It does not write the ledger, charge or
   * reset credits, block a tenant, invoke a provider, or execute any AI/model.
   */
  async read(context: AiUsageReadContext, input: AiUsageRangeInput): Promise<AiUsageSummary> {
    const range = normalizeAiUsageRange(input);
    return this.database.withTenantTransaction(context, async (client) => {
      // All selected ledger values are aggregated in one snapshot-consistent SQL
      // statement. No individual request, payload, correlation, or principal data
      // is selected. Ledger RLS and the fixed context-bound tier projection apply.
      const result = await client.query<UsageReadRow>(
        `WITH active_entitlement AS (
           SELECT tier AS "entitlementTier"
           FROM hon.read_current_organization_entitlement()
         ),
         scoped_usage AS MATERIALIZED (
           SELECT modality::text AS modality, provider_code, model_code,
                  input_units, output_units, provider_cost_microunits, customer_credits
           FROM hon.ai_usage_ledger
           WHERE organization_id = $1::uuid
             AND school_id = $2::uuid
             AND occurred_at >= $3::timestamptz
             AND occurred_at < $4::timestamptz
         ),
         totals AS (
           SELECT
             COALESCE(SUM(customer_credits), 0) AS "customerCredits",
             COALESCE(SUM(provider_cost_microunits), 0) AS "providerCostMicrounits",
             COALESCE(SUM(input_units), 0) AS "inputUnits",
             COALESCE(SUM(output_units), 0) AS "outputUnits",
             COUNT(*) AS entries
           FROM scoped_usage
         ),
         breakdown AS (
           SELECT
             modality,
             provider_code AS "providerCode",
             model_code AS "modelCode",
             SUM(customer_credits) AS "customerCredits",
             SUM(provider_cost_microunits) AS "providerCostMicrounits",
             SUM(input_units) AS "inputUnits",
             SUM(output_units) AS "outputUnits",
             COUNT(*) AS entries
           FROM scoped_usage
           GROUP BY modality, provider_code, model_code
         )
         SELECT
           entitlement."entitlementTier",
           totals."customerCredits",
           totals."providerCostMicrounits",
           totals."inputUnits",
           totals."outputUnits",
           totals.entries,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'modality', breakdown.modality,
                 'providerCode', breakdown."providerCode",
                 'modelCode', breakdown."modelCode",
                 'customerCredits', breakdown."customerCredits",
                 'providerCostMicrounits', breakdown."providerCostMicrounits",
                 'inputUnits', breakdown."inputUnits",
                 'outputUnits', breakdown."outputUnits",
                 'entries', breakdown.entries
               )
               ORDER BY breakdown.modality, breakdown."providerCode", breakdown."modelCode"
             ) FILTER (WHERE breakdown.modality IS NOT NULL),
             '[]'::jsonb
           ) AS breakdown
         FROM totals
         LEFT JOIN active_entitlement AS entitlement ON true
         LEFT JOIN breakdown ON true
         GROUP BY
           entitlement."entitlementTier",
           totals."customerCredits",
           totals."providerCostMicrounits",
           totals."inputUnits",
           totals."outputUnits",
           totals.entries`,
        [context.organizationId, context.schoolId, range.from, range.to],
      );
      const row = result.rows[0];
      if (!row) throw new Error('HON AI usage aggregation did not return a result.');

      const entitlementTier = asTier(row.entitlementTier);
      const includedCredits = entitlementTier === null ? 0 : INCLUDED_AI_CREDITS[entitlementTier];
      const customerCredits = asSafeNonNegativeInteger(row.customerCredits, 'customerCredits');
      const providerCostMicrounits = asSafeNonNegativeInteger(row.providerCostMicrounits, 'providerCostMicrounits');
      const inputUnits = asSafeNonNegativeInteger(row.inputUnits, 'inputUnits');
      const outputUnits = asSafeNonNegativeInteger(row.outputUnits, 'outputUnits');
      const entries = asSafeNonNegativeInteger(row.entries, 'entries');

      return {
        organizationId: context.organizationId,
        schoolId: context.schoolId,
        from: range.from,
        to: range.to,
        entitlementTier,
        customerCredits,
        includedCredits,
        remainingCredits: Math.max(includedCredits - customerCredits, 0),
        providerCostMicrounits,
        inputUnits,
        outputUnits,
        entries,
        warningLevel: determineAiUsageWarningLevel(customerCredits, includedCredits),
        breakdown: asBreakdown(row.breakdown),
      };
    });
  }
}
