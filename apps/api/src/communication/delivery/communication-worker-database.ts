import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { runtimePoolOptions } from '../../foundation/runtime-pool-options.js';
import type { CommunicationProviderName, DeliverableChannel } from './communication-provider.js';
import type { TwilioSubaccountStore } from './twilio-subaccounts.js';

export interface ClaimedCommunicationDelivery {
  deliveryId: string;
  leaseToken: string;
  organizationId: string;
  schoolId: string;
  messageId: string;
  channel: DeliverableChannel;
  recipientAddress: string;
  content: string;
  schoolName: string;
  attempt: number;
  senderAddress?: string | undefined;
  senderServiceId?: string | undefined;
}

export interface CommunicationSendResult {
  outcome: 'ACCEPTED' | 'RETRYABLE' | 'FAILED' | 'UNKNOWN';
  provider: CommunicationProviderName;
  providerMessageId?: string | undefined;
  sentAs?: 'EMAIL' | 'SMS' | 'MMS' | undefined;
  segments?: number | undefined;
  encoding?: 'GSM7' | 'UCS2' | undefined;
  failureCode?: string | undefined;
  retryAfterSeconds?: number | undefined;
}

export interface VerifiedProviderReceipt {
  provider: CommunicationProviderName;
  providerEventId: string;
  providerMessageId: string;
  honDeliveryId?: string | undefined;
  eventType: 'SENT' | 'DELIVERED' | 'DEFERRED' | 'BOUNCED' | 'DROPPED' | 'UNDELIVERED' | 'FAILED' | 'UNSUBSCRIBED' | 'SPAM_REPORT';
  occurredAt: string;
  providerCostMicrounits?: number | undefined;
  /** HQ: the receipt belongs to an 0281 HQ delivery (SendGrid hon_purpose HQ, or the Twilio HQ status path). */
  scope?: 'HQ' | undefined;
}

export interface CommunicationWorkerStore {
  isConfigured(): boolean;
  claim(channels: DeliverableChannel[], limit: number, leaseSeconds: number): Promise<ClaimedCommunicationDelivery[]>;
  recordResult(deliveryId: string, leaseToken: string, result: CommunicationSendResult): Promise<{ status: string; accepted: boolean }>;
  recordReceipt(receipt: VerifiedProviderReceipt): Promise<{ outcome: 'RECORDED' | 'REPLAYED' | 'UNMATCHED'; deliveryStatus: string | null }>;
  recordInboundKeyword?(keyword: { to: string; from: string; keyword: 'STOP' | 'START' | 'HELP'; providerMessageId: string; receivedAt: string }):
    Promise<{ outcome: 'RECORDED' | 'REPLAYED' | 'UNROUTED'; schoolName: string | null; consentsChanged: number }>;
  readMissedCallRoute?(to: string): Promise<{ routed: boolean; forwardPhoneE164: string | null }>;
  recordMissedCall?(call: { to: string; from: string; callSid: string; dialStatus: string; receivedAt: string }):
    Promise<{ outcome: 'RECORDED' | 'REPLAYED' | 'UNROUTED'; textBackStatus: string | null }>;
  claimMissedCallTextBacks?(limit: number, leaseSeconds: number): Promise<ClaimedMissedCallTextBack[]>;
  recordMissedCallTextBackResult?(missedCallId: string, leaseToken: string, outcome: 'ACCEPTED' | 'RETRYABLE' | 'FAILED' | 'UNKNOWN',
    providerMessageId: string | null): Promise<{ textBackStatus: string; accepted: boolean }>;
  recordZernioLead?(lead: ZernioLeadRecord): Promise<{ outcome: ZernioLeadOutcome; leadId: string | null }>;
}

export type ZernioLeadOutcome = 'CREATED' | 'REPLAYED' | 'UNROUTED' | 'INVALID_CONTACT' | 'SCHOOL_INACTIVE' | 'RATE_LIMITED';
export interface ZernioLeadRecord {
  eventId: string; leadgenId: string; accountId: string; formId: string; fields: Record<string, string>;
  ad: { adId?: string; adsetId?: string; campaignId?: string; isOrganic?: boolean };
}

export interface ClaimedMissedCallTextBack {
  missedCallId: string;
  leaseToken: string;
  organizationId: string;
  schoolId: string;
  callerE164: string;
  schoolName: string;
  language: string;
  senderServiceId: string | null;
  attempt: number;
}

export const COMMUNICATION_WORKER_STORE = Symbol('COMMUNICATION_WORKER_STORE');

/**
 * Connects as hon_communication_worker (HON_COMMUNICATION_WORKER_DATABASE_URL), never as the runtime or
 * migration role. The role can only execute the four 0243 worker functions; it is refused if it is a
 * superuser, bypasses RLS, or is the runtime login.
 */
@Injectable()
export class CommunicationWorkerDatabase implements CommunicationWorkerStore, TwilioSubaccountStore, OnModuleDestroy {
  private pool: Pool | undefined;
  private posture: Promise<void> | undefined;

  isConfigured(): boolean {
    return Boolean(process.env.HON_COMMUNICATION_WORKER_DATABASE_URL);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
    this.pool = undefined;
  }

