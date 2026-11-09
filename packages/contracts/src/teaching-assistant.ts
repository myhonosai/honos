import type { CommandContext } from './index.js';

export interface TeachingAssistantContext extends CommandContext { externalSubject: string }
export interface TeachingAssistantRequest { curriculumId: string; brief?: string }
export interface TeachingDraftContent { title: string; content: string }
export type TeachingInvocationStatus = 'PENDING' | 'CONFIGURATION_REQUIRED' | 'BLOCKED' | 'SENDING' | 'UNKNOWN' | 'FAILED' | 'RESULT_RECORDED' | 'RESULT_HELD' | 'AWAITING_APPROVAL' | 'SAVED' | 'REJECTED';
export interface TeachingInvocationView {
  id: string; schoolId: string; curriculumId: string; workItemId: string; status: TeachingInvocationStatus;
  reason: string | null; actionRequestId: string | null; draft: TeachingDraftContent | null;
  inputTokens: number | null; outputTokens: number | null; providerCostMicrounits: number | null; customerCredits: number | null;
}
export const TEACHING_LIMITS = { inputTokens: 4096, outputTokens: 1024, maxProviderCostMicrounits: 100000, monthlyCredits: 12000 } as const;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
/** Bounded plain text only. URLs, credentials, and control characters are not accepted as teaching briefs or results. */
export function teachingSafeText(v: unknown, max: number, empty = false): v is string {
  return typeof v === 'string' && v.trim() === v && (empty ? v.length <= max : v.length > 0 && v.length <= max)
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|-----BEGIN|\bBearer\s+\S+|\bsk[-_][A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.eyJ|(?:api[ _-]?key|password|secret|authorization)\s*[:=]|https?:\/\/|\bwww\./i.test(v);
}
function closed(v: unknown, keys: string[]): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v) && keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => keys.includes(k)); }
export function validateTeachingAssistantRequest(v: unknown): TeachingAssistantRequest {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, 'curriculumId') || Object.keys(v).some(k => !['curriculumId', 'brief'].includes(k))) throw new Error('INVALID_TEACHING_REQUEST');
  const value = v as Record<string, unknown>;
  if (typeof value.curriculumId !== 'string' || !UUID.test(value.curriculumId) || (value.brief !== undefined && !teachingSafeText(value.brief, 1200))) throw new Error('INVALID_TEACHING_REQUEST');
  return value.brief === undefined ? { curriculumId: value.curriculumId } : { curriculumId: value.curriculumId, brief: value.brief };
}
export function validateTeachingDraft(v: unknown): TeachingDraftContent {
  if (!closed(v, ['title', 'content']) || !teachingSafeText(v.title, 160) || !teachingSafeText(v.content, 6000)) throw new Error('INVALID_TEACHING_DRAFT');
  return { title: v.title, content: v.content };
}
/** One published curriculum of the caller's school, for the Kai delegation picker (GET /v1/staff/teaching-assistant/curricula). */
export interface TeachingCurriculumOption { id: string; name: string; version: number }
export interface TeachingCurriculumOptions { items: TeachingCurriculumOption[] }
export const TEACHING_CURRICULUM_OPTIONS_LIMIT = 200;
/** Closed validator: exactly { items: [{ id, name, version }] }, at most 200 unique UUID ids, positive integer versions. */
export function validateTeachingCurriculumOptions(v: unknown): TeachingCurriculumOptions {
  if (!closed(v, ['items']) || !Array.isArray(v.items) || v.items.length > TEACHING_CURRICULUM_OPTIONS_LIMIT) throw new Error('INVALID_TEACHING_CURRICULUM_OPTIONS');
  const seen = new Set<string>();
  const items = v.items.map((item: unknown): TeachingCurriculumOption => {
    if (!closed(item, ['id', 'name', 'version']) || typeof item.id !== 'string' || !UUID.test(item.id) || seen.has(item.id.toLowerCase())
      || typeof item.name !== 'string' || item.name.length === 0 || item.name.length > 1000
      || typeof item.version !== 'number' || !Number.isSafeInteger(item.version) || item.version < 1) throw new Error('INVALID_TEACHING_CURRICULUM_OPTIONS');
    seen.add(item.id.toLowerCase());
    return { id: item.id, name: item.name, version: item.version };
  });
  return { items };
}
