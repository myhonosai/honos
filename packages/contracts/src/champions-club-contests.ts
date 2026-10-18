// HON Champions Club Milestone 4: HQ-managed referral contests. Contests are windows over the
// same QUALIFIED referrals; prizes are recorded liabilities only (no purchase, gift card,
// message or public listing). Lifecycle transitions are explicit HQ commands.
import {
  championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsNullable as nullable, championsRecord as record,
} from './champions-club.js';

export type ChampionsContestStatus = 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'PAUSED' | 'ENDED' | 'PENDING_WINNER_APPROVAL' | 'COMPLETED' | 'CANCELLED';
export type ChampionsContestPrizeKind = 'ELECTRONICS' | 'AMUSEMENT_TICKETS' | 'GIFT_CARD' | 'EXPERIENCE' | 'OTHER_APPROVED';
export type ChampionsContestWinnerStatus = 'PROPOSED' | 'TIE_REVIEW' | 'DISPUTED' | 'APPROVED' | 'REJECTED';
export type ChampionsContestIneligibleReason = 'NOT_SELECTED' | 'TIER_NOT_ELIGIBLE' | 'SCHOOL_INACTIVE' | 'LEADERBOARD_HOLD' | 'BELOW_MINIMUM';
export const CHAMPIONS_CONTEST_STATUSES: readonly ChampionsContestStatus[] = ['DRAFT','SCHEDULED','ACTIVE','PAUSED','ENDED','PENDING_WINNER_APPROVAL','COMPLETED','CANCELLED'];
const PRIZE_KINDS: readonly string[] = ['ELECTRONICS','AMUSEMENT_TICKETS','GIFT_CARD','EXPERIENCE','OTHER_APPROVED'];
const WINNER_STATUSES: readonly string[] = ['PROPOSED','TIE_REVIEW','DISPUTED','APPROVED','REJECTED'];
const WINNER_REASONS: readonly string[] = ['TIE_AT_BOUNDARY','OWNER_TIE_RESOLUTION','DISPUTE_RAISED','DISPUTE_DISMISSED','DISPUTE_UPHELD','FRAUD_CONFIRMED','INELIGIBLE','REASSIGNED','APPROVED'];
const INELIGIBLE: readonly string[] = ['NOT_SELECTED','TIER_NOT_ELIGIBLE','SCHOOL_INACTIVE','LEADERBOARD_HOLD','BELOW_MINIMUM'];
const ACTIONS: readonly string[] = ['CREATE','UPDATE','DUPLICATE','SCHEDULE','ACTIVATE','PAUSE','RESUME','END','PROPOSE_WINNERS','APPROVE_WINNER','DISPUTE_WINNER','REJECT_WINNER','RESOLVE_WINNER','COMPLETE','CANCEL'];
const TIERS: readonly string[] = ['ESSENTIAL','CORE','COMPLETE'];
const TS = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface ChampionsContestPrizeInput { placeFrom: number; placeTo: number; kind: ChampionsContestPrizeKind; description: string; quantity: number; estimatedUnitCostMinor: number }
export interface ChampionsContestConfig {
  name: string; description: string; termsReference: string | null; startsAt: string; endsAt: string;
  countBasis: 'CAPTURED_AND_QUALIFIED_IN_WINDOW' | 'QUALIFIED_IN_WINDOW'; minimumQualified: number; tieRule: 'OWNER_RESOLVES' | 'EARLIEST_TO_REACH';
  eligibility: { scope: 'ALL_ACTIVE_SCHOOLS' | 'SELECTED_SCHOOLS'; tiers: ('ESSENTIAL' | 'CORE' | 'COMPLETE')[]; schoolIds: string[] };
  budgetMinor: number | null; giftCardCompliance: 'UNDECIDED' | 'PERMITTED' | 'NOT_PERMITTED'; prizes: ChampionsContestPrizeInput[];
}
export type ChampionsContestCommand =
  | ({ action: 'CREATE' } & ChampionsContestConfig)
  | ({ action: 'UPDATE'; expectedVersion: number } & ChampionsContestConfig)
  | { action: 'DUPLICATE'; name: string; startsAt: string; endsAt: string }
  | { action: 'SCHEDULE'; expectedVersion: number; schoolVisibility: 'HIDDEN' | 'ELIGIBLE_SCHOOLS' }
  | { action: 'ACTIVATE' | 'PAUSE' | 'RESUME' | 'END' | 'PROPOSE_WINNERS' | 'COMPLETE'; expectedVersion: number }
  | { action: 'CANCEL'; expectedVersion: number; reasonCode: 'OWNER_DECISION' | 'POLICY_CHANGE' | 'FRAUD_CONCERN' | 'LEGAL_REVIEW' }
  | { action: 'APPROVE_WINNER'; expectedVersion: number; winnerId: string }
  | { action: 'DISPUTE_WINNER'; expectedVersion: number; winnerId: string; reasonCode: 'DISPUTE_RAISED' }
  | { action: 'REJECT_WINNER'; expectedVersion: number; winnerId: string; reasonCode: 'DISPUTE_UPHELD' | 'FRAUD_CONFIRMED' | 'INELIGIBLE' }
  | { action: 'RESOLVE_WINNER'; expectedVersion: number; winnerId: string; schoolId: string };
