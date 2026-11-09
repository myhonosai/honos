import { validateChampionsContestCommand, type ChampionsContest, type ChampionsContestConfig, type ChampionsContestPrizeKind } from '@hon/contracts';

/** What the person typed. Dates are whole UTC days; money is US dollars with at most two decimals. */
export type PrizeDraft = { placeFrom: string; placeTo: string; kind: ChampionsContestPrizeKind; description: string; quantity: string; unitCost: string };
export type ContestDraft = {
  name: string; description: string; termsReference: string; startsOn: string; endsOn: string;
  countBasis: ChampionsContestConfig['countBasis']; minimumQualified: string; tieRule: ChampionsContestConfig['tieRule'];
  scope: ChampionsContestConfig['eligibility']['scope']; tiers: ('ESSENTIAL' | 'CORE' | 'COMPLETE')[]; schoolIds: string[];
  budget: string; giftCardCompliance: ChampionsContestConfig['giftCardCompliance']; prizes: PrizeDraft[];
};
export const PRIZE_KINDS: readonly ChampionsContestPrizeKind[] = ['ELECTRONICS', 'AMUSEMENT_TICKETS', 'GIFT_CARD', 'EXPERIENCE', 'OTHER_APPROVED'];
export const TIERS = ['ESSENTIAL', 'CORE', 'COMPLETE'] as const;
export const emptyPrize = (place = 1): PrizeDraft => ({ placeFrom: String(place), placeTo: String(place), kind: 'EXPERIENCE', description: '', quantity: '1', unitCost: '' });
export function emptyDraft(): ContestDraft {
  return { name: '', description: '', termsReference: '', startsOn: '', endsOn: '', countBasis: 'QUALIFIED_IN_WINDOW', minimumQualified: '1', tieRule: 'OWNER_RESOLVES',
    scope: 'ALL_ACTIVE_SCHOOLS', tiers: ['CORE', 'COMPLETE'], schoolIds: [], budget: '', giftCardCompliance: 'UNDECIDED', prizes: [emptyPrize(1)] };
}

const DAY = /^(20\d{2})-(\d{2})-(\d{2})$/;
const MONEY = /^\d{1,7}(?:\.\d{1,2})?$/;
const WHOLE = /^[1-9]\d{0,3}$/;
/** A whole UTC day as an instant: start of the day, or its last millisecond for an end date. */
export function dayToInstant(day: string, end: boolean): string | null {
  const m = DAY.exec(day); if (!m) return null;
  const at = new Date(`${day}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== day ? null : at.toISOString();
}
export const instantToDay = (iso: string) => iso.slice(0, 10);
/** Dollars to cents, exactly; null when not a plain amount. */
export function dollarsToMinor(value: string): number | null {
  const v = value.trim(); if (!MONEY.test(v)) return null;
  const [whole, cents = ''] = v.split('.');
  return Number(whole) * 100 + Number(cents.padEnd(2, '0'));
}
export const minorToDollars = (minor: number) => (minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2));
export const formatMoney = (minor: number, locale: string) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(minor / 100);

/** The configuration a draft describes, or null when any field is not acceptable as typed. Checked by the same contract the server uses. */
export function configFrom(d: ContestDraft): ChampionsContestConfig | null {
  const startsAt = dayToInstant(d.startsOn, false), endsAt = dayToInstant(d.endsOn, true);
  const budgetMinor = d.budget.trim() === '' ? null : dollarsToMinor(d.budget);
  if (!startsAt || !endsAt || !WHOLE.test(d.minimumQualified) || (d.budget.trim() !== '' && budgetMinor === null)) return null;
  const prizes = [];
  for (const p of d.prizes) {
    const cost = dollarsToMinor(p.unitCost);
    if (!WHOLE.test(p.placeFrom) || !WHOLE.test(p.placeTo) || !WHOLE.test(p.quantity) || cost === null) return null;
    prizes.push({ placeFrom: Number(p.placeFrom), placeTo: Number(p.placeTo), kind: p.kind, description: p.description.trim(), quantity: Number(p.quantity), estimatedUnitCostMinor: cost });
  }
  const config: ChampionsContestConfig = { name: d.name.trim(), description: d.description.trim(), termsReference: d.termsReference.trim() || null, startsAt, endsAt,
    countBasis: d.countBasis, minimumQualified: Number(d.minimumQualified), tieRule: d.tieRule,
    eligibility: { scope: d.scope, tiers: TIERS.filter(t => d.tiers.includes(t)), schoolIds: d.scope === 'SELECTED_SCHOOLS' ? [...d.schoolIds] : [] },
    budgetMinor, giftCardCompliance: d.giftCardCompliance, prizes };
  try { validateChampionsContestCommand({ action: 'CREATE', ...config }); } catch { return null; }
  return config;
}
export function draftFrom(c: ChampionsContest): ContestDraft {
  return { name: c.name, description: c.description, termsReference: c.termsReference ?? '', startsOn: instantToDay(c.startsAt), endsOn: instantToDay(c.endsAt),
    countBasis: c.countBasis, minimumQualified: String(c.minimumQualified), tieRule: c.tieRule, scope: c.eligibility.scope, tiers: [...c.eligibility.tiers],
    schoolIds: [...c.eligibility.schoolIds], budget: c.budgetMinor === null ? '' : minorToDollars(c.budgetMinor), giftCardCompliance: c.giftCardCompliance,
    prizes: c.prizes.map(p => ({ placeFrom: String(p.placeFrom), placeTo: String(p.placeTo), kind: p.kind, description: p.description, quantity: String(p.quantity),
      unitCost: minorToDollars(p.estimatedUnitCostMinor) })) };
}
/** Estimated prize cost of a configuration: each place in a range gets `quantity` units. */
export const prizeCost = (prizes: readonly { placeFrom: number; placeTo: number; quantity: number; estimatedUnitCostMinor: number }[]) =>
  prizes.reduce((sum, p) => sum + (p.placeTo - p.placeFrom + 1) * p.quantity * p.estimatedUnitCostMinor, 0);

/** What still blocks scheduling, as the server will check it. Hints only; the server decides. */
export function scheduleBlockers(c: ChampionsContest, now = Date.now()): ('TERMS' | 'BUDGET' | 'PRIZES' | 'OVER_BUDGET' | 'GIFT_CARDS' | 'PASSED')[] {
  const out: ('TERMS' | 'BUDGET' | 'PRIZES' | 'OVER_BUDGET' | 'GIFT_CARDS' | 'PASSED')[] = [];
  if (c.termsReference === null) out.push('TERMS');
  if (c.budgetMinor === null) out.push('BUDGET');
  if (c.prizes.length === 0) out.push('PRIZES');
  if (c.budgetMinor !== null && prizeCost(c.prizes) > c.budgetMinor) out.push('OVER_BUDGET');
  if (c.prizes.some(p => p.kind === 'GIFT_CARD') && c.giftCardCompliance !== 'PERMITTED') out.push('GIFT_CARDS');
  if (Date.parse(c.endsAt) <= now) out.push('PASSED');
  return out;
}
