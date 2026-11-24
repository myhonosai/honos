import { HQ_PLAN_PROMOTION_AUDIENCES, HQ_PLAN_PROMOTION_LIMITS, validateHqPlanPromotionCreateInput, validateHqPlanPromotionUpdateInput,
  type HqPlanPromotion, type HqPlanPromotionContent, type HqPlanPromotionCreateInput, type HqPlanPromotionUpdateInput } from '@hon/contracts';

/** The person's typed form, as strings. Dates are UTC calendar days; the last day is shown in full. */
export type PromotionDraft = Readonly<{ code: string; headline: string; body: string; buttonLabel: string; offerId: string; audience: string;
  schoolIds: string; firstDay: string; lastDay: string }>;
const DAY = /^(20[2-9]\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const dayMs = (d: string): number | null => {
  if (!DAY.test(d)) return null;
  const t = Date.parse(`${d}T00:00:00.000Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== d ? null : t;
};
/** First day 00:00 UTC to the day after the last day 00:00 UTC; at most 90 days. */
export function windowFrom(firstDay: string, lastDay: string): { startsAt: string; endsAt: string } | null {
  const a = dayMs(firstDay), b = dayMs(lastDay);
  if (a === null || b === null || b < a) return null;
  const end = b + 86_400_000;
  if (end - a > HQ_PLAN_PROMOTION_LIMITS.days * 86_400_000) return null;
  return { startsAt: new Date(a).toISOString(), endsAt: new Date(end).toISOString() };
}
/** School ids pasted one per line, or separated by commas or spaces. */
export function schoolIdsFrom(text: string): string[] {
  return text.split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}
export function draftFrom(p: HqPlanPromotion): PromotionDraft {
  return { code: p.code, headline: p.headline, body: p.body, buttonLabel: p.buttonLabel, offerId: p.offer.offerId, audience: p.audience,
    schoolIds: p.schoolIds.join('\n'), firstDay: p.startsAt.slice(0, 10), lastDay: new Date(Date.parse(p.endsAt) - 86_400_000).toISOString().slice(0, 10) };
}
function contentFrom(d: PromotionDraft): HqPlanPromotionContent | null {
  const w = windowFrom(d.firstDay, d.lastDay);
  if (!w || !(HQ_PLAN_PROMOTION_AUDIENCES as readonly string[]).includes(d.audience)) return null;
  const audience = d.audience as HqPlanPromotionContent['audience'];
  return { headline: d.headline.trim(), body: d.body.replace(/\s+/g, ' ').trim(), buttonLabel: d.buttonLabel.trim(), offerId: d.offerId.trim().toLowerCase(),
    audience, schoolIds: audience === 'SELECTED_SCHOOLS' ? schoolIdsFrom(d.schoolIds) : [], ...w, marketingCampaignId: null };
}
export function createInputFrom(d: PromotionDraft): HqPlanPromotionCreateInput | null {
  const c = contentFrom(d);
  if (!c) return null;
  try { return validateHqPlanPromotionCreateInput({ code: d.code.trim().toUpperCase(), ...c }); } catch { return null; }
}
export function updateInputFrom(d: PromotionDraft, expectedVersion: number): HqPlanPromotionUpdateInput | null {
  const c = contentFrom(d);
  if (!c) return null;
  try { return validateHqPlanPromotionUpdateInput({ expectedVersion, ...c }); } catch { return null; }
}
