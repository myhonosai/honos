import { PUBLIC_PLAN_CATALOG, type PublicPlanTier } from '@hon/config';
import { HON_OS_LAUNCH_PRICING_REFERENCE, SAAS_OWNER_APPROVED_DRAFT, SAAS_PLAN_CAPABILITIES, SAAS_SCHEDULED_OFFER_KINDS, type SaasFounderSchoolAvailability, type SaasFounderUnavailableReason, type SaasHonOsSchoolOfferView, type SaasOfferKind } from '@hon/contracts';

/** Display metadata only. Never an available offer, price quote, entitlement or credit grant. */
export const OFFER_CHOICES: readonly { kind: SaasOfferKind; label: string; description: string }[] = [
  { kind: 'REGULAR_MONTHLY', label: 'Regular monthly', description: 'Billed monthly' },
  { kind: 'FOUNDER_MONTHLY', label: 'Founder monthly', description: 'Eligibility and availability required' },
  { kind: 'FOUNDER_LIFETIME', label: 'Founder lifetime', description: 'One-time purchase, subject to eligibility' },
];

const LABELS: Record<string, { label: string; note?: string }> = {
  'crm.families_students_prospects': { label: 'Families, students & prospect CRM' },
  'operations.classes_scheduling_attendance': { label: 'Classes, scheduling & attendance' },
  'operations.memberships_payments': { label: 'Membership & payment workflows', note: 'Authorized school billing is separate from this HON subscription.' },
  'progression.testing_curriculum': { label: 'Belt testing & curriculum progress' },
  'marketing.connections_reporting': { label: 'Marketing connections & reporting', note: 'External connections require separately available, authorized integrations.' },
  'marketing.campaigns_manual_assisted': { label: 'Manual & assisted campaign tools' },
  'attribution.conversion': { label: 'Conversion attribution' },
  'assistant.ordinary': { label: 'Contextual HON assistance', note: 'General conversational service is not connected on this page.' },
  'ai.premium_metered': { label: 'Creative Studio media', note: 'Uses the school’s creative-credit allowance. Availability requires server permission.' },
  'presentation.all_modes': { label: 'Big Button, Modern & Classic views' },
  'champions.participation': { label: 'Champions Club participation' },
  'marketing.campaigns_ai_managed': { label: 'Governed AI-managed campaigns', note: 'Requires available integrations and explicit approvals; not activated by plan selection.' },
  'attribution.ai_insight': { label: 'AI conversion insights' },
  'ai.workforce': { label: 'Seven specialist school AI roles', note: 'Alex, Chad, Maya, Marcus, Jordan, Claire and Lena. Executable capabilities vary; this is not seven active autonomous agents.' },
  'ai.delegated_jobs': { label: 'Approved delegated AI jobs', note: 'Only supported, authorized jobs can execute.' },
  'ai.orchestration': { label: 'Governed AI team orchestration', note: 'No unrestricted agent authority or automatic business actions.' },
};

export function planDisplay(tier: PublicPlanTier, kind: SaasOfferKind) {
  const plan = PUBLIC_PLAN_CATALOG.find((entry) => entry.tier === tier);
  const offer = SAAS_OWNER_APPROVED_DRAFT.offers.find((entry) => entry.planCode === tier && entry.offerKind === kind);
  if (!plan || !offer) throw new Error('Unsupported HON plan or offer selection.');
  return { ...plan, offerKind: kind, priceMinor: offer.priceMinor,
    intervalLabel: kind === 'FOUNDER_LIFETIME' ? 'one-time' : '/ month',
    offerLabel: OFFER_CHOICES.find((entry) => entry.kind === kind)!.label };
}

export const PLAN_COMPARISON = [...new Set([...SAAS_PLAN_CAPABILITIES.CORE, ...SAAS_PLAN_CAPABILITIES.COMPLETE])].map((capability) => {
  const copy = LABELS[capability];
  if (!copy) throw new Error(`Missing public capability description: ${capability}`);
  return { capability, ...copy, core: SAAS_PLAN_CAPABILITIES.CORE.includes(capability), complete: SAAS_PLAN_CAPABILITIES.COMPLETE.includes(capability) };
});

export function displayUsd(minor: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: minor % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(minor / 100);
}

