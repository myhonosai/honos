// HON Champions Club Milestone 3: referral leaderboards, school statistics and privacy.
// Official standings count QUALIFIED referrals only. Schools are anonymous unless opted in.
import {
  championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsNullable as nullable, championsRecord as record,
  CHAMPIONS_ATTRIBUTION_STATES, CHAMPIONS_STATE_REASONS, type ChampionsAttributionState, type ChampionsStateReason,
} from './champions-club.js';
import { CHAMPIONS_REWARD_KINDS, type ChampionsRewardKind } from './champions-club-rewards.js';

export type ChampionsLeaderboardPeriod = 'ALL_TIME' | 'MONTH';
export type ChampionsDisplayMode = 'ANONYMOUS' | 'SCHOOL_NAME';
export type ChampionsHoldReason = 'FRAUD_REVIEW' | 'DUPLICATE_REVIEW' | 'DISPUTE' | 'OWNER_REVIEW';
export interface ChampionsLeaderboardQuery { period: ChampionsLeaderboardPeriod; month: string | null }
export interface ChampionsReferralStateCounts { pending: number; qualified: number; rejected: number; refunded: number; reversed: number }

export interface ChampionsHqStanding {
  rank: number; position: number; schoolId: string; schoolName: string; organizationId: string; organizationName: string;
  qualifiedReferrals: number; pendingReferrals: number; reachedAt: string; displayMode: ChampionsDisplayMode;
}
export interface ChampionsHqLeaderboard {
  period: ChampionsLeaderboardPeriod; month: string | null; standings: ChampionsHqStanding[]; totalRanked: number; limit: 100;
  held: { schoolId: string; schoolName: string; reasonCode: ChampionsHoldReason; placedAt: string; qualifiedReferrals: number }[];
  countsOnly: 'QUALIFIED'; timeZone: 'UTC';
}
export interface ChampionsSchoolStanding { rank: number; displayName: string | null; anonymous: boolean; qualifiedReferrals: number; isYou: boolean }
export interface ChampionsSchoolLeaderboard {
  period: ChampionsLeaderboardPeriod; month: string | null; standings: ChampionsSchoolStanding[]; limit: 25;
  you: { schoolId: string; status: 'RANKED' | 'NOT_RANKED'; rank: number | null; qualifiedReferrals: number; displayMode: ChampionsDisplayMode };
  countsOnly: 'QUALIFIED'; timeZone: 'UTC';
}
export interface ChampionsMilestoneProgress {
  program: { status: 'POLICY_UNDECIDED' | 'PUBLISHED'; policyVersion: number | null };
  reached: { rewardKind: ChampionsRewardKind; milestoneCount: number }[];
  nextMilestone: { rewardKind: ChampionsRewardKind; milestoneCount: number; remaining: number } | null;
  qualifiedReferrals: number;
}
export interface ChampionsHistoryItem { occurredAt: string; fromState: ChampionsAttributionState | null; toState: ChampionsAttributionState; reason: ChampionsStateReason }
export interface ChampionsHqHistoryItem extends ChampionsHistoryItem { attributionId: string; referredOrganizationId: string; referredOrganizationName: string }
interface ChampionsStatisticsBase {
  schoolId: string; referrals: ChampionsReferralStateCounts; monthlyQualified: { month: string; qualified: number }[];
  milestones: ChampionsMilestoneProgress; allTimeRank: number | null; historyLimit: 50; displayMode: ChampionsDisplayMode;
}
export interface ChampionsSchoolStatistics extends ChampionsStatisticsBase { history: ChampionsHistoryItem[] }
export interface ChampionsHqSchoolStatistics extends ChampionsStatisticsBase {
  history: ChampionsHqHistoryItem[]; schoolName: string; organizationId: string; hold: { reasonCode: ChampionsHoldReason; placedAt: string } | null;
}
export type ChampionsHoldInput = { action: 'PLACE'; schoolId: string; reasonCode: ChampionsHoldReason } | { action: 'RELEASE'; schoolId: string };
export interface ChampionsHoldReceipt { schoolId: string; status: 'ACTIVE' | 'RELEASED'; reasonCode: ChampionsHoldReason; placedAt: string; releasedAt: string | null; replayed: boolean }
export interface ChampionsPreferenceInput { displayMode: ChampionsDisplayMode }
export interface ChampionsPreferenceReceipt { schoolId: string; displayMode: ChampionsDisplayMode; version: number; updatedAt: string; replayed: boolean }

