// B-HQ-3 HQ business numbers (migration 0326): HON's own contracted recurring revenue at list price, paying schools, schools
// that started or stopped paying, new schools, public sign-ups and trials per UTC month. Counts and sums only: no school,
// person or provider reference. Charges are not enabled, so every amount is a recorded list price, never collected money.
// Readers: HQ owner, or HQ operator with hq.billing.manage.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsRecord as record } from './champions-club.js';

export const HQ_BUSINESS_MONTHS_MAX = 12;
export const HQ_BUSINESS_MONTHS_DEFAULT = 6;

export interface HqBusinessCurrent {
  mrrMinor: number; arrMinor: number; payingSchools: number;
  payingByInterval: { MONTHLY: number; ANNUAL: number };
  payingBySource: { SCHEDULE_BINDING: number; V1_SUBSCRIPTION: number };
  unpricedActiveRecords: number; lifetimeSchools: number; bindingsNeedingReview: number; suspendedSubscriptions: number; activeTrials: number;
}
export interface HqBusinessMonth {
  month: string; monthToDate: boolean; newSchools: number; publicSignups: number; trialsStarted: number;
  newPayingSchools: number; trialConversions: number; stoppedPayingSchools: number;
}
export interface HqBusinessNumbers {
  current: HqBusinessCurrent; months: HqBusinessMonth[]; monthsRequested: number; currency: 'USD';
  chargesEnabled: false; churnRateAvailable: false; asOf: string;
}

const COUNT_MAX = 100_000_000, MINOR_MAX = 1_000_000_000_000;
const count = (v: unknown) => isInt(v, 0, COUNT_MAX);

export function validateHqBusinessNumbers(value: unknown): HqBusinessNumbers {
  const r = record(value, drift);
  exactKeys(r, ['current', 'months', 'monthsRequested', 'currency', 'chargesEnabled', 'churnRateAvailable', 'asOf'], drift);
  if (r.currency !== 'USD' || r.chargesEnabled !== false || r.churnRateAvailable !== false || !isTimestamp(r.asOf)
    || !isInt(r.monthsRequested, 1, HQ_BUSINESS_MONTHS_MAX)) drift();
  const c = record(r.current, drift);
  exactKeys(c, ['mrrMinor', 'arrMinor', 'payingSchools', 'payingByInterval', 'payingBySource', 'unpricedActiveRecords', 'lifetimeSchools',
    'bindingsNeedingReview', 'suspendedSubscriptions', 'activeTrials'], drift);
  const iv = record(c.payingByInterval, drift); exactKeys(iv, ['MONTHLY', 'ANNUAL'], drift);
  const src = record(c.payingBySource, drift); exactKeys(src, ['SCHEDULE_BINDING', 'V1_SUBSCRIPTION'], drift);
  if (!isInt(c.mrrMinor, 0, MINOR_MAX) || !isInt(c.arrMinor, 0, MINOR_MAX * 12) || c.arrMinor !== (c.mrrMinor as number) * 12
    || ![c.payingSchools, iv.MONTHLY, iv.ANNUAL, src.SCHEDULE_BINDING, src.V1_SUBSCRIPTION, c.unpricedActiveRecords, c.lifetimeSchools,
      c.bindingsNeedingReview, c.suspendedSubscriptions, c.activeTrials].every(count)
    || (iv.MONTHLY as number) + (iv.ANNUAL as number) !== c.payingSchools
    || (src.SCHEDULE_BINDING as number) + (src.V1_SUBSCRIPTION as number) !== c.payingSchools
    || (c.payingSchools === 0 && c.mrrMinor !== 0)) drift();
  if (!Array.isArray(r.months) || r.months.length !== r.monthsRequested) drift();
  let prior = '';
  (r.months as unknown[]).forEach((value, i, all) => {
    const m = record(value, drift);
    exactKeys(m, ['month', 'monthToDate', 'newSchools', 'publicSignups', 'trialsStarted', 'newPayingSchools', 'trialConversions',
      'stoppedPayingSchools'], drift);
    if (typeof m.month !== 'string' || !/^20[0-9]{2}-(0[1-9]|1[0-2])$/.test(m.month) || m.month <= prior
      || m.monthToDate !== (i === all.length - 1)
      || ![m.newSchools, m.publicSignups, m.trialsStarted, m.newPayingSchools, m.trialConversions, m.stoppedPayingSchools].every(count)
      || (m.trialConversions as number) > (m.newPayingSchools as number)) drift();
    prior = m.month as string;
  });
  return r as unknown as HqBusinessNumbers;
}
/** `months` query: absent means 6; otherwise a whole number 1..12. */
export function validateHqBusinessQuery(value: unknown): { months: number } {
  const q = record(value ?? {}, invalid);
  if (Object.keys(q).some(k => k !== 'months')) invalid();
  if (q.months === undefined) return { months: HQ_BUSINESS_MONTHS_DEFAULT };
  if (typeof q.months !== 'string' || !/^[1-9][0-9]?$/.test(q.months) || Number(q.months) > HQ_BUSINESS_MONTHS_MAX) invalid();
  return { months: Number(q.months) };
}