export interface ChampionsContestPrize extends ChampionsContestPrizeInput { prizeId: string }
export interface ChampionsContest extends Omit<ChampionsContestConfig, 'prizes'> {
  contestId: string; status: ChampionsContestStatus; version: number; currency: 'USD'; schoolVisibility: 'HIDDEN' | 'ELIGIBLE_SCHOOLS';
  publicListing: 'DISABLED'; financialActivation: 'DISABLED'; automaticTransitions: 'NOT_CONFIGURED';
  prizes: ChampionsContestPrize[]; estimatedPrizeCostMinor: number; due: 'NONE' | 'START_DUE' | 'END_DUE'; duplicatedFrom: string | null;
  createdAt: string; scheduledAt: string | null; activatedAt: string | null; endedAt: string | null; completedAt: string | null; cancelledAt: string | null;
  cancelReason: string | null;
}
export interface ChampionsContestReceipt { contest: ChampionsContest; action: string; replayed: boolean }
export interface ChampionsContestList { contests: ChampionsContest[]; limit: 100 }
export interface ChampionsContestStanding {
  schoolId: string; schoolName: string; organizationId: string; qualifiedReferrals: number; reachedAt: string;
  eligible: boolean; ineligibleReason: ChampionsContestIneligibleReason | null; rank: number | null; position: number | null;
}
export interface ChampionsContestWinner {
  winnerId: string; place: number; prizeId: string; schoolId: string; schoolName: string; status: ChampionsContestWinnerStatus;
  reasonCode: string | null; estimatedCostMinor: number; version: number; decidedAt: string | null;
}
export interface ChampionsContestDetail {
  contest: ChampionsContest; standings: ChampionsContestStanding[]; standingsFrozen: boolean;
  pauses: { pausedAt: string; resumedAt: string | null }[]; winners: ChampionsContestWinner[];
  liabilities: { currency: 'USD'; budgetMinor: number | null; estimatedPrizeCostMinor: number; pendingWinnerCostMinor: number; approvedWinnerCostMinor: number; financialActivation: 'DISABLED' };
  history: { action: string; fromStatus: string; toStatus: string; contestVersion: number; detail: Record<string, unknown>; occurredAt: string }[];
  countsOnly: 'QUALIFIED';
}
export interface ChampionsSchoolContest {
  contestId: string; name: string; description: string; termsReference: string | null; status: ChampionsContestStatus; startsAt: string; endsAt: string;
  minimumQualified: number; prizes: Omit<ChampionsContestPrizeInput, 'estimatedUnitCostMinor'>[];
  standings: { rank: number; displayName: string | null; anonymous: boolean; qualifiedReferrals: number; isYou: boolean }[];
  you: { qualifiedReferrals: number; status: 'RANKED' | 'NOT_RANKED'; rank: number | null }; won: boolean;
}
export interface ChampionsSchoolContests { schoolId: string; contests: ChampionsSchoolContest[]; countsOnly: 'QUALIFIED' }

const isText = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && v.length >= min && v.length <= max && v.trim() === v;
const isTs = (v: unknown): v is string => typeof v === 'string' && TS.test(v) && Number.isFinite(Date.parse(v));
const version = (v: unknown): v is number => isInt(v, 1, 999_999_999);
const count = (v: unknown): v is number => isInt(v, 0, Number.MAX_SAFE_INTEGER);