const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const HOLD_REASONS: readonly string[] = ['FRAUD_REVIEW','DUPLICATE_REVIEW','DISPUTE','OWNER_REVIEW'];
const MODES: readonly string[] = ['ANONYMOUS','SCHOOL_NAME'];
const isName = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 300;
const count = (v: unknown): v is number => isInt(v, 0, Number.MAX_SAFE_INTEGER);

// ---------- inputs ----------
/** `period` defaults to ALL_TIME; MONTH requires `month` (YYYY-MM, UTC). No other selector exists. */
export function validateChampionsLeaderboardQuery(value: unknown): ChampionsLeaderboardQuery {
  const q = (value ?? {}) as Record<string, unknown>;
  if (typeof q !== 'object' || Array.isArray(q) || Object.keys(q).some(k => k !== 'period' && k !== 'month')) invalid();
  const period = q.period === undefined ? 'ALL_TIME' : q.period;
  if (period === 'ALL_TIME' && q.month === undefined) return { period, month: null };
  if (period === 'MONTH' && typeof q.month === 'string' && MONTH.test(q.month)) return { period, month: q.month };
  return invalid();
}
export function validateChampionsHoldInput(value: unknown): ChampionsHoldInput {
  const input = record(value, invalid);
  if (typeof input.schoolId !== 'string' || !isUuid(input.schoolId)) invalid();
  const schoolId = input.schoolId.toLowerCase();
  if (input.action === 'PLACE') {
    exactKeys(input, ['action','schoolId','reasonCode'], invalid);
    if (!HOLD_REASONS.includes(input.reasonCode as string)) invalid();
    return { action: 'PLACE', schoolId, reasonCode: input.reasonCode as ChampionsHoldReason };
  }
  if (input.action === 'RELEASE') { exactKeys(input, ['action','schoolId'], invalid); return { action: 'RELEASE', schoolId }; }
  return invalid();
}
export function validateChampionsPreferenceInput(value: unknown): ChampionsPreferenceInput {
  const input = record(value, invalid); exactKeys(input, ['displayMode'], invalid);
  if (!MODES.includes(input.displayMode as string)) invalid();
  return { displayMode: input.displayMode as ChampionsDisplayMode };
}

