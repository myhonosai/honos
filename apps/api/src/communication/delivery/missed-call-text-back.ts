import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  COMMUNICATION_PROVIDER_ADAPTERS,
  CommunicationProviderError,
  type CommunicationProviderAdapter,
} from './communication-provider.js';
import { COMMUNICATION_WORKER_STORE, type CommunicationWorkerStore } from './communication-worker-database.js';
import { TWILIO_VOICE_RESULT_PATH } from './twilio-text-provider.js';

const E164 = /^\+[1-9][0-9]{7,14}$/;
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const FORWARD_RING_SECONDS = 20;

/**
 * 0249 voice answer for a school number: ring the school's own phone and report the outcome to the fixed
 * voice-result URL, or hang up when no forwarding phone is set (the call is then recorded as missed).
 */
export function voiceForwardTwiml(forwardPhoneE164: string | null, publicOrigin: string): string {
  if (forwardPhoneE164 === null) return `${XML_HEAD}<Response><Hangup/></Response>`;
  if (!E164.test(forwardPhoneE164)) throw new Error('HON forwarding phone is invalid.');
  const origin = new URL(publicOrigin).origin;
  return `${XML_HEAD}<Response><Dial timeout="${FORWARD_RING_SECONDS}" action="${origin}${TWILIO_VOICE_RESULT_PATH}" method="POST">`
    + `<Number>${forwardPhoneE164}</Number></Dial></Response>`;
}

export const EMPTY_VOICE_TWIML = `${XML_HEAD}<Response><Hangup/></Response>`;
export const REJECT_VOICE_TWIML = `${XML_HEAD}<Response><Reject/></Response>`;

const TEMPLATES: Readonly<Record<'en' | 'ko' | 'es', (school: string) => string>> = {
  en: (school) => `${school}: Sorry we missed your call! We'll call you back soon. Reply STOP to opt out.`,
  ko: (school) => `${school}: 전화를 받지 못해 죄송합니다. 곧 다시 연락드리겠습니다. 수신거부 STOP`,
  es: (school) => `${school}: Disculpe, no pudimos contestar su llamada. Le llamaremos pronto. Responda STOP para no recibir mensajes.`,
};

/** The one fixed reply, in the school's default language. The school name is plain text, at most 40 characters. */
export function missedCallTextBackBody(language: string, schoolName: string): string {
  const school = schoolName.replace(/[<>\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40).trim() || 'HON';
  const template = TEMPLATES[language as keyof typeof TEMPLATES] ?? TEMPLATES.en;
  return template(school);
}

export interface MissedCallSettingsInput { forwardPhoneE164: string | null; textBack: boolean; expectedVersion: number }

export function validateMissedCallSettingsInput(body: unknown): MissedCallSettingsInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['forwardPhoneE164', 'textBack', 'expectedVersion'].includes(key))
    || (input.forwardPhoneE164 !== null && (typeof input.forwardPhoneE164 !== 'string' || !E164.test(input.forwardPhoneE164)))
    || typeof input.textBack !== 'boolean'
    || !Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
    throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
  }
  return { forwardPhoneE164: input.forwardPhoneE164 as string | null, textBack: input.textBack, expectedVersion: input.expectedVersion as number };
}

export interface MissedCallDispatchSummary { claimed: number; accepted: number; retrying: number; failed: number; unknown: number; lateResults: number }

const SEND_TIMEOUT_MS = 20_000;
const LEASE_SECONDS = 60;

/**
 * Sends leased missed-call replies through the first READY SMS adapter (the same Twilio adapter and
 * HON_SMS_SEND_APPROVED switch as school texts), without a status callback, outside any transaction.
 * Nothing is claimed while no SMS adapter is READY.
 */
@Injectable()
export class MissedCallTextBackDispatcher {
  constructor(
    @Inject(COMMUNICATION_WORKER_STORE) private readonly store: Pick<CommunicationWorkerStore, 'isConfigured' | 'claimMissedCallTextBacks' | 'recordMissedCallTextBackResult'>,
    @Inject(COMMUNICATION_PROVIDER_ADAPTERS) private readonly adapters: readonly CommunicationProviderAdapter[],
  ) {}

  async runOnce(limit = 25): Promise<MissedCallDispatchSummary> {
    const summary: MissedCallDispatchSummary = { claimed: 0, accepted: 0, retrying: 0, failed: 0, unknown: 0, lateResults: 0 };
    const adapter = this.adapters.find((candidate) => candidate.channel === 'SMS' && candidate.readiness() === 'READY');
    if (!adapter || !this.store.isConfigured() || !this.store.claimMissedCallTextBacks || !this.store.recordMissedCallTextBackResult) return summary;
    // Batches of two keep every send (20 s timeout each) inside the 60 s lease.
    for (let batch = await this.store.claimMissedCallTextBacks(Math.min(2, limit), LEASE_SECONDS); batch.length;
      batch = summary.claimed < limit ? await this.store.claimMissedCallTextBacks(Math.min(2, limit - summary.claimed), LEASE_SECONDS) : []) {
    summary.claimed += batch.length;
    for (const call of batch) {
      let outcome: 'ACCEPTED' | 'RETRYABLE' | 'FAILED' | 'UNKNOWN';
      let providerMessageId: string | null = null;
      try {
        const accepted = await withTimeout(adapter.send({
          deliveryId: call.missedCallId, messageId: call.missedCallId, organizationId: call.organizationId, schoolId: call.schoolId,
          channel: 'SMS', recipientAddress: call.callerE164, content: missedCallTextBackBody(call.language, call.schoolName),
          schoolName: call.schoolName, attempt: call.attempt, senderServiceId: call.senderServiceId ?? undefined, statusCallback: false,
        }), SEND_TIMEOUT_MS);
        outcome = 'ACCEPTED';
        providerMessageId = accepted.providerMessageId;
      } catch (error) {
        outcome = error instanceof CommunicationProviderError ? error.outcome : 'UNKNOWN';
      }
      const recorded = await this.store.recordMissedCallTextBackResult(call.missedCallId, call.leaseToken, outcome, providerMessageId);
      if (!recorded.accepted) summary.lateResults += 1;
      if (recorded.textBackStatus === 'ACCEPTED') summary.accepted += 1;
      else if (recorded.textBackStatus === 'PENDING') summary.retrying += 1;
      else if (recorded.textBackStatus === 'FAILED') summary.failed += 1;
      else summary.unknown += 1;
    }
    }
    return summary;
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CommunicationProviderError('UNKNOWN')), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}
