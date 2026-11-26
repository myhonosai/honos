import { HON_OS_PLAN_CAPABILITIES, HON_OS_PRODUCT, SAAS_HON_OS_OFFER_KINDS, type SaasHonOsOfferKind } from '@hon/contracts';
import { blankOffer, type OfferFields, type OfferSetForm } from './pricing-offers-model';

/**
 * The Plan builder is a friendlier view over the SAME whole offer set the backend already validates (0181, 0697).
 * It never calls the server itself: it only rewrites the local form, which still goes through save, server
 * preview, digest-confirmed publish and every server check. Nothing here charges, grants credits or opens access.
 * A plan is the offers that share a display name (0697); each plan has its own prices, credits and feature list.
 */
export type PriceChoice = { on: boolean; amount: string };
export type PlanDraft = {
  /** Local identity only: the key of the plan's first offer, or a fresh id for a new plan. Never sent to the server. */
  id: string;
  name: string;
  monthly: PriceChoice; annual: PriceChoice; lifetime: PriceChoice;
  founderMonthly: PriceChoice; founderAnnual: PriceChoice; founderLifetime: PriceChoice;
  lifetimeSpots: string; credits: string;
  /** Capability codes, canonical HON OS order. */
  features: string[];
};
/** Set-wide terms shared by every plan. */
export type PlansDraft = {
  plans: PlanDraft[];
  founderSpots: string; refundDays: string;
  who: 'ANY_ACTIVE_ORGANIZATION' | 'NEW_ORGANIZATIONS_ONLY';
  salesOpensAt: string; salesClosesAt: string; termsReference: string;
};

/** Owner-approved list prices (David, 2026-11-09) and included creative credits. Applied only when HQ presses "Regular plan". */
export const PLAN_DEFAULTS = Object.freeze({
  name: 'HON OS', monthly: '249.00', annual: '2097.00', founderMonthly: '199.20', founderAnnual: '1494.00',
  credits: '12000', refundDays: '30', termsReference: 'https://myhonos.com/terms/',
});
export const CREDIT_QUICK_PICKS = [5000, 12000, 20000] as const;
export const MAX_PLANS = 6;

const KIND_OF = {
  monthly: 'REGULAR_MONTHLY', annual: 'REGULAR_ANNUAL', lifetime: 'LIFETIME',
  founderMonthly: 'FOUNDER_MONTHLY', founderAnnual: 'FOUNDER_ANNUAL', founderLifetime: 'FOUNDER_LIFETIME',
} as const satisfies Record<string, SaasHonOsOfferKind>;
export type PriceKey = keyof typeof KIND_OF;
export const PRICE_KEYS = Object.keys(KIND_OF) as PriceKey[];

/** What a HON OS plan can include: the one HON OS product's full capability list. */
export const PLAN_FEATURES = HON_OS_PRODUCT.capabilities;
/** Features that need the AI team (the former Complete-only list); everything else is the school system. */
export const AI_TEAM_FEATURES: readonly string[] = ['marketing.campaigns_ai_managed', 'attribution.ai_insight', 'ai.workforce', 'ai.delegated_jobs', 'ai.orchestration'];
export const canonicalFeatures = (list: readonly string[]) => HON_OS_PLAN_CAPABILITIES.filter(c => list.includes(c));

