export const A2P_ENGINE_VERSION = 'A2P_PREPARATION_V1' as const;
export const A2P_PERMISSION = 'communication.a2p.prepare' as const;
export const A2P_STATUSES = ['PASS', 'NEEDS_FIX', 'REVIEW_REQUIRED', 'UNAVAILABLE'] as const;
export type A2pStatus = typeof A2P_STATUSES[number];
export const A2P_FINDING_CODES = ['BUSINESS_IDENTITY', 'PRIVACY_PUBLIC', 'TERMS_PUBLIC', 'SMS_DATA_SHARING',
  'OPT_IN_PUBLIC', 'CONSENT_OPTIONAL_UNCHECKED', 'CONSENT_SEPARATION', 'FREQUENCY', 'RATES', 'STOP', 'HELP',
  'POLICY_LINKS_NEAR_FORM', 'FLOW_CONSISTENCY'] as const;
export type A2pFindingCode = typeof A2P_FINDING_CODES[number];
export const A2P_TEMPLATES = ['TRIAL_CONFIRMATION', 'TRIAL_REMINDER', 'ENROLLMENT_FOLLOW_UP', 'CLASS_CHANGE',
  'SCHOOL_CLOSURE', 'TUITION_NOTIFICATION', 'PROMOTIONAL'] as const;
export type A2pTemplate = typeof A2P_TEMPLATES[number];
export const A2P_PURPOSES = ['SERVICE_NOTIFICATIONS', 'MARKETING', 'MIXED'] as const;
export const A2P_FACT_CONFIRMATION = 'OWNER_CONFIRMED_FACTS_FOR_DRAFT_ONLY' as const;
export const A2P_COPY_CONFIRMATION = 'COPY_DRAFT_FOR_EXTERNAL_OWNER_REVIEW' as const;
export interface A2pSchoolScope { readonly organizationId: string; readonly schoolId: string; readonly schoolName: string; readonly canConfirmOwnerFacts: boolean }
export interface A2pWebsiteReviewInput {
  readonly websiteUrl: string;
  readonly businessName: string | null;
  readonly privacyUrl: string | null;
  readonly termsUrl: string | null;
  readonly optInUrl: string | null;
  readonly messageFlow: string | null;
}
export interface A2pDraftFacts {
  readonly businessName: string | null;
  readonly websiteUrl: string | null;
  readonly privacyUrl: string | null;
  readonly termsUrl: string | null;
  readonly optInUrl: string | null;
  readonly supportContact: string | null;
  readonly messageFlow: string | null;
  readonly messageFrequency: string | null;
}
export interface A2pDraftInput {
  readonly facts: A2pDraftFacts;
  readonly purpose: typeof A2P_PURPOSES[number];
  readonly templates: readonly A2pTemplate[];
  readonly marketingConsent: 'SEPARATE_CONFIRMED' | 'NOT_CONFIRMED' | 'NOT_APPLICABLE';
  readonly ownerConfirmation: typeof A2P_FACT_CONFIRMATION | 'NOT_CONFIRMED';
}
export interface A2pSource { readonly id: string; readonly url: string; readonly reviewedOn: '2026-10-25' }
export interface A2pEvidence {
  readonly id: string; readonly url: string; readonly provenance: 'SYNTHETIC_FIXTURE';
  readonly observedAt: string; readonly excerpt: string;
}
export interface A2pFinding {
  readonly code: A2pFindingCode; readonly status: A2pStatus; readonly reason: string;
  readonly remediation: string; readonly sourceIds: readonly string[]; readonly evidence: readonly A2pEvidence[];
}
export interface A2pWebsiteReview {
  readonly engineVersion: typeof A2P_ENGINE_VERSION;
  readonly inspection: 'LIVE_INSPECTION_DISABLED' | 'SYNTHETIC_FIXTURE';
  readonly overallStatus: A2pStatus;
  readonly findings: readonly A2pFinding[];
  readonly sources: readonly A2pSource[];
  readonly carrierApproval: 'NOT_REQUESTED';
  readonly legalCompliance: 'NOT_DETERMINED';
}
export interface A2pDraft {
  readonly engineVersion: typeof A2P_ENGINE_VERSION;
  readonly language: 'en'; readonly state: 'NEEDS_INPUT' | 'DRAFT_FOR_OWNER_REVIEW';
  readonly missingFields: readonly string[]; readonly warnings: readonly string[];
  readonly answers: null | { readonly campaignUseCase: string; readonly campaignDescription: string; readonly messageFlow: string;
    readonly websiteUrl: string; readonly privacyPolicyUrl: string; readonly termsAndConditionsUrl: string; readonly optInUrl: string };
  readonly sampleMessages: readonly { readonly template: A2pTemplate; readonly content: string }[];
  readonly helpResponseSample: string | null; readonly stopResponseSample: string | null;
  readonly copyPreparationAvailable: boolean;
  readonly factsProvenance: 'OWNER_STATEMENTS_NOT_INDEPENDENTLY_VERIFIED';
  readonly consentRecorded: false; readonly saved: false; readonly submitted: false; readonly messagesSent: 0;
}
export interface A2pReadResponse { readonly scope: A2pSchoolScope; readonly readOnly: true; readonly persistence: 'NONE' }
export interface A2pWebsiteResponse extends A2pReadResponse { readonly review: A2pWebsiteReview; readonly computationDigest: string }
export interface A2pFindingResponse extends A2pReadResponse { readonly finding: A2pFinding; readonly sources: readonly A2pSource[] }
export interface A2pDraftResponse extends A2pReadResponse { readonly draft: A2pDraft; readonly computationDigest: string }
export interface A2pValidationResponse extends A2pDraftResponse {
  readonly validation: { readonly readyForCopyPreparation: boolean; readonly missingFields: readonly string[];
    readonly warnings: readonly string[]; readonly providerEligibility: 'NOT_VERIFIED'; readonly approval: 'NOT_REQUESTED' };
}
export interface A2pCopyResponse extends A2pReadResponse { readonly computationDigest: string; readonly format: 'TEXT';
  readonly filename: 'hon-a2p-draft.txt'; readonly content: string; readonly submitted: false; readonly messagesSent: 0 }
