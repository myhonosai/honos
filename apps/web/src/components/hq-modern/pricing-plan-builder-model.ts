import { HON_OS_PRODUCT, SAAS_HON_OS_OFFER_KINDS, type SaasHonOsOfferKind } from '@hon/contracts';
import { blankOffer, type OfferFields, type OfferSetForm } from './pricing-offers-model';

/**
 * The Plan builder is a friendlier view over the SAME whole offer set the backend already validates (0181).
 * It never calls the server itself: it only rewrites the local form, which still goes through save, server
 * preview, digest-confirmed publish and every server check. Nothing here charges, grants credits or opens access.
 */
export type PriceChoice = { on: boolean; amount: string };
export type PlanDraft = {
  name: string;
  monthly: PriceChoice; annual: PriceChoice; lifetime: PriceChoice;
  founderMonthly: PriceChoice; founderAnnual: PriceChoice; founderLifetime: PriceChoice;
  founderSpots: string; lifetimeSpots: string;
  credits: string; refundDays: string;
  who: 'ANY_ACTIVE_ORGANIZATION' | 'NEW_ORGANIZATIONS_ONLY';
  salesOpensAt: string; salesClosesAt: string; termsReference: string;
};

/** Owner-approved list prices (David, 2026-11-09) and included creative credits. Applied only when HQ presses "Regular plan". */
export const PLAN_DEFAULTS = Object.freeze({
  name: 'HON OS', monthly: '249.00', annual: '2097.00', founderMonthly: '199.20', founderAnnual: '1494.00',
  credits: '12000', refundDays: '30', termsReference: 'https://myhonos.com/terms/',
});
export const CREDIT_QUICK_PICKS = [5000, 12000, 20000] as const;

const KIND_OF = {
  monthly: 'REGULAR_MONTHLY', annual: 'REGULAR_ANNUAL', lifetime: 'LIFETIME',
  founderMonthly: 'FOUNDER_MONTHLY', founderAnnual: 'FOUNDER_ANNUAL', founderLifetime: 'FOUNDER_LIFETIME',
} as const satisfies Record<string, SaasHonOsOfferKind>;
export type PriceKey = keyof typeof KIND_OF;
export const PRICE_KEYS = Object.keys(KIND_OF) as PriceKey[];

const off = (): PriceChoice => ({ on: false, amount: '' });
export function emptyPlan(): PlanDraft {
  return { name: PLAN_DEFAULTS.name, monthly: off(), annual: off(), lifetime: off(), founderMonthly: off(), founderAnnual: off(), founderLifetime: off(),
    founderSpots: '', lifetimeSpots: '', credits: '', refundDays: '', who: 'ANY_ACTIVE_ORGANIZATION', salesOpensAt: '', salesClosesAt: '', termsReference: '' };
}
export function defaultPlan(): PlanDraft {
  return { ...emptyPlan(), monthly: { on: true, amount: PLAN_DEFAULTS.monthly }, annual: { on: true, amount: PLAN_DEFAULTS.annual },
    credits: PLAN_DEFAULTS.credits, refundDays: PLAN_DEFAULTS.refundDays, termsReference: PLAN_DEFAULTS.termsReference };
}

/** Reads the plan back out of the form, so the form stays the only source of truth. */
export function planFromForm(form: OfferSetForm): PlanDraft {
  const plan = emptyPlan(), first = form.offers[0];
  for (const key of PRICE_KEYS) { const o = form.offers.find(x => x.offerKind === KIND_OF[key]); if (o) plan[key] = { on: true, amount: o.amount }; }
  plan.founderSpots = form.founderTotalLimit;
  plan.termsReference = form.termsReference;
  plan.lifetimeSpots = form.offers.find(o => o.offerKind.endsWith('LIFETIME'))?.saleLimit ?? '';
  if (first) {
    plan.name = first.displayName; plan.credits = first.plannedMonthlyPremiumCredits; plan.refundDays = first.refundWindowDays;
    plan.who = first.eligibility === 'NEW_ORGANIZATIONS_ONLY' ? 'NEW_ORGANIZATIONS_ONLY' : 'ANY_ACTIVE_ORGANIZATION';
    plan.salesOpensAt = first.salesOpensAt; plan.salesClosesAt = first.salesClosesAt;
  }
  return plan;
}

/**
 * Writes the plan into the form. Existing options keep their key and code (so a revision edits them in place) and their
 * advanced-only notes; options switched off are removed. Terms follow owner policy: founder prices stay while subscribed,
 * yearly renews at the locked price, cancelling ends at the end of the paid period, lifetime has no recurring terms.
 */
