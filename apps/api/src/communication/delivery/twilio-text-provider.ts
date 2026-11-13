import { createHmac, timingSafeEqual } from 'node:crypto';
import { countTextPieces, smartEncodeText } from '@hon/contracts';
import {
  CommunicationProviderError,
  type CommunicationProviderAdapter,
  type CommunicationSendAccepted,
  type CommunicationSendRequest,
} from './communication-provider.js';
import type { VerifiedProviderReceipt } from './communication-worker-database.js';

type Env = Record<string, string | undefined>;
const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;
const MESSAGE_SID = /^(?:SM|MM)[0-9a-f]{32}$/;
const SERVICE_SID = /^MG[0-9a-f]{32}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
export const TWILIO_STATUS_PATH = '/v1/communications/webhooks/twilio/status';
/** 0281: status callbacks for HQ sends, resolved against HQ deliveries only. */
export const TWILIO_HQ_STATUS_PATH = '/v1/communications/webhooks/twilio/hq-status';
export const TWILIO_INBOUND_PATH = '/v1/communications/webhooks/twilio/inbound';
export const TWILIO_VOICE_PATH = '/v1/communications/webhooks/twilio/voice';
export const TWILIO_VOICE_RESULT_PATH = '/v1/communications/webhooks/twilio/voice-result';
const CALL_SID = /^CA[0-9a-f]{32}$/;
const MISSED_DIAL_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled']);

export function twilioPublicOrigin(env: Env): string | undefined {
  return origin(env);
}

const BASE_PATH = /^(?:\/[A-Za-z0-9._~-]+)*$/;

/**
 * The public https base URL Twilio calls, with no trailing slash: an origin (`https://api.example`) or an origin plus a
 * fixed path prefix when the API is reached through the web app's rewrite (`https://app.example/api`, which hon-web
 * forwards to the private API's `/v1/...`). Webhook URLs and signatures are this base + the fixed `/v1/...` path.
 * Anything not already in that exact canonical form (query, fragment, credentials, `..`, encoded characters, a port
 * other than the default) is refused, so the signed URL is always exactly what the operator configured.
 */
function origin(env: Env): string | undefined {
  const value = env.HON_PUBLIC_API_ORIGIN?.trim().replace(/\/$/, '');
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const path = url.pathname === '/' ? '' : url.pathname;
    const base = `${url.origin}${path}`;
    return url.protocol === 'https:' && !url.port && !url.search && !url.hash && !url.username && !url.password
      && BASE_PATH.test(path) && !path.split('/').some((part) => part === '.' || part === '..') && base === value ? base : undefined;
  } catch { return undefined; }
}

/**
 * Twilio Messaging adapter. INACTIVE unless TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and an https
 * HON_PUBLIC_API_ORIGIN are set AND HON_SMS_SEND_APPROVED is exactly 'true'. Each school sends from its own
 * Messaging Service (0248); the service's MMS converter turns 3+ piece texts into one MMS. The body is smart
 * encoded first, and texts over 1,600 characters are refused before any call.
 */
export class TwilioTextProvider implements CommunicationProviderAdapter {
  readonly provider = 'TWILIO' as const;
  readonly channel = 'SMS' as const;
  /** 0281: HQ sends go from the HQ Messaging Service (senderServiceId) with the HQ status callback path. */
  readonly hqSender = true;
  constructor(private readonly environment: () => Env = () => process.env, private readonly transport: typeof fetch = fetch) {}

  readiness() {
    const env = this.environment();
    return ACCOUNT_SID.test(env.TWILIO_ACCOUNT_SID ?? '') && env.TWILIO_AUTH_TOKEN?.trim() && origin(env) && env.HON_SMS_SEND_APPROVED === 'true'
      ? 'READY' as const : 'CONFIGURATION_REQUIRED' as const;
  }

