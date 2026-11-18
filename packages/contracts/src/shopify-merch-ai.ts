/**
 * CS-M2 (0510): Merch Studio AI ideas. The owner gives a brief (one product kind, one to three looks, optional colors and
 * notes); Marcus answers with up to three product ideas on the shared AI text proposals (0507). An idea is text only: using
 * one opens the SH4a draft form, and Shopify is changed only by an approved SH4a change.
 */
export const MERCH_AI_KINDS = ['TSHIRT', 'HOODIE', 'RASHGUARD', 'HAT', 'BAG', 'BOTTLE', 'STICKER', 'PATCH'] as const;
export type MerchAiKind = typeof MERCH_AI_KINDS[number];
export const MERCH_AI_STYLES = ['MINIMAL', 'ATHLETIC', 'STREETWEAR', 'CLASSIC', 'PREMIUM'] as const;
export type MerchAiStyle = typeof MERCH_AI_STYLES[number];
export const MERCH_AI_LIMITS = { inputTokens: 6000, outputTokens: 3000, maxProviderCostMicrounits: 80000, maxResultBytes: 12288, maxIdeas: 3 } as const;
export const MERCH_AI_STATUSES = ['PENDING', 'CONFIGURATION_REQUIRED', 'BLOCKED', 'SENDING', 'UNKNOWN', 'FAILED', 'RESULT_RECORDED', 'RESULT_REJECTED', 'APPLIED', 'DISMISSED'] as const;
export type MerchAiStatus = typeof MERCH_AI_STATUSES[number];
export const MERCH_AI_REASONS = ['CONFIGURATION_REQUIRED', 'NO_ELIGIBLE_ROUTE', 'CUSTOMER_BUDGET_EXCEEDED', 'AI_SPEND_STOPPED', 'UNSUPPORTED_PROVIDER',
  'INVALID_REQUEST', 'PROVIDER_REJECTED', 'PROVIDER_UNKNOWN', 'ROUTE_STALE', 'RESULT_BUDGET_EXCEEDED', 'RESULT_INVALID', 'SUBJECT_STALE', 'GATE_CLOSED'] as const;
export type MerchAiReason = typeof MERCH_AI_REASONS[number];

export interface MerchAiBrief { kind: MerchAiKind; styles: MerchAiStyle[]; colors: string[]; notes: string }
export interface MerchAiIdea { style: MerchAiStyle; title: string; description: string; productType: string; price: string | null; printNotes: string }
export interface MerchAiProposal { summary: string; ideas: MerchAiIdea[] }
export interface MerchAiView {
  id: string; status: MerchAiStatus; reason: MerchAiReason | null; brief: MerchAiBrief; mine: boolean;
  summary: string | null; ideas: MerchAiIdea[] | null; problems: string[]; createdAt: string; updatedAt: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).sort().join(',') === [...keys].sort().join(',');
// The same refusal as hon.marketing_safe_text (0089): no control characters (line breaks allowed), nothing credential-like.
const CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SECRETISH = /(-----BEGIN|Bearer\s+|\bsk[-_][A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.eyJ|(?:api[ _-]?key|password|secret|authorization)\s*[:=])/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A whole-number or two-decimal price below one million, as Shopify takes it. */
export const MERCH_AI_PRICE = /^(0|[1-9][0-9]{0,5})(\.[0-9]{2})?$/;
export function merchSafeText(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= max && v.length <= max + 50 && !CONTROL.test(v) && !SECRETISH.test(v);
}
const bytes = (v: unknown) => { const s = JSON.stringify(v); let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3; } return n; };
const fail = (what: string): never => { throw new Error(`Invalid merch ideas ${what}.`); };

/** The brief, exactly as the database takes it (0510 hon.shopify_merch_brief_ok). Colors are trimmed and de-duplicated by the client. */
export function validateMerchAiBrief(value: unknown): MerchAiBrief {
  if (!isObject(value) || !exactKeys(value, ['kind', 'styles', 'colors', 'notes'])) return fail('brief');
  const { kind, styles, colors, notes } = value;
  if (typeof kind !== 'string' || !(MERCH_AI_KINDS as readonly string[]).includes(kind)) return fail('brief');
  if (!Array.isArray(styles) || styles.length < 1 || styles.length > 3 || new Set(styles).size !== styles.length
    || styles.some(s => typeof s !== 'string' || !(MERCH_AI_STYLES as readonly string[]).includes(s))) return fail('brief');
  if (!Array.isArray(colors) || colors.length > 10 || new Set(colors.map(c => String(c).toLowerCase())).size !== colors.length
    || colors.some(c => !merchSafeText(c, 40) || c !== c.trim())) return fail('brief');
  if (typeof notes !== 'string' || (notes !== '' && (notes !== notes.trim() || !merchSafeText(notes, 500)))) return fail('brief');
  return { kind: kind as MerchAiKind, styles: styles as MerchAiStyle[], colors: colors as string[], notes };
}

