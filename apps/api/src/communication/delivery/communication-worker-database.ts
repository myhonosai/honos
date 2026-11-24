import type { SchoolNumberPurchaseResult } from './school-number-purchase.js';
import type { SchoolA2pClaim, SchoolA2pResult } from './school-a2p.js';
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
  /** 0424: the email subject the author wrote (absent: the adapter's standard subject). */
  subject?: string | undefined;
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
  /** 0364: a non-keyword text to a school number becomes a message in that school's conversations inbox. */
  recordInboundConversationText?(text: { to: string; from: string; body: string; mediaCount: number; providerMessageId: string; receivedAt: string }):
    Promise<{ outcome: 'RECORDED' | 'REPLAYED' | 'UNROUTED' | 'RATE_LIMITED' | 'KEYWORD' | 'EMPTY'; conversationId: string | null }>;
  readMissedCallRoute?(to: string): Promise<{ routed: boolean; forwardPhoneE164: string | null }>;
  recordMissedCall?(call: { to: string; from: string; callSid: string; dialStatus: string; receivedAt: string }):
    Promise<{ outcome: 'RECORDED' | 'REPLAYED' | 'UNROUTED'; textBackStatus: string | null }>;
  claimMissedCallTextBacks?(limit: number, leaseSeconds: number): Promise<ClaimedMissedCallTextBack[]>;
  recordMissedCallTextBackResult?(missedCallId: string, leaseToken: string, outcome: 'ACCEPTED' | 'RETRYABLE' | 'FAILED' | 'UNKNOWN',
    providerMessageId: string | null): Promise<{ textBackStatus: string; accepted: boolean }>;
  recordZernioLead?(lead: ZernioLeadRecord): Promise<{ outcome: ZernioLeadOutcome; leadId: string | null }>;
  /** 0348 school posts: lease due targets, record each publish result, and record signed Zernio post/account receipts. */
  claimSocialPostTargets?(limit: number, leaseSeconds: number): Promise<ClaimedSocialPostTarget[]>;
  recordSocialPostResult?(targetId: string, leaseToken: string, outcome: 'PUBLISHED' | 'FAILED' | 'UNKNOWN', providerPostId: string | null):
    Promise<{ status: string; accepted: boolean }>;
  recordSocialPostEvent?(event: ZernioSocialEventRecord): Promise<{ outcome: 'APPLIED' | 'IGNORED' | 'UNMATCHED' | 'REPLAYED' }>;
  /** 0435 school inbox: record one signed inbound DM or comment. */
  recordSocialInboxEvent?(event: ZernioInboxEventRecord): Promise<{ outcome: SocialInboxEventOutcome }>;
  /** 0556/0673 calling on the school number (CL3b): the signed Twilio voice webhooks and the browser phone key. */
  connectSchoolClientCall?(callId: string, identity: string, accountSid: string | null, callSid: string): Promise<SchoolClientCallDecision>;
  routeSchoolIncomingCall?(to: string, from: string | null, callSid: string): Promise<SchoolIncomingCallRoute>;
  recordSchoolCallStatus?(accountSid: string | null, callSid: string, status: SchoolCallProviderStatus, answeredIdentity: string | null,
    durationSeconds: number | null, occurredAt: string): Promise<{ outcome: 'RECORDED' | 'IGNORED' | 'UNKNOWN_CALL'; status: string | null }>;
  recordSchoolCallRecording?(accountSid: string | null, callSid: string, recordingSid: string, seconds: number, voicemail: boolean):
    Promise<{ outcome: 'RECORDED' | 'REPLAYED' | 'REFUSED' | 'UNKNOWN_CALL'; callId: string | null }>;
  readSchoolVoiceApp?(schoolId: string): Promise<SchoolVoiceAppKey | null>;
  /** 0673 V1 (CL3c): the voice app worker claims a school, records its TwiML App, then its sealed API key. */
  readSchoolsNeedingVoiceApp?(limit: number): Promise<string[]>;
  beginSchoolVoiceApp?(schoolId: string, leaseSeconds: number): Promise<SchoolVoiceAppClaim>;
  recordSchoolVoiceAppTwiml?(schoolId: string, claimToken: string, twimlAppSid: string): Promise<boolean>;
  completeSchoolVoiceApp?(schoolId: string, claimToken: string, apiKeySid: string, sealedApiSecret: string, vaultKeyId: string): Promise<boolean>;
  /** 0556 K3 (CL3c): recordings past 90 days, deleted at Twilio first, then marked deleted by exact SID. */
  readSchoolCallRecordingsDue?(limit: number): Promise<SchoolCallRecordingDue[]>;
  markSchoolCallRecordingDeleted?(callId: string, recordingSid: string): Promise<boolean>;
  /** 0674 HQ calling on the HQ number (CL5): parent-account webhooks, the HQ voice app and voicemail retention. */
  connectHqClientCall?(callId: string, identity: string, callSid: string): Promise<HqClientCallDecision>;
  routeHqIncomingCall?(to: string, from: string | null, callSid: string): Promise<HqIncomingCallRoute>;
  recordHqCallStatus?(callSid: string, status: SchoolCallProviderStatus, answeredIdentity: string | null, durationSeconds: number | null, occurredAt: string):
    Promise<{ outcome: 'RECORDED' | 'IGNORED' | 'UNKNOWN_CALL'; status: string | null }>;
  recordHqCallVoicemail?(callSid: string, recordingSid: string, seconds: number): Promise<{ outcome: 'RECORDED' | 'REPLAYED' | 'REFUSED' | 'UNKNOWN_CALL'; callId: string | null }>;
  readHqVoiceApp?(): Promise<HqVoiceAppKey | null>;
  hqNeedsVoiceApp?(): Promise<boolean>;
  beginHqVoiceApp?(leaseSeconds: number): Promise<SchoolVoiceAppClaim>;
  recordHqVoiceAppTwiml?(claimToken: string, twimlAppSid: string): Promise<boolean>;
  completeHqVoiceApp?(claimToken: string, apiKeySid: string, sealedApiSecret: string, vaultKeyId: string): Promise<boolean>;
  readHqCallRecordingsDue?(limit: number): Promise<{ callId: string; recordingSid: string }[]>;
  markHqCallRecordingDeleted?(callId: string, recordingSid: string): Promise<boolean>;
}
export interface HqClientCallDecision { outcome: 'CONNECT' | 'REPLAYED' | 'REFUSED'; toE164: string | null; callerIdE164: string | null }
export interface HqIncomingCallRoute { outcome: 'RING' | 'REPLAYED' | 'OFF' | 'UNROUTED'; callId: string | null; identities: string[]; voicemailGreeting: string | null }
export interface HqVoiceAppKey { twimlAppSid: string; apiKeySid: string; sealedApiSecret: string; vaultKeyId: string }
export interface SchoolVoiceAppClaim { state: 'CLAIMED' | 'ACTIVE' | 'BUSY' | 'INELIGIBLE'; accountSid: string | null; twimlAppSid: string | null; claimToken: string | null }
export interface SchoolCallRecordingDue { callId: string; recordingSid: string; accountSid: string | null }
export type SchoolCallProviderStatus = 'RINGING' | 'IN_PROGRESS' | 'COMPLETED' | 'NO_ANSWER' | 'BUSY' | 'FAILED' | 'CANCELED' | 'MISSED';
export interface SchoolClientCallDecision {
  outcome: 'CONNECT' | 'REPLAYED' | 'REFUSED'; toE164: string | null; callerIdE164: string | null; recorded: boolean; language: string | null; schoolName: string | null;
}
export interface SchoolIncomingCallRoute {
  outcome: 'RING' | 'REPLAYED' | 'OFF' | 'UNROUTED'; callId: string | null; identities: string[]; forwardPhoneE164: string | null; recorded: boolean;
  voicemailGreeting: string | null; language: string | null; schoolName: string | null;
}
export interface SchoolVoiceAppKey { accountSid: string; twimlAppSid: string; apiKeySid: string; sealedApiSecret: string; vaultKeyId: string }
export type SocialInboxEventOutcome = 'APPLIED' | 'IGNORED' | 'UNMATCHED' | 'DUPLICATE' | 'REPLAYED';
export interface ZernioInboxEventRecord {
  eventId: string; eventType: 'message.received' | 'comment.received'; platform: 'FACEBOOK' | 'INSTAGRAM'; providerAccountId: string;
  providerConversationId: string; providerMessageId: string; providerPostId: string | null; participantName: string; text: string; occurredAt: string;
}