  async send(request: CommunicationSendRequest): Promise<CommunicationSendAccepted> {
    const env = this.environment();
    const account = env.TWILIO_ACCOUNT_SID ?? '';
    const token = env.TWILIO_AUTH_TOKEN?.trim();
    const base = origin(env);
    if (this.readiness() !== 'READY' || !token || !base) throw new CommunicationProviderError('RETRYABLE', 'PROVIDER_FAILED', 300);
    if (!SERVICE_SID.test(request.senderServiceId ?? '')) throw new CommunicationProviderError('RETRYABLE', 'PROVIDER_FAILED', 900);
    if (!E164.test(request.recipientAddress)) throw new CommunicationProviderError('FAILED', 'INVALID_ADDRESS');
    const pieces = countTextPieces(request.content);
    if (pieces.tooLong || pieces.pieces === 0) throw new CommunicationProviderError('FAILED', 'PROVIDER_REJECTED');
    const form = new URLSearchParams({
      To: request.recipientAddress, MessagingServiceSid: request.senderServiceId!, Body: smartEncodeText(request.content),
    });
    if (request.statusCallback !== false) form.set('StatusCallback', `${base}${request.origin === 'HQ' ? TWILIO_HQ_STATUS_PATH : TWILIO_STATUS_PATH}`);
    let response: Response;
    try {
      response = await this.transport(`https://api.twilio.com/2010-04-01/Accounts/${account}/Messages.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`${account}:${token}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(), redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') throw new CommunicationProviderError('RETRYABLE', 'PROVIDER_FAILED');
      throw new CommunicationProviderError('UNKNOWN');
    }
    if (response.status === 201 || response.status === 200) {
      let body: { sid?: unknown; num_segments?: unknown } = {};
      try { body = await response.json() as typeof body; } catch { throw new CommunicationProviderError('UNKNOWN'); }
      if (typeof body.sid !== 'string' || !MESSAGE_SID.test(body.sid)) throw new CommunicationProviderError('UNKNOWN');
      const reported = Number(body.num_segments);
      return { providerMessageId: body.sid, sentAs: pieces.sendAs, encoding: pieces.encoding,
        segments: Number.isSafeInteger(reported) && reported >= 1 && reported <= 100 ? reported : pieces.pieces };
    }
    if (response.status === 429) throw new CommunicationProviderError('RETRYABLE', 'PROVIDER_FAILED', 60);
    if (response.status === 401 || response.status === 403) throw new CommunicationProviderError('RETRYABLE', 'PROVIDER_FAILED', 900);
    if (response.status >= 400 && response.status < 500) {
      let code: unknown;
      try { code = ((await response.json()) as { code?: unknown }).code; } catch { /* closed codes only */ }
      throw new CommunicationProviderError('FAILED', code === 21211 || code === 21614 ? 'INVALID_ADDRESS' : 'PROVIDER_REJECTED');
    }
    throw new CommunicationProviderError('UNKNOWN');
  }
}

export class TwilioWebhookError extends Error {
  constructor(readonly reason: 'NOT_CONFIGURED' | 'SIGNATURE_INVALID' | 'MALFORMED') { super(reason); }
}

const STATUS_MAP: Readonly<Record<string, VerifiedProviderReceipt['eventType']>> = {
  sent: 'SENT', delivered: 'DELIVERED', undelivered: 'UNDELIVERED', failed: 'FAILED',
};
const KEYWORDS: Readonly<Record<string, 'STOP' | 'START' | 'HELP'>> = {
  STOP: 'STOP', STOPALL: 'STOP', UNSUBSCRIBE: 'STOP', CANCEL: 'STOP', END: 'STOP', QUIT: 'STOP', OPTOUT: 'STOP', REVOKE: 'STOP',
  START: 'START', UNSTOP: 'START', YES: 'START', HELP: 'HELP', INFO: 'HELP',
};

export interface IncomingCall { callSid: string; from: string | null; to: string }
export interface MissedCallReport { callSid: string; from: string; to: string; dialStatus: 'no-answer' | 'busy' | 'failed' | 'canceled'; receivedAt: string }

export interface InboundTextKeyword { to: string; from: string; keyword: 'STOP' | 'START' | 'HELP'; providerMessageId: string; receivedAt: string }

/**
 * Twilio request signature: base64 HMAC-SHA1 with TWILIO_AUTH_TOKEN over the exact public URL followed by every
 * POST parameter name and value in name order. The URL is the HON_PUBLIC_API_ORIGIN base (origin plus any fixed path
 * prefix, such as hon-web's /api) + the fixed path, never a request header.
 */
export class TwilioWebhookVerifier {
  constructor(private readonly environment: () => Env = () => process.env, private readonly now: () => number = Date.now) {}

  private params(rawBody: Buffer, path: string, signature: string | undefined): URLSearchParams {
    const env = this.environment();
    const token = env.TWILIO_AUTH_TOKEN?.trim();
    const base = origin(env);
    if (!token || !base) throw new TwilioWebhookError('NOT_CONFIGURED');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(rawBody); } catch { throw new TwilioWebhookError('MALFORMED'); }
    const params = new URLSearchParams(text);
    const names = [...new Set(params.keys())].sort();
    if (names.length > 60) throw new TwilioWebhookError('MALFORMED');
    let data = `${base}${path}`;
    for (const name of names) for (const value of params.getAll(name)) data += name + value;
    const expected = createHmac('sha1', token).update(data, 'utf8').digest();
    const given = Buffer.from(signature ?? '', 'base64');
    if (!signature || given.length !== expected.length || !timingSafeEqual(given, expected)) throw new TwilioWebhookError('SIGNATURE_INVALID');
    if (params.get('AccountSid') !== env.TWILIO_ACCOUNT_SID) throw new TwilioWebhookError('SIGNATURE_INVALID');
    return params;
  }