// ---------- responses (closed; drift fails closed) ----------
function checkPeriod(r: Record<string, unknown>): void {
  if (!((r.period === 'ALL_TIME' && r.month === null) || (r.period === 'MONTH' && typeof r.month === 'string' && MONTH.test(r.month)))
    || r.countsOnly !== 'QUALIFIED' || r.timeZone !== 'UTC') drift();
}
export function validateChampionsHqLeaderboard(value: unknown): ChampionsHqLeaderboard {
  const r = record(value, drift); exactKeys(r, ['period','month','standings','totalRanked','limit','held','countsOnly','timeZone'], drift);
  checkPeriod(r);
  if (r.limit !== 100 || !count(r.totalRanked) || !Array.isArray(r.standings) || r.standings.length > 100 || !Array.isArray(r.held)) drift();
  let previous: { rank: number; position: number; qualified: number } | null = null;
  for (const item of r.standings as unknown[]) {
    const s = record(item, drift);
    exactKeys(s, ['rank','position','schoolId','schoolName','organizationId','organizationName','qualifiedReferrals','pendingReferrals','reachedAt','displayMode'], drift);
    if (!isInt(s.rank, 1, 1_000_000) || !isInt(s.position, 1, 1_000_000) || !isUuid(s.schoolId) || !isName(s.schoolName) || !isUuid(s.organizationId)
      || !isName(s.organizationName) || !isInt(s.qualifiedReferrals, 1, 1_000_000) || !count(s.pendingReferrals) || !isTimestamp(s.reachedAt)
      || !MODES.includes(s.displayMode as string)) drift();
    // Standings are ordered: positions consecutive, counts non-increasing, ties share a rank.
    const current = { rank: s.rank as number, position: s.position as number, qualified: s.qualifiedReferrals as number };
    if (previous && (current.position !== previous.position + 1 || current.qualified > previous.qualified
      || (current.qualified === previous.qualified) !== (current.rank === previous.rank))) drift();
    if (!previous && (current.position !== 1 || current.rank !== 1)) drift();
    previous = current;
  }
  for (const item of r.held as unknown[]) {
    const h = record(item, drift); exactKeys(h, ['schoolId','schoolName','reasonCode','placedAt','qualifiedReferrals'], drift);
    if (!isUuid(h.schoolId) || !isName(h.schoolName) || !HOLD_REASONS.includes(h.reasonCode as string) || !isTimestamp(h.placedAt) || !count(h.qualifiedReferrals)) drift();
  }
  return r as unknown as ChampionsHqLeaderboard;
}
export function validateChampionsSchoolLeaderboard(value: unknown): ChampionsSchoolLeaderboard {
  const r = record(value, drift); exactKeys(r, ['period','month','standings','limit','you','countsOnly','timeZone'], drift);
  checkPeriod(r);
  if (r.limit !== 25 || !Array.isArray(r.standings) || r.standings.length > 25) drift();
  for (const item of r.standings as unknown[]) {
    const s = record(item, drift); exactKeys(s, ['rank','displayName','anonymous','qualifiedReferrals','isYou'], drift);
    if (!isInt(s.rank, 1, 1_000_000) || typeof s.anonymous !== 'boolean' || typeof s.isYou !== 'boolean' || !isInt(s.qualifiedReferrals, 1, 1_000_000)
      || (s.anonymous ? s.displayName !== null : !isName(s.displayName)) || (s.isYou && s.anonymous)) drift();
  }
  const you = record(r.you, drift); exactKeys(you, ['schoolId','status','rank','qualifiedReferrals','displayMode'], drift);
  if (!isUuid(you.schoolId) || !count(you.qualifiedReferrals) || !MODES.includes(you.displayMode as string)
    || !((you.status === 'RANKED' && isInt(you.rank, 1, 1_000_000)) || (you.status === 'NOT_RANKED' && you.rank === null))) drift();
  return r as unknown as ChampionsSchoolLeaderboard;
}
function checkStatistics(r: Record<string, unknown>, hq: boolean): void {
  const counts = record(r.referrals, drift); exactKeys(counts, ['pending','qualified','rejected','refunded','reversed'], drift);
  if (!isUuid(r.schoolId) || Object.values(counts).some(v => !count(v)) || !Array.isArray(r.monthlyQualified) || r.monthlyQualified.length !== 12
    || !nullable(r.allTimeRank, (v): v is number => isInt(v, 1, 1_000_000)) || r.historyLimit !== 50 || !Array.isArray(r.history) || r.history.length > 50
    || !MODES.includes(r.displayMode as string)) drift();
  for (const item of r.monthlyQualified as unknown[]) {
    const m = record(item, drift); exactKeys(m, ['month','qualified'], drift);
    if (typeof m.month !== 'string' || !MONTH.test(m.month) || !count(m.qualified)) drift();
  }
  const ms = record(r.milestones, drift); exactKeys(ms, ['program','reached','nextMilestone','qualifiedReferrals'], drift);
  const program = record(ms.program, drift); exactKeys(program, ['status','policyVersion'], drift);
  if (!((program.status === 'POLICY_UNDECIDED' && program.policyVersion === null) || (program.status === 'PUBLISHED' && isInt(program.policyVersion, 1, 2147483647)))
    || ms.qualifiedReferrals !== counts.qualified || !Array.isArray(ms.reached)) drift();
  for (const item of ms.reached as unknown[]) {
    const x = record(item, drift); exactKeys(x, ['rewardKind','milestoneCount'], drift);
    if (!(CHAMPIONS_REWARD_KINDS as readonly unknown[]).includes(x.rewardKind) || !isInt(x.milestoneCount, 1, 500)) drift();
  }
  if (ms.nextMilestone !== null) {
    const n = record(ms.nextMilestone, drift); exactKeys(n, ['rewardKind','milestoneCount','remaining'], drift);
    if (!(CHAMPIONS_REWARD_KINDS as readonly unknown[]).includes(n.rewardKind) || !isInt(n.milestoneCount, 1, 500) || !isInt(n.remaining, 1, 500)) drift();
  }
  for (const item of r.history as unknown[]) {
    const h = record(item, drift);
    exactKeys(h, hq ? ['occurredAt','fromState','toState','reason','attributionId','referredOrganizationId','referredOrganizationName'] : ['occurredAt','fromState','toState','reason'], drift);
    if (!isTimestamp(h.occurredAt) || (h.fromState !== null && !(CHAMPIONS_ATTRIBUTION_STATES as readonly unknown[]).includes(h.fromState))
      || !(CHAMPIONS_ATTRIBUTION_STATES as readonly unknown[]).includes(h.toState) || !(CHAMPIONS_STATE_REASONS as readonly unknown[]).includes(h.reason)) drift();
    if (hq && (!isUuid(h.attributionId) || !isUuid(h.referredOrganizationId) || !isName(h.referredOrganizationName))) drift();
  }
}
export function validateChampionsSchoolStatistics(value: unknown): ChampionsSchoolStatistics {
  const r = record(value, drift);
  exactKeys(r, ['schoolId','referrals','monthlyQualified','milestones','allTimeRank','history','historyLimit','displayMode'], drift);
  checkStatistics(r, false);
  return r as unknown as ChampionsSchoolStatistics;
}
export function validateChampionsHqSchoolStatistics(value: unknown): ChampionsHqSchoolStatistics {
  const r = record(value, drift);
  exactKeys(r, ['schoolId','referrals','monthlyQualified','milestones','allTimeRank','history','historyLimit','displayMode','schoolName','organizationId','hold'], drift);
  checkStatistics(r, true);
  if (!isName(r.schoolName) || !isUuid(r.organizationId)) drift();
  if (r.hold !== null) { const h = record(r.hold, drift); exactKeys(h, ['reasonCode','placedAt'], drift); if (!HOLD_REASONS.includes(h.reasonCode as string) || !isTimestamp(h.placedAt)) drift(); }
  return r as unknown as ChampionsHqSchoolStatistics;
}
export function validateChampionsHoldReceipt(value: unknown): ChampionsHoldReceipt {
  const r = record(value, drift); exactKeys(r, ['schoolId','status','reasonCode','placedAt','releasedAt','replayed'], drift);
  if (!isUuid(r.schoolId) || !['ACTIVE','RELEASED'].includes(r.status as string) || !HOLD_REASONS.includes(r.reasonCode as string) || !isTimestamp(r.placedAt)
    || !nullable(r.releasedAt, isTimestamp) || (r.status === 'RELEASED') !== (r.releasedAt !== null) || typeof r.replayed !== 'boolean') drift();
  return r as unknown as ChampionsHoldReceipt;
}
export function validateChampionsPreferenceReceipt(value: unknown): ChampionsPreferenceReceipt {
  const r = record(value, drift); exactKeys(r, ['schoolId','displayMode','version','updatedAt','replayed'], drift);
  if (!isUuid(r.schoolId) || !MODES.includes(r.displayMode as string) || !isInt(r.version, 1, 2147483647) || !isTimestamp(r.updatedAt) || typeof r.replayed !== 'boolean') drift();
  return r as unknown as ChampionsPreferenceReceipt;
}
