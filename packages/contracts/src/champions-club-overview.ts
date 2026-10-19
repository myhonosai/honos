// HON Champions Club Milestone 5: one HQ overview read for the Growth & Referrals landing page.
// Aggregates only. Every amount is a recorded liability; nothing is issued or fulfilled.
import { championsDrift as drift, championsExactKeys as exactKeys, championsIsInt as isInt, championsRecord as record } from './champions-club.js';

export interface ChampionsOverview {
  program: { status: 'POLICY_UNDECIDED' | 'PUBLISHED'; policyVersion: number | null; paymentVerificationSource: 'UNDECIDED' | 'HON_BILLING' | 'HQ_OWNER_ATTESTATION' | null };
  rewardProgram: { status: 'POLICY_UNDECIDED' | 'PUBLISHED'; policyVersion: number | null; clawbackRule: 'UNDECIDED' | 'VOID_UNFULFILLED' | 'RETAIN_EARNED' | null };
  referralCodes: { active: number; schoolsWithCode: number };
  attributions: { pending: number; qualified: number; rejected: number; refunded: number; reversed: number };
  rankedSchools: number; leaderboardHolds: number;
  rewardLiabilities: { entries: number; creditMinor: number; freeMonths: number; prizes: number; lifetimeMemberships: number; inReview: number; approved: number };
  contests: { draft: number; scheduled: number; active: number; paused: number; ended: number; pendingWinnerApproval: number; completed: number; cancelled: number; startDue: number; endDue: number };
  contestLiabilities: { pendingWinnerCostMinor: number; approvedWinnerCostMinor: number };
  currency: 'USD'; financialActivation: 'DISABLED'; automaticTransitions: 'NOT_CONFIGURED';
}
const count = (v: unknown): v is number => isInt(v, 0, Number.MAX_SAFE_INTEGER);
function counts(value: unknown, keys: string[]): void {
  const r = record(value, drift); exactKeys(r, keys, drift);
  if (Object.values(r).some(v => !count(v))) drift();
}
export function validateChampionsOverview(value: unknown): ChampionsOverview {
  const r = record(value, drift);
  exactKeys(r, ['program','rewardProgram','referralCodes','attributions','rankedSchools','leaderboardHolds','rewardLiabilities','contests','contestLiabilities',
    'currency','financialActivation','automaticTransitions'], drift);
  for (const [key, field, allowed] of [['program','paymentVerificationSource',['UNDECIDED','HON_BILLING','HQ_OWNER_ATTESTATION']],['rewardProgram','clawbackRule',['UNDECIDED','VOID_UNFULFILLED','RETAIN_EARNED']]] as const) {
    const p = record(r[key], drift); exactKeys(p, ['status','policyVersion',field], drift);
    const published = p.status === 'PUBLISHED';
    if (!(published || p.status === 'POLICY_UNDECIDED') || (published ? !isInt(p.policyVersion, 1, 2147483647) || !(allowed as readonly unknown[]).includes(p[field])
      : p.policyVersion !== null || p[field] !== null)) drift();
  }
  counts(r.referralCodes, ['active','schoolsWithCode']);
  counts(r.attributions, ['pending','qualified','rejected','refunded','reversed']);
  counts(r.rewardLiabilities, ['entries','creditMinor','freeMonths','prizes','lifetimeMemberships','inReview','approved']);
  counts(r.contests, ['draft','scheduled','active','paused','ended','pendingWinnerApproval','completed','cancelled','startDue','endDue']);
  counts(r.contestLiabilities, ['pendingWinnerCostMinor','approvedWinnerCostMinor']);
  if (!count(r.rankedSchools) || !count(r.leaderboardHolds) || r.currency !== 'USD' || r.financialActivation !== 'DISABLED' || r.automaticTransitions !== 'NOT_CONFIGURED') drift();
  return r as unknown as ChampionsOverview;
}