const off = (): PriceChoice => ({ on: false, amount: '' });
export function emptyPlan(id: string = crypto.randomUUID(), name: string = PLAN_DEFAULTS.name): PlanDraft {
  return { id, name, monthly: off(), annual: off(), lifetime: off(), founderMonthly: off(), founderAnnual: off(), founderLifetime: off(),
    lifetimeSpots: '', credits: '', features: [...PLAN_FEATURES] };
}
export function emptyPlans(): PlansDraft {
  return { plans: [], founderSpots: '', refundDays: '', who: 'ANY_ACTIVE_ORGANIZATION', salesOpensAt: '', salesClosesAt: '', termsReference: '' };
}
export function defaultPlan(id?: string): PlanDraft {
  return { ...emptyPlan(id), monthly: { on: true, amount: PLAN_DEFAULTS.monthly }, annual: { on: true, amount: PLAN_DEFAULTS.annual }, credits: PLAN_DEFAULTS.credits };
}
/** A new offer set with the owner-approved HON OS plan and terms. */
export function defaultPlans(): PlansDraft {
  return { ...emptyPlans(), plans: [defaultPlan()], refundDays: PLAN_DEFAULTS.refundDays, termsReference: PLAN_DEFAULTS.termsReference };
}
/** Another plan to add: starts with every feature and the current set's terms; prices start empty so HQ chooses them. */
export function addedPlan(existing: readonly PlanDraft[]): PlanDraft {
  let name = 'New plan'; for (let i = 2; existing.some(p => p.name === name); i++) name = `New plan ${i}`;
  return { ...emptyPlan(undefined, name), monthly: { on: true, amount: '' }, credits: existing[0]?.credits ?? PLAN_DEFAULTS.credits };
}

/** The local plan id of each offer: the key of the first offer that has the same display name. */
function planIds(form: OfferSetForm): Map<string, string> {
  const first = new Map<string, string>(), out = new Map<string, string>();
  for (const o of form.offers) { if (!first.has(o.displayName)) first.set(o.displayName, o.key); out.set(o.key, first.get(o.displayName)!); }
  return out;
}

/** Reads the plans back out of the form, so the form stays the only source of truth. */
export function plansFromForm(form: OfferSetForm): PlansDraft {
  const draft = emptyPlans(), ids = planIds(form), byId = new Map<string, PlanDraft>();
  for (const o of form.offers) {
    const id = ids.get(o.key)!;
    let plan = byId.get(id);
    if (!plan) {
      plan = { ...emptyPlan(id, o.displayName), credits: o.plannedMonthlyPremiumCredits, features: canonicalFeatures(o.capabilities) };
      byId.set(id, plan); draft.plans.push(plan);
    }
    const key = PRICE_KEYS.find(k => KIND_OF[k] === o.offerKind)!;
    if (!plan[key].on) plan[key] = { on: true, amount: o.amount };
    if (o.offerKind.endsWith('LIFETIME') && !plan.lifetimeSpots) plan.lifetimeSpots = o.saleLimit;
  }
  const first = form.offers[0];
  draft.founderSpots = form.founderTotalLimit; draft.termsReference = form.termsReference;
  if (first) {
    draft.refundDays = first.refundWindowDays;
    draft.who = first.eligibility === 'NEW_ORGANIZATIONS_ONLY' ? 'NEW_ORGANIZATIONS_ONLY' : 'ANY_ACTIVE_ORGANIZATION';
    draft.salesOpensAt = first.salesOpensAt; draft.salesClosesAt = first.salesClosesAt;
  }
  return draft;
}

/**
 * Writes the plans into the form, plan by plan in kind order. An existing option keeps its key and code (so a revision
 * edits it in place) and its advanced-only notes; options switched off and removed plans are dropped. Terms follow owner
 * policy: founder prices stay while subscribed, yearly renews at the locked price, cancelling ends at the end of the paid
 * period, lifetime has no recurring terms.
 */
