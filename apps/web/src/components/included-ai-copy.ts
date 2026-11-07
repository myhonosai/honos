/**
 * School-facing wording for the included AI team (docs/hon/INCLUDED_AI_AND_FAIR_USE.md).
 * Internal usage units, tokens and provider cost are HQ information and are never shown here.
 */
export const INCLUDED_AI_NOTE = 'Included in your HON OS subscription. Nothing is charged to your school for this draft.';

const INCLUDED_LIMIT_REASONS: ReadonlySet<string> = new Set(['CUSTOMER_BUDGET_EXCEEDED', 'ORGANIZATION_AI_BUDGET_REACHED']);

/** Turns an internal budget refusal into the included-limit message; other reasons pass through unchanged. */
export function includedAiReason(reason: string): string {
  return INCLUDED_LIMIT_REASONS.has(reason) ? 'Included AI limit reached this month. Nothing is charged' : reason;
}
