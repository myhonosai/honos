import type { CommandContext } from './index.js';
export interface MarketingAssistantContext extends CommandContext { externalSubject: string }
export interface MarketingAssistantRequest { campaignId: string; request: string }
export interface MarketingDraftContent { title: string; content: string }
export type MarketingInvocationStatus = 'PENDING' | 'CONFIGURATION_REQUIRED' | 'BLOCKED' | 'SENDING' | 'UNKNOWN' | 'FAILED' | 'RESULT_RECORDED' | 'RESULT_HELD' | 'AWAITING_APPROVAL' | 'SAVED' | 'REJECTED';
export interface MarketingInvocationView {
  id: string; schoolId: string; campaignId: string; workItemId: string; status: MarketingInvocationStatus;
  reason: string | null; actionRequestId: string | null; draft: MarketingDraftContent | null;
  inputTokens: number | null; outputTokens: number | null; providerCostMicrounits: number | null; customerCredits: number | null;
}
export const MARKETING_LIMITS = { inputTokens: 4096, outputTokens: 1024, maxProviderCostMicrounits: 100000, monthlyCredits: 12000 } as const;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function marketingSafeText(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|-----BEGIN|\bBearer\s+\S+|\bsk[-_][A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.eyJ|(?:api[ _-]?key|password|secret|authorization)\s*[:=]/i.test(v);
}
function closed(v: unknown, keys: string[]): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && keys.every(k => Object.hasOwn(v,k)) && Object.keys(v).every(k => keys.includes(k));
}
export function validateMarketingRequest(v: unknown): MarketingAssistantRequest {
  if (!closed(v,['campaignId','request']) || typeof v.campaignId !== 'string' || !UUID.test(v.campaignId) || !marketingSafeText(v.request,2000)) throw new Error('INVALID_MARKETING_REQUEST');
  return { campaignId: v.campaignId, request: v.request.trim() };
}
export function validateMarketingDraft(v: unknown): MarketingDraftContent {
  if (!closed(v,['title','content']) || !marketingSafeText(v.title,160) || !marketingSafeText(v.content,6000)) throw new Error('INVALID_MARKETING_DRAFT');
  return {title:v.title,content:v.content};
}