export function applyPlansToForm(form: OfferSetForm, draft: PlansDraft): OfferSetForm {
  const ids = planIds(form), offers: OfferFields[] = [];
  for (const plan of draft.plans) {
    for (const kind of SAAS_HON_OS_OFFER_KINDS) {
      const key = PRICE_KEYS.find(k => KIND_OF[k] === kind)!, choice = plan[key];
      if (!choice.on) continue;
      const base = form.offers.find(o => ids.get(o.key) === plan.id && o.offerKind === kind) ?? blankOffer(kind, [...form.offers, ...offers]);
      const lifetime = kind.endsWith('LIFETIME'), founder = kind.startsWith('FOUNDER_');
      offers.push({ ...base, displayName: plan.name, amount: choice.amount, eligibility: draft.who,
        salesOpensAt: draft.salesOpensAt, salesClosesAt: draft.salesClosesAt,
        saleLimit: lifetime ? plan.lifetimeSpots : base.saleLimit,
        priceLock: lifetime ? 'NONE' : founder ? 'WHILE_CONTINUOUSLY_SUBSCRIBED' : base.priceLock === 'FIXED_MONTHS' ? 'FIXED_MONTHS' : 'NONE',
        annualRenewal: kind.endsWith('ANNUAL') ? 'AUTO_RENEW_AT_LOCKED_PRICE' : '',
        cancellationTiming: lifetime ? '' : 'END_OF_PAID_PERIOD',
        plannedMonthlyPremiumCredits: plan.credits, refundWindowDays: draft.refundDays,
        aiFairUseReference: lifetime ? (base.aiFairUseReference || draft.termsReference) : base.aiFairUseReference,
        capabilities: canonicalFeatures(plan.features) });
    }
  }
  const founder = offers.some(o => o.offerKind.startsWith('FOUNDER_'));
  return { ...form, termsReference: draft.termsReference, founderTotalLimit: founder ? draft.founderSpots : '', offers };
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

export type PlanProblem = 'NAME' | 'SAME_NAME' | 'NO_PRICE' | 'BAD_PRICE' | 'FEATURES' | 'LIFETIME_SPOTS' | 'CREDITS';
export type SetProblem = 'NO_PLAN' | 'TOO_MANY' | 'FOUNDER_SPOTS' | 'REFUND' | 'TERMS' | 'SALES_WINDOW';
const int = (s: string, max: number) => /^\d{1,7}$/.test(s) && Number(s) <= max;
/** Friendly checks for one plan, shown while editing. The shared validator and server readiness remain the authority. */
export function planProblems(plan: PlanDraft, others: readonly PlanDraft[] = []): PlanProblem[] {
  const out: PlanProblem[] = [], on = PRICE_KEYS.filter(k => plan[k].on);
  if (!plan.name.trim() || plan.name.trim() !== plan.name || plan.name.length > 80) out.push('NAME');
  else if (others.some(p => p.id !== plan.id && p.name === plan.name)) out.push('SAME_NAME');
  if (!on.length) out.push('NO_PRICE');
  if (on.some(k => { const c = cents(plan[k].amount); return c === null || c < 100 || c > 10_000_000; })) out.push('BAD_PRICE');
  if (!plan.features.length) out.push('FEATURES');
  if ((plan.lifetime.on || plan.founderLifetime.on) && !(int(plan.lifetimeSpots, 10_000) && Number(plan.lifetimeSpots) > 0)) out.push('LIFETIME_SPOTS');
  if (!int(plan.credits, 1_000_000)) out.push('CREDITS');
  return out;
}
export function setProblems(draft: PlansDraft): SetProblem[] {
  const out: SetProblem[] = [];
  const offers = draft.plans.reduce((n, p) => n + PRICE_KEYS.filter(k => p[k].on).length, 0);
  if (!draft.plans.length) out.push('NO_PLAN');
  if (draft.plans.length > MAX_PLANS || offers > 12) out.push('TOO_MANY');
  if (draft.plans.some(p => PRICE_KEYS.some(k => k.startsWith('founder') && p[k].on)) && !(int(draft.founderSpots, 1000) && Number(draft.founderSpots) > 0)) out.push('FOUNDER_SPOTS');
  if (!int(draft.refundDays, 365)) out.push('REFUND');
  if (!draft.termsReference.trim() || draft.termsReference.length > 500) out.push('TERMS');
  if (draft.salesOpensAt && draft.salesClosesAt && draft.salesClosesAt <= draft.salesOpensAt) out.push('SALES_WINDOW');
  return out;
}
/** Every problem in the set, plan problems first (deduplicated), for the Review step. */
export function allProblems(draft: PlansDraft): (PlanProblem | SetProblem)[] {
  const out = new Set<PlanProblem | SetProblem>();
  for (const p of draft.plans) for (const x of planProblems(p, draft.plans)) out.add(x);
  for (const x of setProblems(draft)) out.add(x);
  return [...out];
}
