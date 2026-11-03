import type { CommandContext } from './index.js';

export interface ChadFollowUpAssistantContext extends CommandContext { externalSubject: string }
export const FOLLOW_UP_DRAFT_PURPOSES = ['INTRODUCTION', 'CHECK_IN', 'TRIAL_REMINDER', 'REENGAGEMENT'] as const;
export type FollowUpDraftPurpose = (typeof FOLLOW_UP_DRAFT_PURPOSES)[number];
export interface ChadFollowUpAssistantRequest { leadId: string; expectedLeadVersion: number; purpose: FollowUpDraftPurpose }
export interface FollowUpDraftContent { subject: string; content: string }
export type ChadFollowUpInvocationStatus = 'PENDING' | 'CONFIGURATION_REQUIRED' | 'BLOCKED' | 'SENDING' | 'UNKNOWN' | 'FAILED' | 'RESULT_RECORDED' | 'RESULT_HELD' | 'AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED';
export interface ChadFollowUpInvocationView {
  id: string; schoolId: string; leadId: string; leadVersion: number; purpose: FollowUpDraftPurpose; workItemId: string;
  status: ChadFollowUpInvocationStatus; reason: string | null; actionRequestId: string | null; draft: FollowUpDraftContent | null;
  inputTokens: number | null; outputTokens: number | null; providerCostMicrounits: number | null; customerCredits: number | null;
  delivery: 'NOT_CREATED_OR_SENT';
}
export const CHAD_FOLLOW_UP_LIMITS = { inputTokens: 2048, outputTokens: 600, maxProviderCostMicrounits: 60000, monthlyCredits: 12000 } as const;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function chadFollowUpSafeText(v:unknown,max:number):v is string { return typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|-----BEGIN|\bBearer\s+\S+|\bsk[-_][A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.eyJ|(?:api[ _-]?key|password|secret|authorization)\s*[:=]|https?:\/\/|\bwww\./i.test(v); }
function closed(v:unknown,keys:string[]):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v)&&keys.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>keys.includes(k));}
export function validateChadFollowUpAssistantRequest(v:unknown):ChadFollowUpAssistantRequest { if(!closed(v,['leadId','expectedLeadVersion','purpose'])||typeof v.leadId!=='string'||!UUID.test(v.leadId)||typeof v.expectedLeadVersion!=='number'||!Number.isSafeInteger(v.expectedLeadVersion)||v.expectedLeadVersion<1||v.expectedLeadVersion>999999998||typeof v.purpose!=='string'||!(FOLLOW_UP_DRAFT_PURPOSES as readonly string[]).includes(v.purpose)) throw new Error('INVALID_FOLLOW_UP_DRAFT_REQUEST');return {leadId:v.leadId,expectedLeadVersion:v.expectedLeadVersion,purpose:v.purpose as FollowUpDraftPurpose}; }
export function validateFollowUpDraft(v:unknown):FollowUpDraftContent {if(!closed(v,['subject','content'])||!chadFollowUpSafeText(v.subject,120)||!chadFollowUpSafeText(v.content,3000))throw new Error('INVALID_FOLLOW_UP_DRAFT');return {subject:v.subject,content:v.content};}