export function applyPlanToForm(form: OfferSetForm, plan: PlanDraft): OfferSetForm {
  const offers: OfferFields[] = [];
  for (const kind of SAAS_HON_OS_OFFER_KINDS) {
    const key = PRICE_KEYS.find(k => KIND_OF[k] === kind)!, choice = plan[key];
    if (!choice.on) continue;
    const base = form.offers.find(o => o.offerKind === kind) ?? blankOffer(kind, [...form.offers, ...offers]);
    const lifetime = kind.endsWith('LIFETIME'), founder = kind.startsWith('FOUNDER_');
    offers.push({ ...base, displayName: plan.name, amount: choice.amount, eligibility: plan.who,
      salesOpensAt: plan.salesOpensAt, salesClosesAt: plan.salesClosesAt,
      saleLimit: lifetime ? plan.lifetimeSpots : base.saleLimit,
      priceLock: lifetime ? 'NONE' : founder ? 'WHILE_CONTINUOUSLY_SUBSCRIBED' : base.priceLock === 'FIXED_MONTHS' ? 'FIXED_MONTHS' : 'NONE',
      annualRenewal: kind.endsWith('ANNUAL') ? 'AUTO_RENEW_AT_LOCKED_PRICE' : '',
      cancellationTiming: lifetime ? '' : 'END_OF_PAID_PERIOD',
      plannedMonthlyPremiumCredits: plan.credits, refundWindowDays: plan.refundDays,
      aiFairUseReference: lifetime ? (base.aiFairUseReference || plan.termsReference) : base.aiFairUseReference });
  }
  const founder = offers.some(o => o.offerKind.startsWith('FOUNDER_'));
  return { ...form, termsReference: plan.termsReference, founderTotalLimit: founder ? plan.founderSpots : '', offers };
}

/** Exact cents; null when the text is not a valid amount. Display hints only: the server preview owns official numbers. */
export function cents(amount: string): number | null {
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(amount)) return null;
  const [whole, frac = ''] = amount.split('.'); return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
export function yearlySavings(monthly: string, annual: string): { savedMinor: number; percent: number; monthsFree: number } | null {
  const m = cents(monthly), a = cents(annual);
  if (m === null || a === null || m <= 0 || a >= m * 12) return null;
  const savedMinor = m * 12 - a;
  return { savedMinor, percent: Math.round(savedMinor * 100 / (m * 12)), monthsFree: Math.round(savedMinor * 10 / m) / 10 };
}
export function percentOff(regular: string, founder: string): number | null {
  const r = cents(regular), f = cents(founder);
  return r === null || f === null || r <= 0 || f >= r ? null : Math.round((r - f) * 100 / r);
}

export type PlanProblem = 'NO_PRICE' | 'BAD_PRICE' | 'FOUNDER_SPOTS' | 'LIFETIME_SPOTS' | 'CREDITS' | 'REFUND' | 'TERMS' | 'NAME' | 'SALES_WINDOW';
/** Friendly checks shown while editing. The shared validator and server readiness remain the authority. */
export function planProblems(plan: PlanDraft): PlanProblem[] {
  const out: PlanProblem[] = [], on = PRICE_KEYS.filter(k => plan[k].on);
  const int = (s: string, max: number) => /^\d{1,7}$/.test(s) && Number(s) <= max;
  if (!plan.name.trim() || plan.name.trim() !== plan.name || plan.name.length > 80) out.push('NAME');
  if (!on.length) out.push('NO_PRICE');
  if (on.some(k => { const c = cents(plan[k].amount); return c === null || c < 100 || c > 10_000_000; })) out.push('BAD_PRICE');
  if (on.some(k => k.startsWith('founder')) && !(int(plan.founderSpots, 1000) && Number(plan.founderSpots) > 0)) out.push('FOUNDER_SPOTS');
  if ((plan.lifetime.on || plan.founderLifetime.on) && !(int(plan.lifetimeSpots, 10_000) && Number(plan.lifetimeSpots) > 0)) out.push('LIFETIME_SPOTS');
  if (!int(plan.credits, 1_000_000)) out.push('CREDITS');
  if (!int(plan.refundDays, 365)) out.push('REFUND');
  if (!plan.termsReference.trim() || plan.termsReference.length > 500) out.push('TERMS');
  if (plan.salesOpensAt && plan.salesClosesAt && plan.salesClosesAt <= plan.salesOpensAt) out.push('SALES_WINDOW');
  return out;
}

/** What every HON OS plan includes today: the one HON OS product's full capability list (no tiers). */
export const PLAN_FEATURES = HON_OS_PRODUCT.capabilities;
