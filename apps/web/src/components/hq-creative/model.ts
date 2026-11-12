import { CREATIVE_GENERATION_FORMATS, validateHqCreativeBudgetInput, validateHqCreativeGenerationInput, validateHqCreativeResolveInput,
  type HqCreativeBudget, type HqCreativeBudgetInput, type HqCreativeGeneration, type HqCreativeGenerationInput, type HqCreativeResolveInput } from '@hon/contracts';

/** The person's typed request, as strings. */
export type RequestDraft = Readonly<{ operationCode: string; units: string; format: string; prompt: string; campaignId: string }>;
export type BudgetDraft = Readonly<{ creditCap: string; reason: string }>;
export type ResolveDraft = Readonly<{ resolution: string; finalUnits: string; evidenceReference: string }>;

const whole = (text: string, max: number): number | null => {
  const t = text.trim().replace(/,/g, '');
  return /^\d{1,8}$/.test(t) && Number(t) <= max ? Number(t) : null;
};
/** The form as a closed request, or null when it is not one. Line breaks inside the prompt are kept; outer space is trimmed. */
export function requestInputFrom(d: RequestDraft): HqCreativeGenerationInput | null {
  const units = whole(d.units, 1000);
  if (units === null || !(CREATIVE_GENERATION_FORMATS as readonly string[]).includes(d.format)) return null;
  try {
    return validateHqCreativeGenerationInput({ operationCode: d.operationCode, units, format: d.format, prompt: d.prompt.replace(/\r\n?/g, '\n').trim(),
      campaignId: d.campaignId === '' ? null : d.campaignId });
  } catch { return null; }
}
/** The cap for the budget's month: a new month needs no version, a set month needs the version that was read. */
export function budgetInputFrom(d: BudgetDraft, budget: HqCreativeBudget): HqCreativeBudgetInput | null {
  const creditCap = whole(d.creditCap, 10_000_000);
  if (creditCap === null) return null;
  try { return validateHqCreativeBudgetInput({ periodStart: budget.periodStart, creditCap, expectedVersion: budget.version, reason: d.reason.replace(/\s+/g, ' ').trim() }); }
  catch { return null; }
}
/** The HQ owner's decision on a held request. The provider cost is left unknown here (recorded later from evidence). */
export function resolveInputFrom(d: ResolveDraft, g: HqCreativeGeneration): HqCreativeResolveInput | null {
  const charged = d.resolution === 'SUCCEEDED';
  const finalUnits = charged ? whole(d.finalUnits, g.units) : null;
  if ((charged && finalUnits === null) || !['SUCCEEDED', 'NOT_CHARGED'].includes(d.resolution)) return null;
  try { return validateHqCreativeResolveInput({ expectedVersion: g.version, resolution: d.resolution, finalUnits, providerCostMicrounits: null,
    evidenceReference: d.evidenceReference.replace(/\s+/g, ' ').trim() }); } catch { return null; }
}
/** Requests the HQ owner may still decide: held for review, or apparently lost in flight (no answer after 2 minutes). */
export function resolvable(g: HqCreativeGeneration, asOf: string): boolean {
  return g.status === 'UNDER_REVIEW' || (g.status === 'GENERATING' && Date.parse(asOf) - Date.parse(g.createdAt) >= 120_000);
}
