// WB1 AI website drafts (migration 0344) closed contracts. A draft is one request by staff of ONE school for 1..8 website
// pages, paid from that school's creative wallet (CW1, 0202) at the HQ-published WEBSITE rate (credits per page). It is
// never billed as an included AI-team conversation. School views carry no provider identity, model, provider cost or HQ
// notes. Credits are reserved before the provider call: SUCCEEDED charges only the pages returned, FAILED returns
// everything, UNDER_REVIEW holds the credits until the HQ owner resolves the outcome. A draft is text only and is never
// published by this slice. WB1 stores SYNTHETIC output from test providers only.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';
import {
  CREATIVE_GENERATION_FAILURE_REASONS, CREATIVE_GENERATION_STATUSES, CREATIVE_STUDIO_PROVIDER_STATES, isCreativePrompt,
  type CreativeGenerationFailureReason, type CreativeGenerationStatus, type CreativeStudioProviderState,
} from './creative-studio.js';
import { validateSaasCreativeBalance, type SaasCreativeBalance } from './saas-creative-wallet.js';

/** The fixed page list, in display order. A request names 1..8 distinct pages in this order. */
export const CREATIVE_WEBSITE_PAGES = ['HOME', 'PROGRAMS', 'SCHEDULE', 'FREE_TRIAL', 'INSTRUCTORS', 'ABOUT', 'FAQ', 'CONTACT'] as const;
export type CreativeWebsitePage = typeof CREATIVE_WEBSITE_PAGES[number];
/** Limits shared by the database (0344) and the API. */
export const CREATIVE_WEBSITE_LIMITS = {
  briefCharacters: 1000, maxPages: 8, maxSections: 12, titleCharacters: 120, headingCharacters: 120, bodyCharacters: 2000,
  listLimit: 50, maxInProgressPerSchool: 1, interruptedAfterSeconds: 120,
} as const;

export interface CreativeWebsiteDraftInput { operationCode: string; pages: CreativeWebsitePage[]; brief: string }
export interface CreativeWebsiteSection { heading: string; body: string }
export interface CreativeWebsitePageContent { pageKey: CreativeWebsitePage; title: string; sections: CreativeWebsiteSection[]; origin: 'SYNTHETIC' }
export interface CreativeWebsiteDraft {
  draftId: string; schoolId: string; operationCode: string; pages: CreativeWebsitePage[]; brief: string;
  status: CreativeGenerationStatus; failureReason: CreativeGenerationFailureReason | null; reservedCredits: number; chargedCredits: number | null;
  createdAt: string; completedAt: string | null;
  /** The page text: only on a single-draft read (or the record answer) of a SUCCEEDED draft; null otherwise. */
  content: CreativeWebsitePageContent[] | null;
}
export interface CreativeWebsiteDraftRecords { drafts: CreativeWebsiteDraft[]; limit: 50 }
export interface CreativeWebsiteDraftList extends CreativeWebsiteDraftRecords { provider: CreativeStudioProviderState }
export interface CreativeWebsiteDraftReceipt { draft: CreativeWebsiteDraft; balance: SaasCreativeBalance; replayed: boolean }

const OPERATION = /^[a-z][a-z0-9_.]{2,59}$/;
// Single-line text: no control or bidi-override characters. Body text may carry line breaks and tabs.
const LINE_UNSAFE = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;
const BODY_UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;
const has = (list: readonly unknown[], value: unknown) => list.includes(value);
const rank = (page: unknown) => (CREATIVE_WEBSITE_PAGES as readonly unknown[]).indexOf(page);

export function isCreativeWebsiteLine(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max && value.trim() === value && !LINE_UNSAFE.test(value);
}
export function isCreativeWebsiteBody(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= CREATIVE_WEBSITE_LIMITS.bodyCharacters
    && value.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '') === value && !BODY_UNSAFE.test(value);
}
/** 1..8 known pages, strictly in the list's order (so also distinct). */
export function isCreativeWebsitePageList(value: unknown): value is CreativeWebsitePage[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= CREATIVE_WEBSITE_LIMITS.maxPages
    && value.every((p, i) => rank(p) >= 0 && (i === 0 || rank(p) > rank(value[i - 1])));
}
/** One page's sections: 1..12 of exactly {heading, body}. Used for provider output (API) and for drift (reads). */
export function isCreativeWebsiteSections(value: unknown): value is CreativeWebsiteSection[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= CREATIVE_WEBSITE_LIMITS.maxSections
    && value.every(s => s !== null && typeof s === 'object' && !Array.isArray(s) && Object.keys(s).sort().join(',') === 'body,heading'
      && isCreativeWebsiteLine((s as CreativeWebsiteSection).heading, CREATIVE_WEBSITE_LIMITS.headingCharacters) && isCreativeWebsiteBody((s as CreativeWebsiteSection).body));
}