// ---------- inputs ----------
function config(input: Record<string, unknown>): ChampionsContestConfig {
  if (!isText(input.name, 3, 120) || !isText(input.description, 1, 2000) || (input.termsReference !== null && !isText(input.termsReference, 1, 500))
    || !isTs(input.startsAt) || !isTs(input.endsAt) || Date.parse(input.endsAt) <= Date.parse(input.startsAt)
    || Date.parse(input.endsAt) - Date.parse(input.startsAt) > 366 * 86400_000
    || !['CAPTURED_AND_QUALIFIED_IN_WINDOW','QUALIFIED_IN_WINDOW'].includes(input.countBasis as string) || !isInt(input.minimumQualified, 1, 1000)
    || !['OWNER_RESOLVES','EARLIEST_TO_REACH'].includes(input.tieRule as string) || (input.budgetMinor !== null && !isInt(input.budgetMinor, 0, 100_000_000))
    || !['UNDECIDED','PERMITTED','NOT_PERMITTED'].includes(input.giftCardCompliance as string) || !Array.isArray(input.prizes) || input.prizes.length > 20) invalid();
  const e = record(input.eligibility, invalid); exactKeys(e, ['scope','tiers','schoolIds'], invalid);
  if (!['ALL_ACTIVE_SCHOOLS','SELECTED_SCHOOLS'].includes(e.scope as string) || !Array.isArray(e.tiers) || e.tiers.length < 1 || e.tiers.length > 3
    || e.tiers.some(t => !TIERS.includes(t as string)) || new Set(e.tiers).size !== e.tiers.length || !Array.isArray(e.schoolIds) || e.schoolIds.length > 500
    || e.schoolIds.some(id => !isUuid(id)) || (e.scope === 'SELECTED_SCHOOLS') !== (e.schoolIds.length > 0)) invalid();
  const prizes = (input.prizes as unknown[]).map(item => {
    const p = record(item, invalid); exactKeys(p, ['placeFrom','placeTo','kind','description','quantity','estimatedUnitCostMinor'], invalid);
    if (!isInt(p.placeFrom, 1, 100) || !isInt(p.placeTo, 1, 100) || (p.placeTo as number) < (p.placeFrom as number) || !PRIZE_KINDS.includes(p.kind as string)
      || !isText(p.description, 1, 300) || !isInt(p.quantity, 1, 100) || !isInt(p.estimatedUnitCostMinor, 0, 10_000_000)) invalid();
    return { placeFrom: p.placeFrom as number, placeTo: p.placeTo as number, kind: p.kind as ChampionsContestPrizeKind, description: p.description as string,
      quantity: p.quantity as number, estimatedUnitCostMinor: p.estimatedUnitCostMinor as number };
  });
  const sorted = [...prizes].sort((a, b) => a.placeFrom - b.placeFrom);
  for (let i = 1; i < sorted.length; i++) if ((sorted[i] as ChampionsContestPrizeInput).placeFrom <= (sorted[i - 1] as ChampionsContestPrizeInput).placeTo) invalid();
  return { name: input.name, description: input.description, termsReference: input.termsReference as string | null, startsAt: input.startsAt, endsAt: input.endsAt,
    countBasis: input.countBasis as ChampionsContestConfig['countBasis'], minimumQualified: input.minimumQualified as number, tieRule: input.tieRule as ChampionsContestConfig['tieRule'],
    eligibility: { scope: e.scope as ChampionsContestConfig['eligibility']['scope'], tiers: e.tiers as ChampionsContestConfig['eligibility']['tiers'],
      schoolIds: (e.schoolIds as string[]).map(id => id.toLowerCase()) },
    budgetMinor: input.budgetMinor as number | null, giftCardCompliance: input.giftCardCompliance as ChampionsContestConfig['giftCardCompliance'], prizes };
}
const CONFIG_KEYS = ['name','description','termsReference','startsAt','endsAt','countBasis','minimumQualified','tieRule','eligibility','budgetMinor','giftCardCompliance','prizes'];
/** One closed shape per action. Returns the command and whether it targets an existing contest. */
export function validateChampionsContestCommand(value: unknown): ChampionsContestCommand {
  const input = record(value, invalid);
  const action = input.action;
  if (typeof action !== 'string' || !ACTIONS.includes(action)) invalid();
  const keys = (extra: string[]) => exactKeys(input, ['action', ...extra], invalid);
  const winner = () => { if (!isUuid(input.winnerId)) invalid(); return (input.winnerId as string).toLowerCase(); };
  switch (action) {
    case 'CREATE': keys(CONFIG_KEYS); return { action, ...config(input) };
    case 'UPDATE': keys([...CONFIG_KEYS, 'expectedVersion']); if (!version(input.expectedVersion)) invalid(); return { action, expectedVersion: input.expectedVersion as number, ...config(input) };
    case 'DUPLICATE':
      keys(['name','startsAt','endsAt']);
      if (!isText(input.name, 3, 120) || !isTs(input.startsAt) || !isTs(input.endsAt) || Date.parse(input.endsAt) <= Date.parse(input.startsAt)) invalid();
      return { action, name: input.name as string, startsAt: input.startsAt as string, endsAt: input.endsAt as string };
    case 'SCHEDULE':
      keys(['expectedVersion','schoolVisibility']);
      if (!version(input.expectedVersion) || !['HIDDEN','ELIGIBLE_SCHOOLS'].includes(input.schoolVisibility as string)) invalid();
      return { action, expectedVersion: input.expectedVersion as number, schoolVisibility: input.schoolVisibility as 'HIDDEN' | 'ELIGIBLE_SCHOOLS' };
    case 'CANCEL':
      keys(['expectedVersion','reasonCode']);
      if (!version(input.expectedVersion) || !['OWNER_DECISION','POLICY_CHANGE','FRAUD_CONCERN','LEGAL_REVIEW'].includes(input.reasonCode as string)) invalid();
      return { action, expectedVersion: input.expectedVersion as number, reasonCode: input.reasonCode as 'OWNER_DECISION' };
    case 'APPROVE_WINNER': keys(['expectedVersion','winnerId']); if (!version(input.expectedVersion)) invalid(); return { action, expectedVersion: input.expectedVersion as number, winnerId: winner() };
    case 'DISPUTE_WINNER':
      keys(['expectedVersion','winnerId','reasonCode']); if (!version(input.expectedVersion) || input.reasonCode !== 'DISPUTE_RAISED') invalid();
      return { action, expectedVersion: input.expectedVersion as number, winnerId: winner(), reasonCode: 'DISPUTE_RAISED' };
    case 'REJECT_WINNER':
      keys(['expectedVersion','winnerId','reasonCode']);
      if (!version(input.expectedVersion) || !['DISPUTE_UPHELD','FRAUD_CONFIRMED','INELIGIBLE'].includes(input.reasonCode as string)) invalid();
      return { action, expectedVersion: input.expectedVersion as number, winnerId: winner(), reasonCode: input.reasonCode as 'DISPUTE_UPHELD' };
    case 'RESOLVE_WINNER':
      keys(['expectedVersion','winnerId','schoolId']); if (!version(input.expectedVersion) || !isUuid(input.schoolId)) invalid();
      return { action, expectedVersion: input.expectedVersion as number, winnerId: winner(), schoolId: (input.schoolId as string).toLowerCase() };
    default: keys(['expectedVersion']); if (!version(input.expectedVersion)) invalid();
      return { action: action as 'ACTIVATE', expectedVersion: input.expectedVersion as number };
  }
}
export function validateChampionsContestStatusFilter(value: unknown): ChampionsContestStatus | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !(CHAMPIONS_CONTEST_STATUSES as readonly string[]).includes(value)) invalid();
  return value as ChampionsContestStatus;
}

