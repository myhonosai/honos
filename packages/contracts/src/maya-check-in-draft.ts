import { MERCH_AI_REASONS, MERCH_AI_STATUSES, merchSafeText, type MerchAiReason, type MerchAiStatus } from './shopify-merch-ai.js';
import { alexPlanLine } from './alex-delegation.js';

/**
 * P8 (0649): Maya check-in drafts that send once approved (owner decision 2026-11-22: "Send automatically once approved", with
 * verbal approval allowed). A staff member asks Maya to write a check-in text or email for one student on the at-risk list. Maya
 * sees the at-risk numbers only and answers with {summary, message, subject}. The staff member may edit it, picks who gets it and
 * when, and approves it by button or by voice; approval queues one message through the school's ordinary delivery checks.
 * Spec: docs/architecture/MAYA_CHECK_IN_DRAFT_SEND.md.
 */
export const MAYA_CHECK_IN_CHANNELS = ['SMS', 'EMAIL'] as const;
export type MayaCheckInChannel = typeof MAYA_CHECK_IN_CHANNELS[number];
export const MAYA_CHECK_IN_RECIPIENTS = ['STUDENT', 'BILLING_CONTACT'] as const;
export type MayaCheckInRecipient = typeof MAYA_CHECK_IN_RECIPIENTS[number];
export const MAYA_CHECK_IN_LIMITS = { inputTokens: 6000, outputTokens: 2000, maxProviderCostMicrounits: 60000, maxResultBytes: 8192, smsChars: 480, emailChars: 2000, subjectChars: 120 } as const;
/** Maya may write this and it becomes the recipient's first name when the message is queued. */
export const MAYA_CHECK_IN_NAME_TOKEN = '[First name]';