  /** A status callback as a receipt, or null for statuses HON does not store (queued, sending, read). */
  status(rawBody: Buffer, signature: string | undefined): VerifiedProviderReceipt | null {
    return this.statusAt(rawBody, TWILIO_STATUS_PATH, signature);
  }

  /** 0281: the same status callback for an HQ send, signed over the HQ path and marked scope HQ. */
  hqStatus(rawBody: Buffer, signature: string | undefined): VerifiedProviderReceipt | null {
    const receipt = this.statusAt(rawBody, TWILIO_HQ_STATUS_PATH, signature);
    return receipt ? { ...receipt, scope: 'HQ' } : null;
  }

  private statusAt(rawBody: Buffer, path: string, signature: string | undefined): VerifiedProviderReceipt | null {
    const params = this.params(rawBody, path, signature);
    const sid = params.get('MessageSid') ?? '';
    const status = params.get('MessageStatus') ?? '';
    if (!MESSAGE_SID.test(sid)) throw new TwilioWebhookError('MALFORMED');
    const eventType = STATUS_MAP[status];
    if (!eventType) return null;
    return { provider: 'TWILIO', providerEventId: `${sid}:${status}`, providerMessageId: sid, eventType, occurredAt: new Date(this.now()).toISOString() };
  }

  /** An inbound message that is exactly one opt-out, opt-in or help keyword; anything else is null and is not stored. */
  inbound(rawBody: Buffer, signature: string | undefined): InboundTextKeyword | null {
    const params = this.params(rawBody, TWILIO_INBOUND_PATH, signature);
    const sid = params.get('MessageSid') ?? '';
    const from = params.get('From') ?? '';
    const to = params.get('To') ?? '';
    if (!MESSAGE_SID.test(sid) || !E164.test(from) || !E164.test(to)) throw new TwilioWebhookError('MALFORMED');
    const word = (params.get('Body') ?? '').trim().replace(/[.!]+$/, '').toUpperCase();
    const keyword = KEYWORDS[word];
    return keyword ? { to, from, keyword, providerMessageId: sid, receivedAt: new Date(this.now()).toISOString() } : null;
  }

  /**
   * 0282: the same signed inbound text for the HQ check: the Messaging Service it reached and the raw body (classified
   * in the database, never stored). Null when Twilio sent no Messaging Service SID (a number outside any service).
   */
  inboundText(rawBody: Buffer, signature: string | undefined): { eventId: string; from: string; toService: string; body: string; receivedAt: string } | null {
    const params = this.params(rawBody, TWILIO_INBOUND_PATH, signature);
    const sid = params.get('MessageSid') ?? '';
    const from = params.get('From') ?? '';
    const to = params.get('To') ?? '';
    if (!MESSAGE_SID.test(sid) || !E164.test(from) || !E164.test(to)) throw new TwilioWebhookError('MALFORMED');
    const service = params.get('MessagingServiceSid') ?? '';
    if (!SERVICE_SID.test(service)) return null;
    return { eventId: sid, from, toService: service, body: (params.get('Body') ?? '').slice(0, 1600), receivedAt: new Date(this.now()).toISOString() };
  }

  /** 0249: an incoming call to a school number. A withheld caller ID is null (it is forwarded, never texted). */
  voice(rawBody: Buffer, signature: string | undefined): IncomingCall {
    const params = this.params(rawBody, TWILIO_VOICE_PATH, signature);
    const callSid = params.get('CallSid') ?? '';
    const from = params.get('From') ?? '';
    const to = params.get('To') ?? '';
    if (!CALL_SID.test(callSid) || !E164.test(to)) throw new TwilioWebhookError('MALFORMED');
    return { callSid, from: E164.test(from) ? from : null, to };
  }

  /** 0249: the forwarded leg's outcome. Only an unanswered, busy, failed or canceled call is a missed call; anything else is null. */
  voiceResult(rawBody: Buffer, signature: string | undefined): MissedCallReport | null {
    const params = this.params(rawBody, TWILIO_VOICE_RESULT_PATH, signature);
    const callSid = params.get('CallSid') ?? '';
    const from = params.get('From') ?? '';
    const to = params.get('To') ?? '';
    const dialStatus = params.get('DialCallStatus') ?? '';
    if (!CALL_SID.test(callSid) || !E164.test(to)) throw new TwilioWebhookError('MALFORMED');
    if (!MISSED_DIAL_STATUSES.has(dialStatus) || !E164.test(from)) return null;
    return { callSid, from, to, dialStatus: dialStatus as MissedCallReport['dialStatus'], receivedAt: new Date(this.now()).toISOString() };
  }
}
