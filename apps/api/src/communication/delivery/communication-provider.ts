/**
 * 0243 provider boundary for consent-gated message delivery. An adapter gets exactly one leased send: the
 * address, the body and the school name. It has no database, tenant authority or consent access.
 */
export const COMMUNICATION_PROVIDER_ADAPTERS = Symbol('COMMUNICATION_PROVIDER_ADAPTERS');

export type CommunicationProviderName = 'FAKE' | 'SENDGRID' | 'TWILIO';
export type DeliverableChannel = 'EMAIL' | 'SMS';
export type CommunicationProviderReadiness = 'READY' | 'CONFIGURATION_REQUIRED';

export interface CommunicationSendRequest {
  deliveryId: string;
  messageId: string;
  organizationId: string;
  schoolId: string;
  channel: DeliverableChannel;
  recipientAddress: string;
  content: string;
  schoolName: string;
  attempt: number;
  /**
   * Who the mail is for. Omitted or SCHOOL: a 0243 school delivery. INTERNAL (staff notices such as the weekly
   * briefing) and HQ (HQ messages) are tagged so the school receipt webhooks acknowledge and ignore them.
   */
  purpose?: 'SCHOOL' | 'INTERNAL' | 'HQ';
}

export interface CommunicationSendAccepted {
  providerMessageId: string;
  sentAs: 'EMAIL' | 'SMS' | 'MMS';
  segments?: number | undefined;
  encoding?: 'GSM7' | 'UCS2' | undefined;
}

export type CommunicationSendFailureCode = 'PROVIDER_REJECTED' | 'INVALID_ADDRESS' | 'PROVIDER_FAILED';

/**
 * RETRYABLE: the provider certainly did not take the message (connection refused, 429, 5xx before
 * acceptance). FAILED: permanently refused. UNKNOWN: the provider may have taken it (timeout, lost
 * response); never retried automatically.
 */
export class CommunicationProviderError extends Error {
  constructor(
    readonly outcome: 'RETRYABLE' | 'FAILED' | 'UNKNOWN',
    readonly failureCode: CommunicationSendFailureCode | 'PROVIDER_UNKNOWN' = outcome === 'UNKNOWN' ? 'PROVIDER_UNKNOWN' : 'PROVIDER_FAILED',
    readonly retryAfterSeconds?: number,
  ) { super(`${outcome}:${failureCode}`); }
}

export interface CommunicationProviderAdapter {
  readonly provider: CommunicationProviderName;
  readonly channel: DeliverableChannel;
  readiness(): CommunicationProviderReadiness;
  send(request: CommunicationSendRequest): Promise<CommunicationSendAccepted>;
}

/** The deployment flag value that enables the deterministic fake provider outside production and staging. */
export function fakeProviderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HON_COMMUNICATION_FAKE_PROVIDER !== '1') return false;
  const deployment = env.HON_DEPLOYMENT_ENVIRONMENT;
  if (deployment === 'production' || deployment === 'staging') return false;
  return !(deployment === undefined && env.NODE_ENV === 'production');
}