// ---------- input (closed: clients never choose a provider, model, price or school) ----------
export function validateCreativeWebsiteDraftInput(value: unknown): CreativeWebsiteDraftInput {
  const input = record(value, invalid); exactKeys(input, ['operationCode', 'pages', 'brief'], invalid);
  if (typeof input.operationCode !== 'string' || !OPERATION.test(input.operationCode) || !isCreativeWebsitePageList(input.pages) || !isCreativePrompt(input.brief)) invalid();
  return { operationCode: input.operationCode as string, pages: [...input.pages as CreativeWebsitePage[]], brief: input.brief as string };
}

// ---------- responses (closed; any drift fails) ----------
function validateContent(value: unknown, pages: CreativeWebsitePage[]): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > pages.length) drift();
  (value as unknown[]).forEach((item, i) => {
    const c = record(item, drift); exactKeys(c, ['pageKey', 'title', 'sections', 'origin'], drift);
    if (!pages.includes(c.pageKey as CreativeWebsitePage) || (i > 0 && rank(c.pageKey) <= rank((value as CreativeWebsitePageContent[])[i - 1]!.pageKey))
      || !isCreativeWebsiteLine(c.title, CREATIVE_WEBSITE_LIMITS.titleCharacters) || !isCreativeWebsiteSections(c.sections) || c.origin !== 'SYNTHETIC') drift();
  });
}
export function validateCreativeWebsiteDraft(value: unknown): CreativeWebsiteDraft {
  const d = record(value, drift);
  exactKeys(d, ['draftId', 'schoolId', 'operationCode', 'pages', 'brief', 'status', 'failureReason', 'reservedCredits', 'chargedCredits',
    'createdAt', 'completedAt', 'content'], drift);
  if (!isUuid(d.draftId) || !isUuid(d.schoolId) || typeof d.operationCode !== 'string' || !OPERATION.test(d.operationCode)
    || !isCreativeWebsitePageList(d.pages) || !isCreativePrompt(d.brief)
    || !has(CREATIVE_GENERATION_STATUSES, d.status) || !(d.failureReason === null || has(CREATIVE_GENERATION_FAILURE_REASONS, d.failureReason))
    || !isInt(d.reservedCredits, 1, 1_000_000_000) || !isTimestamp(d.createdAt) || !(d.completedAt === null || isTimestamp(d.completedAt))) drift();
  const charged = d.status === 'SUCCEEDED' || d.status === 'RESOLVED_CHARGED';
  if (charged ? !isInt(d.chargedCredits, 0, d.reservedCredits as number) : d.chargedCredits !== null) drift();
  if ((d.status === 'GENERATING') !== (d.completedAt === null)) drift();
  if ((d.status === 'SUCCEEDED' || d.status === 'GENERATING') && d.failureReason !== null) drift();
  if ((d.status === 'FAILED' || d.status === 'UNDER_REVIEW') && d.failureReason === null) drift();
  if (d.completedAt !== null && Date.parse(d.completedAt as string) < Date.parse(d.createdAt as string)) drift();
  if (d.content !== null) {
    if (d.status !== 'SUCCEEDED') drift();
    validateContent(d.content, d.pages as CreativeWebsitePage[]);
  }
  return d as unknown as CreativeWebsiteDraft;
}
function validateDraftArray(value: unknown): void {
  if (!Array.isArray(value) || value.length > CREATIVE_WEBSITE_LIMITS.listLimit) drift();
  const drafts = (value as unknown[]).map(validateCreativeWebsiteDraft);
  // The list never carries page text.
  if (drafts.some(d => d.content !== null)) drift();
  if (new Set(drafts.map(d => d.draftId)).size !== drafts.length || new Set(drafts.map(d => d.schoolId)).size > 1) drift();
  for (let i = 1; i < drafts.length; i++) if (Date.parse(drafts[i - 1]!.createdAt) < Date.parse(drafts[i]!.createdAt)) drift();
}
/** The database read (0344): one school's newest drafts, without page text. */
export function validateCreativeWebsiteDraftRecords(value: unknown): CreativeWebsiteDraftRecords {
  const r = record(value, drift); exactKeys(r, ['drafts', 'limit'], drift);
  if (r.limit !== CREATIVE_WEBSITE_LIMITS.listLimit) drift();
  validateDraftArray(r.drafts);
  return r as unknown as CreativeWebsiteDraftRecords;
}
/** The API list view: the records plus whether a website provider is connected (server runtime, never a client choice). */
export function validateCreativeWebsiteDraftList(value: unknown): CreativeWebsiteDraftList {
  const r = record(value, drift); exactKeys(r, ['provider', 'drafts', 'limit'], drift);
  if (!has(CREATIVE_STUDIO_PROVIDER_STATES, r.provider) || r.limit !== CREATIVE_WEBSITE_LIMITS.listLimit) drift();
  validateDraftArray(r.drafts);
  return r as unknown as CreativeWebsiteDraftList;
}
export function validateCreativeWebsiteDraftReceipt(value: unknown): CreativeWebsiteDraftReceipt {
  const r = record(value, drift); exactKeys(r, ['draft', 'balance', 'replayed'], drift);
  if (typeof r.replayed !== 'boolean') drift();
  validateCreativeWebsiteDraft(r.draft); validateSaasCreativeBalance(r.balance);
  return r as unknown as CreativeWebsiteDraftReceipt;
}