export interface MayaCheckInBrief { membershipId: string; channel: MayaCheckInChannel; note: string }
export interface MayaCheckInProposal { summary: string; message: string; subject: string }
export interface MayaCheckInRecipientOption { recipient: MayaCheckInRecipient; name: string; reachable: boolean }
export interface MayaCheckInSend {
  recipient: MayaCheckInRecipient; channel: MayaCheckInChannel; scheduledAt: string; approvedAt: string; approvalMethod: 'BUTTON' | 'VOICE';
  edited: boolean; cancelled: boolean; delivery: string | null;
}
export interface MayaCheckInApproval {
  recipient: MayaCheckInRecipient; message: string; subject: string; sendAt: string | null; approvalMethod: 'BUTTON' | 'VOICE'; voiceTurnId: string | null;
}
export interface MayaCheckInView {
  id: string; status: MerchAiStatus; reason: MerchAiReason | null; brief: MayaCheckInBrief; studentName: string; level: string | null;
  summary: string | null; message: string | null; subject: string | null; recipients: MayaCheckInRecipientOption[];
  send: MayaCheckInSend | null; problems: string[]; createdAt: string; updatedAt: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINKISH = /(https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;
const INVISIBLE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const EDGE = /^[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]|[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/;
const bytes = (v: unknown) => { const s = JSON.stringify(v); let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3; } return n; };
const fail = (what: string): never => { throw new Error(`Invalid Maya check-in ${what}.`); };

/** One line (summary, subject, note), as 0649 hon.maya_check_in_line_ok: no Unicode edge spaces, no links. */
export function mayaCheckInLine(v: unknown, max: number): v is string {
  return alexPlanLine(v, max) && !EDGE.test(v) && !LINKISH.test(v);
}
/** A message body, as 0649 hon.maya_check_in_text_ok: lines allowed, at most one blank line in a row, no links or control characters. */
export function mayaCheckInText(v: unknown, max: number): v is string {
  return typeof v === 'string' && merchSafeText(v.replace(/\n/g, ' '), max) && !EDGE.test(v) && !v.includes('\n\n\n') && !INVISIBLE.test(v) && !LINKISH.test(v);
}
export const mayaCheckInMax = (channel: MayaCheckInChannel) => channel === 'EMAIL' ? MAYA_CHECK_IN_LIMITS.emailChars : MAYA_CHECK_IN_LIMITS.smsChars;

export function validateMayaCheckInBrief(value: unknown): MayaCheckInBrief {
  if (!isObject(value) || !exactKeys(value, ['membershipId', 'channel', 'note'])) return fail('brief');
  const { membershipId, channel, note } = value;
  if (typeof membershipId !== 'string' || !UUID.test(membershipId) || typeof channel !== 'string' || !(MAYA_CHECK_IN_CHANNELS as readonly string[]).includes(channel)
    || typeof note !== 'string' || (note !== '' && !mayaCheckInLine(note, 300))) return fail('brief');
  return { membershipId, channel: channel as MayaCheckInChannel, note };
}

/** The closed shape the database stores for a channel (0649 hon.maya_check_in_ok). */
export function validateMayaCheckInProposal(value: unknown, channel: MayaCheckInChannel): MayaCheckInProposal {
  if (!isObject(value) || !exactKeys(value, ['summary', 'message', 'subject']) || !mayaCheckInLine(value.summary, 300) || !mayaCheckInText(value.message, mayaCheckInMax(channel))) return fail('answer');
  if (channel === 'EMAIL' ? !mayaCheckInLine(value.subject, MAYA_CHECK_IN_LIMITS.subjectChars) : value.subject !== '') return fail('answer');
  if (bytes(value) > MAYA_CHECK_IN_LIMITS.maxResultBytes) return fail('answer');
  return { summary: value.summary as string, message: value.message as string, subject: value.subject as string };
}
/** What makes a shaped answer unusable, in plain words (stored with a rejected answer). */
export function mayaCheckInProblems(p: MayaCheckInProposal): string[] {
  return /\b(discount|free month|% off|refund)\b/i.test(`${p.message} ${p.subject}`) ? ['The draft offers a discount or refund. Maya must not promise money.'] : [];
}

/** The approval body, exactly as 0649 hon.approve_maya_check_in_draft takes it. */
export function validateMayaCheckInApproval(value: unknown, channel: MayaCheckInChannel): MayaCheckInApproval {
  if (!isObject(value) || !exactKeys(value, ['recipient', 'message', 'subject', 'sendAt', 'approvalMethod', 'voiceTurnId'])) return fail('approval');
  const { recipient, message, subject, sendAt, approvalMethod, voiceTurnId } = value;
  if (typeof recipient !== 'string' || !(MAYA_CHECK_IN_RECIPIENTS as readonly string[]).includes(recipient) || !mayaCheckInText(message, mayaCheckInMax(channel))
    || (channel === 'EMAIL' ? !mayaCheckInLine(subject, MAYA_CHECK_IN_LIMITS.subjectChars) : subject !== '')
    || !(sendAt === null || (typeof sendAt === 'string' && ISO.test(sendAt)))
    || !((approvalMethod === 'BUTTON' && voiceTurnId === null) || (approvalMethod === 'VOICE' && typeof voiceTurnId === 'string' && UUID.test(voiceTurnId)))) return fail('approval');
  return { recipient: recipient as MayaCheckInRecipient, message: message as string, subject: subject as string, sendAt: sendAt as string | null,
    approvalMethod: approvalMethod as 'BUTTON' | 'VOICE', voiceTurnId: voiceTurnId as string | null };
}

function send(v: unknown): MayaCheckInSend | null {
  if (v === null) return null;
  if (!isObject(v) || !exactKeys(v, ['recipient', 'channel', 'scheduledAt', 'approvedAt', 'approvalMethod', 'edited', 'cancelled', 'delivery'])
    || !(MAYA_CHECK_IN_RECIPIENTS as readonly unknown[]).includes(v.recipient) || !(MAYA_CHECK_IN_CHANNELS as readonly unknown[]).includes(v.channel)
    || typeof v.scheduledAt !== 'string' || !ISO.test(v.scheduledAt) || typeof v.approvedAt !== 'string' || !ISO.test(v.approvedAt)
    || !['BUTTON', 'VOICE'].includes(v.approvalMethod as string) || typeof v.edited !== 'boolean' || typeof v.cancelled !== 'boolean'
    || !(v.delivery === null || (typeof v.delivery === 'string' && /^[A-Z_]{1,40}$/.test(v.delivery)))) return fail('view');
  return v as unknown as MayaCheckInSend;
}
export function verifyMayaCheckInView(value: unknown): MayaCheckInView {
  if (!isObject(value) || !exactKeys(value, ['id', 'status', 'reason', 'brief', 'studentName', 'level', 'summary', 'message', 'subject', 'recipients', 'send', 'problems', 'createdAt', 'updatedAt'])) return fail('view');
  const v = value;
  if (typeof v.id !== 'string' || !UUID.test(v.id) || typeof v.status !== 'string' || !(MERCH_AI_STATUSES as readonly string[]).includes(v.status)
    || !(v.reason === null || (typeof v.reason === 'string' && (MERCH_AI_REASONS as readonly string[]).includes(v.reason)))
    || typeof v.studentName !== 'string' || v.studentName.length > 120 || !(v.level === null || (typeof v.level === 'string' && ['HIGH', 'MEDIUM', 'WATCH'].includes(v.level)))
    || typeof v.createdAt !== 'string' || !ISO.test(v.createdAt) || typeof v.updatedAt !== 'string' || !ISO.test(v.updatedAt)
    || !Array.isArray(v.problems) || v.problems.some(x => typeof x !== 'string' || x.length < 1 || x.length > 160)) return fail('view');
  if (!Array.isArray(v.recipients) || v.recipients.length > 2 || v.recipients.some(r => !isObject(r) || !exactKeys(r, ['recipient', 'name', 'reachable'])
    || !(MAYA_CHECK_IN_RECIPIENTS as readonly unknown[]).includes(r.recipient) || typeof r.name !== 'string' || r.name.length > 120 || typeof r.reachable !== 'boolean')) return fail('view');
  const brief = validateMayaCheckInBrief(v.brief);
  const open = v.status === 'RESULT_RECORDED' || v.status === 'APPLIED';
  let draft: MayaCheckInProposal | null = null;
  if (open) draft = validateMayaCheckInProposal({ summary: v.summary, message: v.message, subject: v.subject }, brief.channel);
  else if (v.summary !== null || v.message !== null || v.subject !== null) return fail('view');
  const sent = send(v.send);
  if ((sent !== null) !== (v.status === 'APPLIED')) return fail('view');
  return { id: v.id, status: v.status as MerchAiStatus, reason: v.reason as MerchAiReason | null, brief, studentName: v.studentName, level: v.level as string | null,
    summary: draft?.summary ?? null, message: draft?.message ?? null, subject: draft?.subject ?? null,
    recipients: v.recipients as MayaCheckInRecipientOption[], send: sent, problems: v.problems as string[], createdAt: v.createdAt, updatedAt: v.updatedAt };
}
export function verifyMayaCheckInList(value: unknown): MayaCheckInView[] {
  if (!Array.isArray(value) || value.length > 20) return fail('list');
  return value.map(verifyMayaCheckInView);
}
