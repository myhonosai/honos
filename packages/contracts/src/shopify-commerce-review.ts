import { MERCH_AI_REASONS, MERCH_AI_STATUSES, merchSafeText, type MerchAiReason, type MerchAiStatus } from './shopify-merch-ai.js';

/**
 * CA1 (0615): the commerce review. The owner picks what to look at and may add a question; Marcus answers with a short
 * summary, findings and recommendations on the shared AI text proposals (0550), from store totals only. A review is text:
 * it changes nothing in HON or Shopify and can only be marked reviewed or dismissed.
 */
export const COMMERCE_REVIEW_FOCUSES = ['OVERVIEW', 'SALES', 'PRICING', 'STOCK'] as const;
export type CommerceReviewFocus = typeof COMMERCE_REVIEW_FOCUSES[number];
export const COMMERCE_REVIEW_AREAS = ['SALES', 'PRICING', 'STOCK', 'PRODUCTS', 'FRONT_DESK'] as const;
export type CommerceReviewArea = typeof COMMERCE_REVIEW_AREAS[number];
export const COMMERCE_REVIEW_LIMITS = { inputTokens: 9000, outputTokens: 2500, maxProviderCostMicrounits: 80000, maxResultBytes: 12288, maxFindings: 5, maxRecommendations: 5 } as const;

export interface CommerceReviewBrief { focus: CommerceReviewFocus; question: string }
export interface CommerceReviewPoint { area: CommerceReviewArea; title: string; detail: string }
export interface CommerceReviewProposal { summary: string; findings: CommerceReviewPoint[]; recommendations: CommerceReviewPoint[] }
export interface CommerceReviewView {
  id: string; status: MerchAiStatus; reason: MerchAiReason | null; brief: CommerceReviewBrief; mine: boolean;
  summary: string | null; findings: CommerceReviewPoint[] | null; recommendations: CommerceReviewPoint[] | null;
  problems: string[]; createdAt: string; updatedAt: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINKISH = /(https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;
const bytes = (v: unknown) => { const s = JSON.stringify(v); let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3; } return n; };
const fail = (what: string): never => { throw new Error(`Invalid commerce review ${what}.`); };

/** The brief, exactly as the database takes it (0615 hon.shopify_review_brief_ok). */
export function validateCommerceReviewBrief(value: unknown): CommerceReviewBrief {
  if (!isObject(value) || !exactKeys(value, ['focus', 'question'])) return fail('brief');
  const { focus, question } = value;
  if (typeof focus !== 'string' || !(COMMERCE_REVIEW_FOCUSES as readonly string[]).includes(focus)) return fail('brief');
  if (typeof question !== 'string' || (question !== '' && (question !== question.trim() || !merchSafeText(question, 300)))) return fail('brief');
  return { focus: focus as CommerceReviewFocus, question };
}

function point(v: unknown): CommerceReviewPoint {
  if (!isObject(v) || !exactKeys(v, ['area', 'title', 'detail'])) return fail('answer');
  const { area, title, detail } = v;
  if (typeof area !== 'string' || !(COMMERCE_REVIEW_AREAS as readonly string[]).includes(area) || !merchSafeText(title, 100) || !merchSafeText(detail, 500)) return fail('answer');
  return { area: area as CommerceReviewArea, title, detail };
}
/** The closed shape the database stores (0615 hon.shopify_review_ok). */
export function validateCommerceReviewProposal(value: unknown): CommerceReviewProposal {
  if (!isObject(value) || !exactKeys(value, ['summary', 'findings', 'recommendations']) || !merchSafeText(value.summary, 500)) return fail('answer');
  if (!Array.isArray(value.findings) || value.findings.length < 1 || value.findings.length > COMMERCE_REVIEW_LIMITS.maxFindings
    || !Array.isArray(value.recommendations) || value.recommendations.length > COMMERCE_REVIEW_LIMITS.maxRecommendations) return fail('answer');
  const findings = value.findings.map(point), recommendations = value.recommendations.map(point);
  if (bytes(value) > COMMERCE_REVIEW_LIMITS.maxResultBytes) return fail('answer');
  return { summary: value.summary as string, findings, recommendations };
}
/** What makes an answer unusable, in plain words (stored with a rejected answer): a review never carries links or addresses. */
export function commerceReviewProblems(p: CommerceReviewProposal): string[] {
  const out: string[] = [];
  const texts = [p.summary, ...[...p.findings, ...p.recommendations].flatMap(x => [x.title, x.detail])];
  if (texts.some(t => LINKISH.test(t))) out.push('The answer holds a link or an email address.');
  return out;
}

export function verifyCommerceReviewView(value: unknown): CommerceReviewView {
  if (!isObject(value) || !exactKeys(value, ['id', 'status', 'reason', 'brief', 'mine', 'summary', 'findings', 'recommendations', 'problems', 'createdAt', 'updatedAt'])) return fail('view');
  const v = value;
  if (typeof v.id !== 'string' || !UUID.test(v.id) || typeof v.status !== 'string' || !(MERCH_AI_STATUSES as readonly string[]).includes(v.status)
    || !(v.reason === null || (typeof v.reason === 'string' && (MERCH_AI_REASONS as readonly string[]).includes(v.reason))) || typeof v.mine !== 'boolean'
    || typeof v.createdAt !== 'string' || !ISO.test(v.createdAt) || typeof v.updatedAt !== 'string' || !ISO.test(v.updatedAt)
    || !Array.isArray(v.problems) || v.problems.some(x => typeof x !== 'string' || x.length < 1 || x.length > 160)) return fail('view');
  const brief = validateCommerceReviewBrief(v.brief);
  const open = v.status === 'RESULT_RECORDED' || v.status === 'APPLIED';
  let summary: string | null = null, findings: CommerceReviewPoint[] | null = null, recommendations: CommerceReviewPoint[] | null = null;
  if (open) { const p = validateCommerceReviewProposal({ summary: v.summary, findings: v.findings, recommendations: v.recommendations }); ({ summary, findings, recommendations } = p); }
  else if (v.summary !== null || v.findings !== null || v.recommendations !== null) return fail('view');
  return { id: v.id, status: v.status as MerchAiStatus, reason: v.reason as MerchAiReason | null, brief, mine: v.mine, summary, findings, recommendations,
    problems: v.problems as string[], createdAt: v.createdAt, updatedAt: v.updatedAt };
}
export function verifyCommerceReviewList(value: unknown): CommerceReviewView[] {
  if (!Array.isArray(value) || value.length > 10) return fail('list');
  return value.map(verifyCommerceReviewView);
}