export type PlanSelection = { tier: PublicPlanTier; offer: SaasOfferKind; reviewing: boolean; acknowledged: boolean };
export const INITIAL_SELECTION: PlanSelection = { tier: 'CORE', offer: 'REGULAR_MONTHLY', reviewing: false, acknowledged: false };
export type SelectionEvent = { type: 'PLAN'; tier: PublicPlanTier } | { type: 'OFFER'; offer: SaasOfferKind }
  | { type: 'REVIEW' } | { type: 'EDIT' } | { type: 'ACKNOWLEDGE'; checked: boolean };

/** Local comparison only; changing terms invalidates every earlier acknowledgement. */
export function selectPlan(state: PlanSelection, event: SelectionEvent): PlanSelection {
  switch (event.type) {
    case 'PLAN': planDisplay(event.tier, state.offer); return { ...state, tier: event.tier, reviewing: false, acknowledged: false };
    case 'OFFER': planDisplay(state.tier, event.offer); return { ...state, offer: event.offer, reviewing: false, acknowledged: false };
    case 'REVIEW': return { ...state, reviewing: true, acknowledged: false };
    case 'EDIT': return { ...state, reviewing: false, acknowledged: false };
    case 'ACKNOWLEDGE': return { ...state, acknowledged: state.reviewing && event.checked };
  }
}

/** One row per HON OS schedule price. Server prices win; otherwise the owner-approved launch price, labelled as such. */
export type HonOsPriceKind = typeof SAAS_SCHEDULED_OFFER_KINDS[number];
export type HonOsPriceRow = {
  kind: HonOsPriceKind; founder: boolean; annual: boolean; priceMinor: number; standardPriceMinor: number;
  source: 'SERVER_OFFER' | 'LAUNCH_REFERENCE' | 'NOT_ON_SALE';
  founderSpot: { state: 'AVAILABLE' | 'UNAVAILABLE' | 'UNVERIFIED'; reason: SaasFounderUnavailableReason | null } | null;
};
export const HON_OS_PRICE_LABELS: Record<HonOsPriceKind, string> = {
  REGULAR_MONTHLY: 'Standard monthly', REGULAR_ANNUAL: 'Standard annual', FOUNDER_MONTHLY: 'Founder monthly', FOUNDER_ANNUAL: 'Founder annual',
};
export const FOUNDER_REASON_COPY: Record<SaasFounderUnavailableReason, string> = {
  FOUNDER_TERMS_NOT_LOCKED: 'Founder terms are not published yet.',
  FOUNDER_ALREADY_USED: 'Your organization has already used its founder spot.',
  FOUNDER_SOLD_OUT: 'All 50 founder spots are taken.',
  FOUNDER_SET_LIMIT_REACHED: 'Founder sales for this offer set are closed.',
  FOUNDER_OFFER_LIMIT_REACHED: 'This founder offer has reached its sale limit.',
};
export function honOsPriceRows(offers: SaasHonOsSchoolOfferView | null, founder: SaasFounderSchoolAvailability | null): HonOsPriceRow[] {
  const p = HON_OS_LAUNCH_PRICING_REFERENCE;
  return SAAS_SCHEDULED_OFFER_KINDS.map((kind) => {
    const isFounder = kind.startsWith('FOUNDER_'), annual = kind.endsWith('_ANNUAL');
    const standard = annual ? p.standardAnnualPriceMinor : p.monthlyListPriceMinor;
    const reference = isFounder ? (annual ? p.founderAnnualPriceMinor : p.founderMonthlyPriceMinor) : standard;
    const server = offers?.offers.find((o) => o.offerKind === kind);
    const spot = isFounder ? founder?.offers.find((o) => o.offerKind === kind) : undefined;
    return {
      kind, founder: isFounder, annual, priceMinor: server?.priceMinor ?? reference,
      standardPriceMinor: spot?.standardPriceMinor ?? standard,
      // A published offer set that leaves a kind out means that price is not on sale now (e.g. founder sales closed).
      source: server ? 'SERVER_OFFER' : offers && offers.offerSetVersion !== null ? 'NOT_ON_SALE' : 'LAUNCH_REFERENCE',
      founderSpot: !isFounder ? null : spot ? { state: spot.available ? 'AVAILABLE' : 'UNAVAILABLE', reason: spot.reason }
        : founder?.organizationUsedFounderSpot ? { state: 'UNAVAILABLE', reason: 'FOUNDER_ALREADY_USED' }
        : founder && founder.pool.remaining === 0 ? { state: 'UNAVAILABLE', reason: 'FOUNDER_SOLD_OUT' } : { state: 'UNVERIFIED', reason: null },
    };
  });
}