/** Future governed HON explanation input, not a registered executable AI tool or provider authorization. */
export interface A2pHonExplanationContext { readonly engineVersion: typeof A2P_ENGINE_VERSION;
  readonly finding: A2pFinding; readonly sources: readonly A2pSource[]; readonly actionAuthority: 'NONE'; readonly providerExecutionAvailable: false }
function invalid(code = 'INVALID_A2P_INPUT'): never { throw new Error(code); }
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length
    || keys.some(k => !Object.hasOwn(value, k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k)!, 'value'))) return invalid();
  return value as Record<string, unknown>;
}
export function a2pText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > maximum
    || /[\x00-\x1f\x7f-\x9f<>\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(value)
    || /-----BEGIN|\bBearer\s+|\b(?:sk_|zrk_)[a-zA-Z0-9]{20,}|\b(?:api[ _-]?key|password|secret|authorization)\s*[:=]/i.test(value)) return invalid();
  return value;
}
/** Lexical selector check ONLY, not a DNS/ownership verification or permission to fetch. */
export function a2pPublicHttpsUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\//.test(value)
    || /[\x00-\x20\x7f-\uffff\\%?#]/.test(value)) return invalid('A2P_URL_NOT_ALLOWED');
  const match = /^https:\/\/([^/]+)(\/[A-Za-z0-9/._~!$&'()*+,;=:@-]*)?$/.exec(value);
  if (!match) return invalid('A2P_URL_NOT_ALLOWED');
  const host = match[1]!.toLowerCase(), path = match[2] || '/';
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
    || host.length>253 || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|home|lan|arpa)$/.test(host)
    || /\/(?:\.|\.\.)(?:\/|$)/.test(path)) return invalid('A2P_URL_NOT_ALLOWED');
  return 'https://'+host+path;
}
const optional = (value: unknown, maximum: number) => value === null ? null : a2pText(value, maximum);
const optionalUrl = (value: unknown) => value === null ? null : a2pPublicHttpsUrl(value);
function optionalContact(value: unknown): string | null {
  if(value===null)return null;
  const v=a2pText(value,160);
  if(v.startsWith('https://'))return a2pPublicHttpsUrl(v);
  if(/^\+[1-9][0-9]{7,14}$/.test(v))return v;
  const email=/^[A-Za-z0-9.!#$&'*+/=?^_`{|}~-]+@([A-Za-z0-9.-]+)$/.exec(v);
  if(email){a2pPublicHttpsUrl('https://'+email[1]);return v;}
  return invalid();
}
export function validateA2pWebsiteReview(value: unknown): A2pWebsiteReviewInput {
  const v = closed(value, ['websiteUrl', 'businessName', 'privacyUrl', 'termsUrl', 'optInUrl', 'messageFlow']);
  return Object.freeze({ websiteUrl: a2pPublicHttpsUrl(v.websiteUrl), businessName: optional(v.businessName, 120),
    privacyUrl: optionalUrl(v.privacyUrl), termsUrl: optionalUrl(v.termsUrl), optInUrl: optionalUrl(v.optInUrl), messageFlow: optional(v.messageFlow, 2048) });
}
export function validateA2pDraftInput(value: unknown): A2pDraftInput {
  const v = closed(value, ['facts', 'purpose', 'templates', 'marketingConsent', 'ownerConfirmation']);
  const f = closed(v.facts, ['businessName', 'websiteUrl', 'privacyUrl', 'termsUrl', 'optInUrl', 'supportContact', 'messageFlow', 'messageFrequency']);
  if (!A2P_PURPOSES.includes(v.purpose as A2pDraftInput['purpose']) || !Array.isArray(v.templates)
    || v.templates.length < 1 || v.templates.length > 5 || new Set(v.templates).size !== v.templates.length
    || !['SEPARATE_CONFIRMED', 'NOT_CONFIRMED', 'NOT_APPLICABLE'].includes(v.marketingConsent as string)
    || ![A2P_FACT_CONFIRMATION, 'NOT_CONFIRMED'].includes(v.ownerConfirmation as string)) return invalid();
  const templates: A2pTemplate[] = [];
  for (const t of v.templates) { if (!A2P_TEMPLATES.includes(t as A2pTemplate)) return invalid(); templates.push(t as A2pTemplate); }
  const promotional = templates.includes('PROMOTIONAL');
  if (v.purpose === 'SERVICE_NOTIFICATIONS' && promotional || v.purpose === 'MARKETING' && (!promotional || templates.length !== 1)
    || v.purpose === 'MIXED' && (!promotional || templates.length < 2)
    || promotional && v.marketingConsent === 'NOT_APPLICABLE') return invalid('A2P_CAMPAIGN_MISMATCH');
  templates.sort((a,b) => A2P_TEMPLATES.indexOf(a) - A2P_TEMPLATES.indexOf(b));
  return Object.freeze({ facts: Object.freeze({ businessName: optional(f.businessName,120), websiteUrl: optionalUrl(f.websiteUrl),
    privacyUrl: optionalUrl(f.privacyUrl), termsUrl: optionalUrl(f.termsUrl), optInUrl: optionalUrl(f.optInUrl),
    supportContact: optionalContact(f.supportContact), messageFlow: optional(f.messageFlow,2048), messageFrequency: optional(f.messageFrequency,160) }),
    purpose: v.purpose as A2pDraftInput['purpose'], templates: Object.freeze(templates), marketingConsent: v.marketingConsent as A2pDraftInput['marketingConsent'],
    ownerConfirmation: v.ownerConfirmation as A2pDraftInput['ownerConfirmation'] });
}
export function validateA2pFindingInput(value: unknown): { review: A2pWebsiteReviewInput; findingCode: A2pFindingCode } {
  const v = closed(value, ['review', 'findingCode']);
  if (!A2P_FINDING_CODES.includes(v.findingCode as A2pFindingCode)) return invalid();
  return Object.freeze({ review: validateA2pWebsiteReview(v.review), findingCode: v.findingCode as A2pFindingCode });
}
export function validateA2pCopyInput(value: unknown): { input: A2pDraftInput; expectedDigest: string; acknowledgement: typeof A2P_COPY_CONFIRMATION } {
  const v = closed(value, ['input', 'expectedDigest', 'acknowledgement']);
  if (typeof v.expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.expectedDigest) || v.acknowledgement !== A2P_COPY_CONFIRMATION) return invalid();
  return Object.freeze({ input: validateA2pDraftInput(v.input), expectedDigest: v.expectedDigest, acknowledgement: A2P_COPY_CONFIRMATION });
}