function idea(v: unknown): MerchAiIdea {
  if (!isObject(v) || !exactKeys(v, ['style', 'title', 'description', 'productType', 'price', 'printNotes'])) return fail('answer');
  const { style, title, description, productType, price, printNotes } = v;
  if (typeof style !== 'string' || !(MERCH_AI_STYLES as readonly string[]).includes(style) || !merchSafeText(title, 120) || !merchSafeText(description, 1200)
    || !merchSafeText(productType, 60) || !merchSafeText(printNotes, 300) || !(price === null || (typeof price === 'string' && MERCH_AI_PRICE.test(price)))) return fail('answer');
  return { style: style as MerchAiStyle, title, description, productType, price: price as string | null, printNotes };
}
/** The closed shape the database stores (0510 hon.shopify_merch_ideas_ok). */
export function validateMerchAiProposal(value: unknown): MerchAiProposal {
  if (!isObject(value) || !exactKeys(value, ['summary', 'ideas']) || !merchSafeText(value.summary, 300)) return fail('answer');
  if (!Array.isArray(value.ideas) || value.ideas.length < 1 || value.ideas.length > MERCH_AI_LIMITS.maxIdeas) return fail('answer');
  const ideas = value.ideas.map(idea);
  if (bytes(value) > MERCH_AI_LIMITS.maxResultBytes) return fail('answer');
  return { summary: value.summary as string, ideas };
}
/**
 * What does not fit the owner's brief, in plain words (stored with a rejected answer). One idea per requested look, no
 * look twice, and a price only in a US dollar store: HON never converts or guesses another currency.
 */
export function merchAiProblems(p: MerchAiProposal, brief: MerchAiBrief, currency: string | null): string[] {
  const out: string[] = [];
  p.ideas.forEach((i, n) => {
    if (!brief.styles.includes(i.style)) out.push(`Idea ${n + 1} uses a look that was not asked for.`);
    if (i.price !== null && currency !== 'USD') out.push(`Idea ${n + 1} has a price, but the store does not use US dollars.`);
  });
  if (new Set(p.ideas.map(i => i.style)).size !== p.ideas.length) out.push('Two ideas use the same look.');
  if (p.ideas.length !== brief.styles.length) out.push(`The answer has ${p.ideas.length} ideas for ${brief.styles.length} looks.`);
  return out;
}

export function verifyMerchAiView(value: unknown): MerchAiView {
  if (!isObject(value) || !exactKeys(value, ['id', 'status', 'reason', 'brief', 'mine', 'summary', 'ideas', 'problems', 'createdAt', 'updatedAt'])) return fail('view');
  const v = value;
  if (typeof v.id !== 'string' || !UUID.test(v.id) || typeof v.status !== 'string' || !(MERCH_AI_STATUSES as readonly string[]).includes(v.status)
    || !(v.reason === null || (typeof v.reason === 'string' && (MERCH_AI_REASONS as readonly string[]).includes(v.reason))) || typeof v.mine !== 'boolean'
    || typeof v.createdAt !== 'string' || !ISO.test(v.createdAt) || typeof v.updatedAt !== 'string' || !ISO.test(v.updatedAt)
    || !Array.isArray(v.problems) || v.problems.some(x => typeof x !== 'string' || x.length < 1 || x.length > 160)) return fail('view');
  const brief = validateMerchAiBrief(v.brief);
  const open = v.status === 'RESULT_RECORDED' || v.status === 'APPLIED';
  let summary: string | null = null, ideas: MerchAiIdea[] | null = null;
  if (open) { const p = validateMerchAiProposal({ summary: v.summary, ideas: v.ideas }); summary = p.summary; ideas = p.ideas; }
  else if (v.summary !== null || v.ideas !== null) return fail('view');
  return { id: v.id, status: v.status as MerchAiStatus, reason: v.reason as MerchAiReason | null, brief, mine: v.mine, summary, ideas,
    problems: v.problems as string[], createdAt: v.createdAt, updatedAt: v.updatedAt };
}
export function verifyMerchAiList(value: unknown): MerchAiView[] {
  if (!Array.isArray(value) || value.length > 20) return fail('list');
  return value.map(verifyMerchAiView);
}
