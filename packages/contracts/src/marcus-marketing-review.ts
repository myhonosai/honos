import { MERCH_AI_REASONS, MERCH_AI_STATUSES, type MerchAiReason, type MerchAiStatus } from './shopify-merch-ai.js';
import { alexPlanLine } from './alex-delegation.js';

/**
 * P3 (0641): Marcus marketing performance review. A marketing staff member asks Marcus to read the school's own marketing
 * numbers for the last 30 or 90 days (leads by source and campaign, won and registered, campaigns and lead forms), with an
 * optional question. Marcus answers with a summary, findings and next steps on the shared AI text proposals (0550). Text only:
 * nothing is created, sent, published or spent. Spec: docs/architecture/MARCUS_MARKETING_REVIEW.md.
 */
export const MARCUS_REVIEW_PERIODS = ['LAST_30_DAYS', 'LAST_90_DAYS'] as const;
export type MarcusReviewPeriod = typeof MARCUS_REVIEW_PERIODS[number];
export const MARCUS_REVIEW_AREAS = ['marcus', 'chad', 'lena'] as const;
export type MarcusReviewArea = typeof MARCUS_REVIEW_AREAS[number];
export const MARCUS_REVIEW_LIMITS = { inputTokens: 12000, outputTokens: 3000, maxProviderCostMicrounits: 80000, maxResultBytes: 12288, maxFindings: 6, maxNextSteps: 5 } as const;

export interface MarcusReviewBrief { period: MarcusReviewPeriod; question: string }
export interface MarcusReviewFinding { title: string; detail: string }
export interface MarcusReviewNextStep { title: string; detail: string; area: MarcusReviewArea | null }
export interface MarcusReviewProposal { summary: string; findings: MarcusReviewFinding[]; nextSteps: MarcusReviewNextStep[] }
export interface MarcusReviewView {
  id: string; status: MerchAiStatus; reason: MerchAiReason | null; brief: MarcusReviewBrief;
  summary: string | null; findings: MarcusReviewFinding[] | null; nextSteps: MarcusReviewNextStep[] | null;
  problems: string[]; createdAt: string; updatedAt: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINKISH = /(https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;
const bytes = (v: unknown) => { const s = JSON.stringify(v); let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3; } return n; };
const fail = (what: string): never => { throw new Error(`Invalid Marcus review ${what}.`); };

/** The brief, exactly as the database takes it (0641 hon.marcus_review_brief_ok). An empty question is allowed. */
export function validateMarcusReviewBrief(value: unknown): MarcusReviewBrief {
  if (!isObject(value) || !exactKeys(value, ['period', 'question'])) return fail('brief');
  const { period, question } = value;
  if (typeof period !== 'string' || !(MARCUS_REVIEW_PERIODS as readonly string[]).includes(period) || typeof question !== 'string' || (question !== '' && !alexPlanLine(question, 300))) return fail('brief');
  return { period: period as MarcusReviewPeriod, question };
}

function finding(v: unknown): MarcusReviewFinding {
  if (!isObject(v) || !exactKeys(v, ['title', 'detail']) || !alexPlanLine(v.title, 120) || !alexPlanLine(v.detail, 400)) return fail('answer');
  return { title: v.title, detail: v.detail };
}
function nextStep(v: unknown): MarcusReviewNextStep {
  if (!isObject(v) || !exactKeys(v, ['title', 'detail', 'area']) || !alexPlanLine(v.title, 120) || !alexPlanLine(v.detail, 400)
    || !(v.area === null || (typeof v.area === 'string' && (MARCUS_REVIEW_AREAS as readonly string[]).includes(v.area)))) return fail('answer');
  return { title: v.title, detail: v.detail, area: v.area as MarcusReviewArea | null };
}
/** The closed shape the database stores (0641 hon.marcus_review_ok). */
export function validateMarcusReviewProposal(value: unknown): MarcusReviewProposal {
  if (!isObject(value) || !exactKeys(value, ['summary', 'findings', 'nextSteps']) || !alexPlanLine(value.summary, 400)) return fail('answer');
  const { findings, nextSteps } = value;
  if (!Array.isArray(findings) || findings.length < 1 || findings.length > MARCUS_REVIEW_LIMITS.maxFindings) return fail('answer');
  if (!Array.isArray(nextSteps) || nextSteps.length < 1 || nextSteps.length > MARCUS_REVIEW_LIMITS.maxNextSteps) return fail('answer');
  if (bytes(value) > MARCUS_REVIEW_LIMITS.maxResultBytes) return fail('answer');
  return { summary: value.summary as string, findings: findings.map(finding), nextSteps: nextSteps.map(nextStep) };
}
/** What makes an answer unusable, in plain words (stored with a rejected answer). */
export function marcusReviewProblems(p: MarcusReviewProposal): string[] {
  const texts = [p.summary, ...p.findings.flatMap(f => [f.title, f.detail]), ...p.nextSteps.flatMap(s => [s.title, s.detail])];
  return texts.some(t => LINKISH.test(t)) ? ['The answer holds a link or an email address.'] : [];
}

export function verifyMarcusReviewView(value: unknown): MarcusReviewView {
  if (!isObject(value) || !exactKeys(value, ['id', 'status', 'reason', 'brief', 'summary', 'findings', 'nextSteps', 'problems', 'createdAt', 'updatedAt'])) return fail('view');
  const v = value;
  if (typeof v.id !== 'string' || !UUID.test(v.id) || typeof v.status !== 'string' || !(MERCH_AI_STATUSES as readonly string[]).includes(v.status)
    || !(v.reason === null || (typeof v.reason === 'string' && (MERCH_AI_REASONS as readonly string[]).includes(v.reason)))
    || typeof v.createdAt !== 'string' || !ISO.test(v.createdAt) || typeof v.updatedAt !== 'string' || !ISO.test(v.updatedAt)
    || !Array.isArray(v.problems) || v.problems.some(x => typeof x !== 'string' || x.length < 1 || x.length > 160)) return fail('view');
  const brief = validateMarcusReviewBrief(v.brief);
  let summary: string | null = null, findings: MarcusReviewFinding[] | null = null, nextSteps: MarcusReviewNextStep[] | null = null;
  if (v.status === 'RESULT_RECORDED') ({ summary, findings, nextSteps } = validateMarcusReviewProposal({ summary: v.summary, findings: v.findings, nextSteps: v.nextSteps }));
  else if (v.summary !== null || v.findings !== null || v.nextSteps !== null) return fail('view');
  return { id: v.id, status: v.status as MerchAiStatus, reason: v.reason as MerchAiReason | null, brief, summary, findings, nextSteps,
    problems: v.problems as string[], createdAt: v.createdAt, updatedAt: v.updatedAt };
}
export function verifyMarcusReviewList(value: unknown): MarcusReviewView[] {
  if (!Array.isArray(value) || value.length > 20) return fail('list');
  return value.map(verifyMarcusReviewView);
}