// ---------- responses (closed; drift fails closed) ----------
function checkContest(value: unknown): ChampionsContest {
  const r = record(value, drift);
  exactKeys(r, ['contestId','name','description','termsReference','status','version','startsAt','endsAt','countBasis','minimumQualified','tieRule','eligibility',
    'budgetMinor','currency','giftCardCompliance','schoolVisibility','publicListing','financialActivation','automaticTransitions','prizes','estimatedPrizeCostMinor',
    'due','duplicatedFrom','createdAt','scheduledAt','activatedAt','endedAt','completedAt','cancelledAt','cancelReason'], drift);
  if (!isUuid(r.contestId) || !isText(r.name, 3, 120) || !isText(r.description, 1, 2000) || !nullable(r.termsReference, (v): v is string => isText(v, 1, 500))
    || !(CHAMPIONS_CONTEST_STATUSES as readonly unknown[]).includes(r.status) || !version(r.version) || !isTs(r.startsAt) || !isTs(r.endsAt)
    || !['CAPTURED_AND_QUALIFIED_IN_WINDOW','QUALIFIED_IN_WINDOW'].includes(r.countBasis as string) || !isInt(r.minimumQualified, 1, 1000)
    || !['OWNER_RESOLVES','EARLIEST_TO_REACH'].includes(r.tieRule as string) || (r.budgetMinor !== null && !count(r.budgetMinor)) || r.currency !== 'USD'
    || !['UNDECIDED','PERMITTED','NOT_PERMITTED'].includes(r.giftCardCompliance as string) || !['HIDDEN','ELIGIBLE_SCHOOLS'].includes(r.schoolVisibility as string)
    || r.publicListing !== 'DISABLED' || r.financialActivation !== 'DISABLED' || r.automaticTransitions !== 'NOT_CONFIGURED' || !Array.isArray(r.prizes)
    || !count(r.estimatedPrizeCostMinor) || !['NONE','START_DUE','END_DUE'].includes(r.due as string) || !nullable(r.duplicatedFrom, isUuid) || !isTs(r.createdAt)
    || [r.scheduledAt, r.activatedAt, r.endedAt, r.completedAt, r.cancelledAt].some(v => !nullable(v, isTs))
    || !(r.cancelReason === null || ['OWNER_DECISION','POLICY_CHANGE','FRAUD_CONCERN','LEGAL_REVIEW'].includes(r.cancelReason as string))) drift();
  const e = record(r.eligibility, drift); exactKeys(e, ['scope','tiers','schoolIds'], drift);
  if (!['ALL_ACTIVE_SCHOOLS','SELECTED_SCHOOLS'].includes(e.scope as string) || !Array.isArray(e.tiers) || e.tiers.some(t => !TIERS.includes(t as string))
    || !Array.isArray(e.schoolIds) || e.schoolIds.some(id => !isUuid(id))) drift();
  for (const item of r.prizes as unknown[]) {
    const p = record(item, drift); exactKeys(p, ['prizeId','placeFrom','placeTo','kind','description','quantity','estimatedUnitCostMinor'], drift);
    if (!isUuid(p.prizeId) || !isInt(p.placeFrom, 1, 100) || !isInt(p.placeTo, 1, 100) || !PRIZE_KINDS.includes(p.kind as string) || !isText(p.description, 1, 300)
      || !isInt(p.quantity, 1, 100) || !count(p.estimatedUnitCostMinor)) drift();
  }
  return r as unknown as ChampionsContest;
}
export function validateChampionsContestReceipt(value: unknown): ChampionsContestReceipt {
  const r = record(value, drift); exactKeys(r, ['contest','action','replayed'], drift);
  checkContest(r.contest); if (!ACTIONS.includes(r.action as string) || typeof r.replayed !== 'boolean') drift();
  return r as unknown as ChampionsContestReceipt;
}
export function validateChampionsContestList(value: unknown): ChampionsContestList {
  const r = record(value, drift); exactKeys(r, ['contests','limit'], drift);
  if (r.limit !== 100 || !Array.isArray(r.contests) || r.contests.length > 100) drift();
  for (const c of r.contests as unknown[]) checkContest(c);
  return r as unknown as ChampionsContestList;
}
export function validateChampionsContestDetail(value: unknown): ChampionsContestDetail {
  const r = record(value, drift); exactKeys(r, ['contest','standings','standingsFrozen','pauses','winners','liabilities','history','countsOnly'], drift);
  checkContest(r.contest);
  if (typeof r.standingsFrozen !== 'boolean' || r.countsOnly !== 'QUALIFIED' || !Array.isArray(r.standings) || !Array.isArray(r.pauses) || !Array.isArray(r.winners) || !Array.isArray(r.history)) drift();
  for (const item of r.standings as unknown[]) {
    const s = record(item, drift); exactKeys(s, ['schoolId','schoolName','organizationId','qualifiedReferrals','reachedAt','eligible','ineligibleReason','rank','position'], drift);
    if (!isUuid(s.schoolId) || !isText(s.schoolName, 1, 300) || !isUuid(s.organizationId) || !isInt(s.qualifiedReferrals, 1, 1_000_000) || !isTimestamp(s.reachedAt)
      || typeof s.eligible !== 'boolean' || (s.eligible ? s.ineligibleReason !== null || !isInt(s.rank, 1, 1_000_000) || !isInt(s.position, 1, 1_000_000)
        : !INELIGIBLE.includes(s.ineligibleReason as string) || s.rank !== null || s.position !== null)) drift();
  }
  for (const item of r.pauses as unknown[]) { const p = record(item, drift); exactKeys(p, ['pausedAt','resumedAt'], drift); if (!isTimestamp(p.pausedAt) || !nullable(p.resumedAt, isTimestamp)) drift(); }
  for (const item of r.winners as unknown[]) {
    const w = record(item, drift); exactKeys(w, ['winnerId','place','prizeId','schoolId','schoolName','status','reasonCode','estimatedCostMinor','version','decidedAt'], drift);
    if (!isUuid(w.winnerId) || !isInt(w.place, 1, 100) || !isUuid(w.prizeId) || !isUuid(w.schoolId) || !isText(w.schoolName, 1, 300) || !WINNER_STATUSES.includes(w.status as string)
      || !(w.reasonCode === null || WINNER_REASONS.includes(w.reasonCode as string)) || !count(w.estimatedCostMinor) || !version(w.version) || !nullable(w.decidedAt, isTimestamp)) drift();
  }
  const l = record(r.liabilities, drift);
  exactKeys(l, ['currency','budgetMinor','estimatedPrizeCostMinor','pendingWinnerCostMinor','approvedWinnerCostMinor','financialActivation'], drift);
  if (l.currency !== 'USD' || l.financialActivation !== 'DISABLED' || (l.budgetMinor !== null && !count(l.budgetMinor))
    || ![l.estimatedPrizeCostMinor, l.pendingWinnerCostMinor, l.approvedWinnerCostMinor].every(count)) drift();
  for (const item of r.history as unknown[]) {
    const h = record(item, drift); exactKeys(h, ['action','fromStatus','toStatus','contestVersion','detail','occurredAt'], drift);
    if (!ACTIONS.includes(h.action as string) || typeof h.fromStatus !== 'string' || typeof h.toStatus !== 'string' || !version(h.contestVersion)
      || !h.detail || typeof h.detail !== 'object' || !isTimestamp(h.occurredAt)) drift();
  }
  return r as unknown as ChampionsContestDetail;
}
export function validateChampionsSchoolContests(value: unknown): ChampionsSchoolContests {
  const r = record(value, drift); exactKeys(r, ['schoolId','contests','countsOnly'], drift);
  if (!isUuid(r.schoolId) || r.countsOnly !== 'QUALIFIED' || !Array.isArray(r.contests)) drift();
  for (const item of r.contests as unknown[]) {
    const c = record(item, drift);
    exactKeys(c, ['contestId','name','description','termsReference','status','startsAt','endsAt','minimumQualified','prizes','standings','you','won'], drift);
    if (!isUuid(c.contestId) || !isText(c.name, 3, 120) || !isText(c.description, 1, 2000) || !nullable(c.termsReference, (v): v is string => isText(v, 1, 500))
      || !['SCHEDULED','ACTIVE','PAUSED','ENDED','PENDING_WINNER_APPROVAL','COMPLETED'].includes(c.status as string) || !isTs(c.startsAt) || !isTs(c.endsAt)
      || !isInt(c.minimumQualified, 1, 1000) || !Array.isArray(c.prizes) || !Array.isArray(c.standings) || c.standings.length > 10 || typeof c.won !== 'boolean') drift();
    for (const p of c.prizes as unknown[]) {
      const x = record(p, drift); exactKeys(x, ['placeFrom','placeTo','kind','description','quantity'], drift);
      if (!isInt(x.placeFrom, 1, 100) || !isInt(x.placeTo, 1, 100) || !PRIZE_KINDS.includes(x.kind as string) || !isText(x.description, 1, 300) || !isInt(x.quantity, 1, 100)) drift();
    }
    for (const s of c.standings as unknown[]) {
      const x = record(s, drift); exactKeys(x, ['rank','displayName','anonymous','qualifiedReferrals','isYou'], drift);
      if (!isInt(x.rank, 1, 1_000_000) || typeof x.anonymous !== 'boolean' || typeof x.isYou !== 'boolean' || !isInt(x.qualifiedReferrals, 1, 1_000_000)
        || (x.anonymous ? x.displayName !== null : !isText(x.displayName, 1, 300)) || (x.isYou && x.anonymous)) drift();
    }
    const y = record(c.you, drift); exactKeys(y, ['qualifiedReferrals','status','rank'], drift);
    if (!count(y.qualifiedReferrals) || !((y.status === 'RANKED' && isInt(y.rank, 1, 1_000_000)) || (y.status === 'NOT_RANKED' && y.rank === null))) drift();
  }
  return r as unknown as ChampionsSchoolContests;
}