  private getPool(): Pool {
    const url = process.env.HON_COMMUNICATION_WORKER_DATABASE_URL;
    if (!url) throw new Error('COMMUNICATION_WORKER_NOT_CONFIGURED');
    if (process.env.HON_RUNTIME_DATABASE_URL === url || process.env.DATABASE_URL === url) throw new Error('COMMUNICATION_WORKER_ROLE_UNSAFE');
    if (!this.pool) {
      const pool = new Pool({ ...runtimePoolOptions(url), max: 2, application_name: 'hon-communication-worker' });
      pool.on('error', () => undefined); // the pool discards a broken idle client
      this.pool = pool;
    }
    return this.pool;
  }

  private async query<T extends object>(sql: string, values: unknown[]): Promise<T[]> {
    const pool = this.getPool();
    this.posture ??= (async () => {
      const role = (await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean }>(
        'SELECT rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = current_user')).rows[0];
      if (!role || role.rolsuper || role.rolbypassrls || role.rolinherit) throw new Error('COMMUNICATION_WORKER_ROLE_UNSAFE');
    })();
    try { await this.posture; } catch (error) { this.posture = undefined; throw error; }
    return (await pool.query<T>(sql, values)).rows;
  }

  async claim(channels: DeliverableChannel[], limit: number, leaseSeconds: number): Promise<ClaimedCommunicationDelivery[]> {
    const rows = await this.query<{
      delivery_id: string; lease_token: string; organization_id: string; school_id: string; message_id: string; channel: DeliverableChannel;
      recipient_address: string; content: string; school_name: string; attempt: number;
      sender_address: string | null; sender_service_id: string | null;
    }>('SELECT * FROM hon.claim_communication_deliveries($1::text[], $2, $3)', [channels, limit, leaseSeconds]);
    return rows.map((row) => ({
      deliveryId: row.delivery_id, leaseToken: row.lease_token, organizationId: row.organization_id, schoolId: row.school_id,
      messageId: row.message_id, channel: row.channel, recipientAddress: row.recipient_address, content: row.content,
      schoolName: row.school_name, attempt: row.attempt,
      ...(row.sender_address ? { senderAddress: row.sender_address } : {}),
      ...(row.sender_service_id ? { senderServiceId: row.sender_service_id } : {}),
    }));
  }

  async recordResult(deliveryId: string, leaseToken: string, result: CommunicationSendResult) {
    const row = (await this.query<{ status: string; accepted: boolean }>(
      'SELECT * FROM hon.record_communication_send_result($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [deliveryId, leaseToken, result.outcome, result.provider, result.providerMessageId ?? null, result.sentAs ?? null,
        result.segments ?? null, result.encoding ?? null, result.failureCode ?? null, result.retryAfterSeconds ?? null]))[0];
    if (!row) throw new Error('COMMUNICATION_RESULT_NOT_RECORDED');
    return row;
  }

  async recordReceipt(receipt: VerifiedProviderReceipt) {
    const row = (await this.query<{ outcome: 'RECORDED' | 'REPLAYED' | 'UNMATCHED'; delivery_status: string | null }>(
      'SELECT * FROM hon.record_communication_provider_event($1, $2, $3, $4, $5, $6, $7)',
      [receipt.provider, receipt.providerEventId, receipt.providerMessageId, receipt.honDeliveryId ?? null, receipt.eventType,
        receipt.occurredAt, receipt.providerCostMicrounits ?? null]))[0];
    if (!row) throw new Error('COMMUNICATION_RECEIPT_NOT_RECORDED');
    return { outcome: row.outcome, deliveryStatus: row.delivery_status };
  }

  /** 0248 inbound STOP/START/HELP to a school's ACTIVE number. */
  async recordInboundKeyword(keyword: { to: string; from: string; keyword: 'STOP' | 'START' | 'HELP'; providerMessageId: string; receivedAt: string }) {
    const row = (await this.query<{ outcome: 'RECORDED' | 'REPLAYED' | 'UNROUTED'; school_name: string | null; consents_changed: number }>(
      'SELECT * FROM hon.record_inbound_text_keyword($1, $2, $3, $4, $5)',
      [keyword.to, keyword.from, keyword.keyword, keyword.providerMessageId, keyword.receivedAt]))[0];
    if (!row) throw new Error('COMMUNICATION_KEYWORD_NOT_RECORDED');
    return { outcome: row.outcome, schoolName: row.school_name, consentsChanged: row.consents_changed };
  }

  /** 0249: where to forward a call to a school number. */
  async readMissedCallRoute(to: string) {
    const row = (await this.query<{ routed: boolean; forward_phone_e164: string | null }>('SELECT * FROM hon.read_missed_call_route($1)', [to]))[0];
    return { routed: Boolean(row?.routed), forwardPhoneE164: row?.forward_phone_e164 ?? null };
  }

  async recordMissedCall(call: { to: string; from: string; callSid: string; dialStatus: string; receivedAt: string }) {
    const row = (await this.query<{ outcome: 'RECORDED' | 'REPLAYED' | 'UNROUTED'; text_back_status: string | null }>(
      'SELECT * FROM hon.record_missed_call($1, $2, $3, $4, $5)', [call.to, call.from, call.callSid, call.dialStatus, call.receivedAt]))[0];
    if (!row) throw new Error('COMMUNICATION_MISSED_CALL_NOT_RECORDED');
    return { outcome: row.outcome, textBackStatus: row.text_back_status };
  }

  async claimMissedCallTextBacks(limit: number, leaseSeconds: number): Promise<ClaimedMissedCallTextBack[]> {
    const rows = await this.query<{ missed_call_id: string; lease_token: string; organization_id: string; school_id: string; caller_e164: string;
      school_name: string; language: string; sender_service_id: string | null; attempt: number }>(
      'SELECT * FROM hon.claim_missed_call_text_backs($1, $2)', [limit, leaseSeconds]);
    return rows.map((row) => ({ missedCallId: row.missed_call_id, leaseToken: row.lease_token, organizationId: row.organization_id,
      schoolId: row.school_id, callerE164: row.caller_e164, schoolName: row.school_name, language: row.language,
      senderServiceId: row.sender_service_id, attempt: row.attempt }));
  }

  async recordMissedCallTextBackResult(missedCallId: string, leaseToken: string, outcome: 'ACCEPTED' | 'RETRYABLE' | 'FAILED' | 'UNKNOWN', providerMessageId: string | null) {
    const row = (await this.query<{ text_back_status: string; accepted: boolean }>(
      'SELECT * FROM hon.record_missed_call_text_back_result($1, $2, $3, $4)', [missedCallId, leaseToken, outcome, providerMessageId]))[0];
    if (!row) throw new Error('COMMUNICATION_MISSED_CALL_RESULT_NOT_RECORDED');
    return { textBackStatus: row.text_back_status, accepted: row.accepted };
  }

  /** 0250: one verified Zernio lead event; a CRM lead only through an HQ-mapped form. */
  async recordZernioLead(lead: ZernioLeadRecord) {
    const row = (await this.query<{ outcome: ZernioLeadOutcome; lead_id: string | null }>(
      'SELECT * FROM hon.record_zernio_lead($1, $2, $3, $4, $5::jsonb, $6::jsonb)',
      [lead.eventId, lead.leadgenId, lead.accountId, lead.formId, JSON.stringify(lead.fields), JSON.stringify(lead.ad)]))[0];
    if (!row) throw new Error('COMMUNICATION_ZERNIO_LEAD_NOT_RECORDED');
    return { outcome: row.outcome, leadId: row.lead_id };
  }

  /** T1 (0351): an ACTIVE school subaccount's sealed token, for webhook signature checks only. */
  async readTwilioWebhookAccount(accountSid: string) {
    const row = (await this.query<{ school_id: string; organization_id: string; sealed_auth_token: string; vault_key_id: string }>(
      'SELECT * FROM hon.read_twilio_webhook_account($1)', [accountSid]))[0];
    return row ? { schoolId: row.school_id, organizationId: row.organization_id, sealedAuthToken: row.sealed_auth_token, vaultKeyId: row.vault_key_id } : null;
  }

  /** T1 (0351): the subaccount a school Messaging Service is on; none means the parent account. */
  async readTwilioSendAccount(schoolId: string, serviceSid: string) {
    const row = (await this.query<{ account_sid: string; account_status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED' }>(
      'SELECT * FROM hon.read_twilio_send_account($1, $2)', [schoolId, serviceSid]))[0];
    return row ? { accountSid: row.account_sid, status: row.account_status } : null;
  }

  async twilioNumberInAccount(accountSid: string, phoneE164: string) {
    const row = (await this.query<{ owned: boolean }>('SELECT hon.twilio_number_in_account($1, $2) AS owned', [accountSid, phoneE164]))[0];
    return row?.owned === true;
  }

  async beginSchoolTwilioAccount(schoolId: string, leaseSeconds: number) {
    const row = (await this.query<{ state: 'ACTIVE' | 'CLAIMED' | 'BUSY'; account_sid: string | null; claim_token: string | null }>(
      'SELECT * FROM hon.begin_school_twilio_account($1, $2)', [schoolId, leaseSeconds]))[0];
    if (!row) throw new Error('TWILIO_ACCOUNT_NOT_CLAIMED');
    if (row.state === 'ACTIVE' && row.account_sid) return { state: 'ACTIVE' as const, accountSid: row.account_sid };
    if (row.state === 'CLAIMED' && row.claim_token) return { state: 'CLAIMED' as const, claimToken: row.claim_token };
    return { state: 'BUSY' as const };
  }

  async completeSchoolTwilioAccount(schoolId: string, claimToken: string, accountSid: string, sealedAuthToken: string, vaultKeyId: string) {
    const row = (await this.query<{ account_sid: string }>('SELECT * FROM hon.complete_school_twilio_account($1, $2, $3, $4, $5)',
      [schoolId, claimToken, accountSid, sealedAuthToken, vaultKeyId]))[0];
    if (!row) throw new Error('TWILIO_ACCOUNT_NOT_RECORDED');
    return { accountSid: row.account_sid };
  }
}