export interface ClaimedSocialPostTarget {
  targetId: string; leaseToken: string; organizationId: string; schoolId: string; platform: 'FACEBOOK' | 'INSTAGRAM' | 'GOOGLE_BUSINESS';
  providerAccountId: string; providerProfileId: string | null; text: string; linkUrl: string | null;
}
export interface ZernioSocialEventRecord {
  eventId: string; eventType: 'post.published' | 'post.failed' | 'account.disconnected'; platform: 'FACEBOOK' | 'INSTAGRAM' | 'GOOGLE_BUSINESS';
  providerAccountId: string; providerPostId: string | null;
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
      sender_address: string | null; sender_service_id: string | null; email_subject: string | null;
    }>(`SELECT c.*, CASE WHEN c.channel = 'EMAIL' THEN hon.communication_email_subject(c.delivery_id, c.lease_token) END AS email_subject
      FROM hon.claim_communication_deliveries($1::text[], $2, $3) c`, [channels, limit, leaseSeconds]);
    return rows.map((row) => ({
      deliveryId: row.delivery_id, leaseToken: row.lease_token, organizationId: row.organization_id, schoolId: row.school_id,
      messageId: row.message_id, channel: row.channel, recipientAddress: row.recipient_address, content: row.content,
      schoolName: row.school_name, attempt: row.attempt,
      ...(row.channel === 'EMAIL' && row.email_subject ? { subject: row.email_subject } : {}),
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
  async recordInboundConversationText(text: { to: string; from: string; body: string; mediaCount: number; providerMessageId: string; receivedAt: string }) {
    const row = (await this.query<{ outcome: 'RECORDED' | 'REPLAYED' | 'UNROUTED' | 'RATE_LIMITED' | 'KEYWORD' | 'EMPTY'; conversation_id: string | null }>(
      'SELECT * FROM hon.record_inbound_conversation_text($1, $2, $3, $4, $5, $6)',
      [text.to, text.from, text.body, text.mediaCount, text.providerMessageId, text.receivedAt]))[0];
    if (!row) throw new Error('COMMUNICATION_INBOUND_CONVERSATION_NOT_RECORDED');
    return { outcome: row.outcome, conversationId: row.conversation_id };
  }

  async connectSchoolClientCall(callId: string, identity: string, accountSid: string | null, callSid: string): Promise<SchoolClientCallDecision> {
    const row = (await this.query<{ outcome: SchoolClientCallDecision['outcome']; to_e164: string | null; caller_id_e164: string | null; recorded: boolean | null;
      language: string | null; school_name: string | null }>('SELECT * FROM hon.connect_school_client_call($1::uuid, $2, $3, $4)', [callId, identity, accountSid, callSid]))[0];
    if (!row) throw new Error('SCHOOL_CALL_NOT_DECIDED');
    return { outcome: row.outcome, toE164: row.to_e164, callerIdE164: row.caller_id_e164, recorded: row.recorded === true, language: row.language, schoolName: row.school_name };
  }

  async routeSchoolIncomingCall(to: string, from: string | null, callSid: string): Promise<SchoolIncomingCallRoute> {
    const row = (await this.query<{ outcome: SchoolIncomingCallRoute['outcome']; call_id: string | null; identities: string[] | null; forward_phone_e164: string | null;
      recorded: boolean | null; voicemail_greeting: string | null; language: string | null; school_name: string | null }>(
      'SELECT * FROM hon.route_school_incoming_call($1, $2, $3)', [to, from, callSid]))[0];
    if (!row) throw new Error('SCHOOL_CALL_NOT_ROUTED');
    return { outcome: row.outcome, callId: row.call_id, identities: row.identities ?? [], forwardPhoneE164: row.forward_phone_e164, recorded: row.recorded === true,
      voicemailGreeting: row.voicemail_greeting, language: row.language, schoolName: row.school_name };
  }

  async recordSchoolCallStatus(accountSid: string | null, callSid: string, status: SchoolCallProviderStatus, answeredIdentity: string | null,
    durationSeconds: number | null, occurredAt: string) {
    const row = (await this.query<{ outcome: 'RECORDED' | 'IGNORED' | 'UNKNOWN_CALL'; status: string | null }>(
      'SELECT * FROM hon.record_school_call_status($1, $2, $3, $4, $5, $6::timestamptz)', [accountSid, callSid, status, answeredIdentity, durationSeconds, occurredAt]))[0];
    if (!row) throw new Error('SCHOOL_CALL_STATUS_NOT_RECORDED');
    return { outcome: row.outcome, status: row.status };
  }

  async recordSchoolCallRecording(accountSid: string | null, callSid: string, recordingSid: string, seconds: number, voicemail: boolean) {
    const row = (await this.query<{ outcome: 'RECORDED' | 'REPLAYED' | 'REFUSED' | 'UNKNOWN_CALL'; call_id: string | null }>(
      'SELECT * FROM hon.record_school_call_recording($1, $2, $3, $4, $5)', [accountSid, callSid, recordingSid, seconds, voicemail]))[0];
    if (!row) throw new Error('SCHOOL_CALL_RECORDING_NOT_RECORDED');
    return { outcome: row.outcome, callId: row.call_id };
  }

  async readSchoolVoiceApp(schoolId: string): Promise<SchoolVoiceAppKey | null> {
    const row = (await this.query<{ account_sid: string; twiml_app_sid: string; api_key_sid: string; sealed_api_secret: string; vault_key_id: string }>(
      'SELECT * FROM hon.read_school_voice_app($1::uuid)', [schoolId]))[0];
    return row ? { accountSid: row.account_sid, twimlAppSid: row.twiml_app_sid, apiKeySid: row.api_key_sid, sealedApiSecret: row.sealed_api_secret, vaultKeyId: row.vault_key_id } : null;
  }

  async readSchoolsNeedingVoiceApp(limit: number): Promise<string[]> {
    return (await this.query<{ school_id: string }>('SELECT * FROM hon.read_schools_needing_voice_app($1::integer)', [limit])).map(row => row.school_id);
  }

  async beginSchoolVoiceApp(schoolId: string, leaseSeconds: number): Promise<SchoolVoiceAppClaim> {
    const row = (await this.query<{ state: SchoolVoiceAppClaim['state']; account_sid: string | null; twiml_app_sid: string | null; claim_token: string | null }>(
      'SELECT * FROM hon.begin_school_voice_app($1::uuid, $2::integer)', [schoolId, leaseSeconds]))[0];
    if (!row) throw new Error('COMMUNICATION_VOICE_APP_NOT_CLAIMED');
    return { state: row.state, accountSid: row.account_sid, twimlAppSid: row.twiml_app_sid, claimToken: row.claim_token };
  }

  async recordSchoolVoiceAppTwiml(schoolId: string, claimToken: string, twimlAppSid: string): Promise<boolean> {
    const row = (await this.query<{ recorded: boolean }>('SELECT hon.record_school_voice_app_twiml($1::uuid, $2::uuid, $3) AS recorded', [schoolId, claimToken, twimlAppSid]))[0];
    return row?.recorded === true;
  }

  async completeSchoolVoiceApp(schoolId: string, claimToken: string, apiKeySid: string, sealedApiSecret: string, vaultKeyId: string): Promise<boolean> {
    const row = (await this.query<{ completed: boolean }>('SELECT hon.complete_school_voice_app($1::uuid, $2::uuid, $3, $4, $5) AS completed',
      [schoolId, claimToken, apiKeySid, sealedApiSecret, vaultKeyId]))[0];
    return row?.completed === true;
  }

  async readSchoolCallRecordingsDue(limit: number): Promise<SchoolCallRecordingDue[]> {
    return (await this.query<{ call_id: string; recording_sid: string; account_sid: string | null }>('SELECT * FROM hon.read_school_call_recordings_due($1::integer)', [limit]))
      .map(row => ({ callId: row.call_id, recordingSid: row.recording_sid, accountSid: row.account_sid }));
  }

  async markSchoolCallRecordingDeleted(callId: string, recordingSid: string): Promise<boolean> {
    const row = (await this.query<{ deleted: boolean }>('SELECT hon.mark_school_call_recording_deleted($1::uuid, $2) AS deleted', [callId, recordingSid]))[0];
    return row?.deleted === true;
  }

  async connectHqClientCall(callId: string, identity: string, callSid: string): Promise<HqClientCallDecision> {
    const row = (await this.query<{ outcome: HqClientCallDecision['outcome']; to_e164: string | null; caller_id_e164: string | null }>(
      'SELECT * FROM hon.connect_hq_client_call($1::uuid, $2, $3)', [callId, identity, callSid]))[0];
    if (!row) throw new Error('HQ_CALL_NOT_DECIDED');
    return { outcome: row.outcome, toE164: row.to_e164, callerIdE164: row.caller_id_e164 };
  }

  async routeHqIncomingCall(to: string, from: string | null, callSid: string): Promise<HqIncomingCallRoute> {
    const row = (await this.query<{ outcome: HqIncomingCallRoute['outcome']; call_id: string | null; identities: string[] | null; voicemail_greeting: string | null }>(
      'SELECT * FROM hon.route_hq_incoming_call($1, $2, $3)', [to, from, callSid]))[0];
    if (!row) throw new Error('HQ_CALL_NOT_ROUTED');
    return { outcome: row.outcome, callId: row.call_id, identities: row.identities ?? [], voicemailGreeting: row.voicemail_greeting };
  }

  async recordHqCallStatus(callSid: string, status: SchoolCallProviderStatus, answeredIdentity: string | null, durationSeconds: number | null, occurredAt: string) {
    const row = (await this.query<{ outcome: 'RECORDED' | 'IGNORED' | 'UNKNOWN_CALL'; status: string | null }>(
      'SELECT * FROM hon.record_hq_call_status($1, $2, $3, $4, $5::timestamptz)', [callSid, status, answeredIdentity, durationSeconds, occurredAt]))[0];
    if (!row) throw new Error('HQ_CALL_STATUS_NOT_RECORDED');
    return { outcome: row.outcome, status: row.status };
  }

  async recordHqCallVoicemail(callSid: string, recordingSid: string, seconds: number) {
    const row = (await this.query<{ outcome: 'RECORDED' | 'REPLAYED' | 'REFUSED' | 'UNKNOWN_CALL'; call_id: string | null }>(
      'SELECT * FROM hon.record_hq_call_voicemail($1, $2, $3)', [callSid, recordingSid, seconds]))[0];
    if (!row) throw new Error('HQ_CALL_VOICEMAIL_NOT_RECORDED');
    return { outcome: row.outcome, callId: row.call_id };
  }

  async readHqVoiceApp(): Promise<HqVoiceAppKey | null> {
    const row = (await this.query<{ twiml_app_sid: string; api_key_sid: string; sealed_api_secret: string; vault_key_id: string }>('SELECT * FROM hon.read_hq_voice_app()', []))[0];
    return row ? { twimlAppSid: row.twiml_app_sid, apiKeySid: row.api_key_sid, sealedApiSecret: row.sealed_api_secret, vaultKeyId: row.vault_key_id } : null;
  }

  async hqNeedsVoiceApp(): Promise<boolean> {
    return (await this.query<{ needed: boolean }>('SELECT hon.hq_needs_voice_app() AS needed', []))[0]?.needed === true;
  }

  async beginHqVoiceApp(leaseSeconds: number): Promise<SchoolVoiceAppClaim> {
    const row = (await this.query<{ state: SchoolVoiceAppClaim['state']; twiml_app_sid: string | null; claim_token: string | null }>(
      'SELECT * FROM hon.begin_hq_voice_app($1::integer)', [leaseSeconds]))[0];
    if (!row) throw new Error('COMMUNICATION_VOICE_APP_NOT_CLAIMED');
    return { state: row.state, accountSid: null, twimlAppSid: row.twiml_app_sid, claimToken: row.claim_token };
  }

  async recordHqVoiceAppTwiml(claimToken: string, twimlAppSid: string): Promise<boolean> {
    return (await this.query<{ recorded: boolean }>('SELECT hon.record_hq_voice_app_twiml($1::uuid, $2) AS recorded', [claimToken, twimlAppSid]))[0]?.recorded === true;
  }

  async completeHqVoiceApp(claimToken: string, apiKeySid: string, sealedApiSecret: string, vaultKeyId: string): Promise<boolean> {
    return (await this.query<{ completed: boolean }>('SELECT hon.complete_hq_voice_app($1::uuid, $2, $3, $4) AS completed',
      [claimToken, apiKeySid, sealedApiSecret, vaultKeyId]))[0]?.completed === true;
  }

  async readHqCallRecordingsDue(limit: number): Promise<{ callId: string; recordingSid: string }[]> {
    return (await this.query<{ call_id: string; recording_sid: string }>('SELECT * FROM hon.read_hq_call_recordings_due($1::integer)', [limit]))
      .map(row => ({ callId: row.call_id, recordingSid: row.recording_sid }));
  }

  async markHqCallRecordingDeleted(callId: string, recordingSid: string): Promise<boolean> {
    return (await this.query<{ deleted: boolean }>('SELECT hon.mark_hq_call_recording_deleted($1::uuid, $2) AS deleted', [callId, recordingSid]))[0]?.deleted === true;
  }

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

  async claimSocialPostTargets(limit: number, leaseSeconds: number): Promise<ClaimedSocialPostTarget[]> {
    const rows = await this.query<{ target_id: string; lease_token: string; organization_id: string; school_id: string; platform: 'FACEBOOK' | 'INSTAGRAM' | 'GOOGLE_BUSINESS';
      provider_account_id: string; provider_profile_id: string | null; body: string; link_url: string | null }>(
      'SELECT * FROM hon.claim_school_social_post_targets($1, $2)', [limit, leaseSeconds]);
    return rows.map((row) => ({ targetId: row.target_id, leaseToken: row.lease_token, organizationId: row.organization_id, schoolId: row.school_id,
      platform: row.platform, providerAccountId: row.provider_account_id, providerProfileId: row.provider_profile_id, text: row.body, linkUrl: row.link_url }));
  }

  async recordSocialPostResult(targetId: string, leaseToken: string, outcome: 'PUBLISHED' | 'FAILED' | 'UNKNOWN', providerPostId: string | null) {
    const row = (await this.query<{ status: string; accepted: boolean }>('SELECT * FROM hon.record_school_social_post_result($1, $2, $3, $4, $5)',
      [targetId, leaseToken, outcome, outcome === 'PUBLISHED' ? providerPostId : null, outcome === 'FAILED' ? 'PROVIDER_REJECTED' : null]))[0];
    if (!row) throw new Error('COMMUNICATION_SOCIAL_POST_NOT_RECORDED');
    return { status: row.status, accepted: row.accepted };
  }

  async recordSocialPostEvent(event: ZernioSocialEventRecord) {
    const row = (await this.query<{ outcome: 'APPLIED' | 'IGNORED' | 'UNMATCHED' | 'REPLAYED' }>('SELECT * FROM hon.record_school_social_post_event($1, $2, $3, $4, $5)',
      [event.eventId, event.eventType, event.platform, event.providerAccountId, event.providerPostId]))[0];
    if (!row) throw new Error('COMMUNICATION_SOCIAL_EVENT_NOT_RECORDED');
    return { outcome: row.outcome };
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

  /** T2 (0352): approved number orders for ACTIVE, entitled schools, each under a fresh purchase lease. */
  async claimSchoolNumberPurchases(limit: number, leaseSeconds: number) {
    const rows = await this.query<{ order_id: string; lease_token: string; school_id: string; organization_id: string; phone_e164: string; attempt: number; outcome_unknown: boolean }>(
      'SELECT * FROM hon.claim_school_number_purchases($1, $2)', [limit, leaseSeconds]);
    return rows.map((r) => ({ orderId: r.order_id, leaseToken: r.lease_token, schoolId: r.school_id, organizationId: r.organization_id,
      phoneE164: r.phone_e164, attempt: r.attempt, outcomeUnknown: r.outcome_unknown }));
  }

  async recordSchoolNumberPurchase(result: SchoolNumberPurchaseResult) {
    const row = (await this.query<{ data: { status: string; version: number } }>('SELECT hon.record_school_number_purchase($1, $2, $3, $4, $5, $6, $7) AS data',
      [result.orderId, result.leaseToken, result.outcome, result.numberSid ?? null, result.serviceSid ?? null, result.accountSid ?? null, result.failureCode ?? null]))[0];
    if (!row?.data) throw new Error('NUMBER_PURCHASE_NOT_RECORDED');
    return row.data;
  }
  /** T3a (0553): approved A2P registrations to submit or check, each under a fresh lease, with the frozen facts. */
  async claimSchoolA2pRegistrations(limit: number, leaseSeconds: number): Promise<SchoolA2pClaim[]> {
    const rows = await this.query<{ registration_id: string; lease_token: string; school_id: string; organization_id: string; stage: string; attempt: number;
      outcome_unknown: boolean; account_sid: string; brand_type: SchoolA2pClaim['brandType']; use_case: SchoolA2pClaim['useCase']; draft: SchoolA2pClaim['draft'];
      business: SchoolA2pClaim['business']; customer_profile_sid: string | null; a2p_profile_sid: string | null; brand_sid: string | null; campaign_sid: string | null;
      messaging_service_sid: string | null }>('SELECT * FROM hon.claim_school_a2p_registrations($1, $2)', [limit, leaseSeconds]);
    return rows.map((r) => ({ registrationId: r.registration_id, leaseToken: r.lease_token, schoolId: r.school_id, organizationId: r.organization_id, stage: r.stage,
      attempt: r.attempt, outcomeUnknown: r.outcome_unknown, accountSid: r.account_sid, brandType: r.brand_type, useCase: r.use_case, draft: r.draft, business: r.business,
      customerProfileSid: r.customer_profile_sid, a2pProfileSid: r.a2p_profile_sid, brandSid: r.brand_sid, campaignSid: r.campaign_sid, messagingServiceSid: r.messaging_service_sid }));
  }

  async recordSchoolA2pProgress(result: SchoolA2pResult) {
    const row = (await this.query<{ data: { status: string; version: number } }>('SELECT hon.record_school_a2p_progress($1, $2, $3, $4::jsonb, $5, $6) AS data',
      [result.registrationId, result.leaseToken, result.outcome, JSON.stringify(result.sids), result.failureCode ?? null, result.waitSeconds ?? null]))[0];
    if (!row?.data) throw new Error('A2P_PROGRESS_NOT_RECORDED');
    return row.data;
  }

  async recordSocialInboxEvent(event: ZernioInboxEventRecord) {
    const row = (await this.query<{ outcome: SocialInboxEventOutcome }>('SELECT * FROM hon.record_school_social_inbox_event($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [event.eventId, event.eventType, event.platform, event.providerAccountId, event.providerConversationId, event.providerMessageId,
        event.providerPostId, event.participantName, event.text, event.occurredAt]))[0];
    if (!row) throw new Error('COMMUNICATION_SOCIAL_INBOX_EVENT_NOT_RECORDED');
    return { outcome: row.outcome };
  }
}
