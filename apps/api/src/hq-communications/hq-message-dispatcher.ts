import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { HQ_INBOUND_REPLIES, HQ_INBOUND_REPLY_KINDS, type HqInboundReplyKind } from '@hon/contracts';
import { runtimePoolOptions } from '../foundation/runtime-pool-options.js';
import { emitTelemetry } from '../observability/telemetry.js';
import {
  COMMUNICATION_PROVIDER_ADAPTERS,
  CommunicationProviderError,
  type CommunicationProviderAdapter,
  type CommunicationSendRequest,
  type DeliverableChannel,
} from '../communication/delivery/communication-provider.js';
import type { CommunicationSendResult, VerifiedProviderReceipt } from '../communication/delivery/communication-worker-database.js';
import type { DispatchSummary } from '../communication/delivery/communication-dispatcher.js';

/** One leased HQ delivery: the address and body exist only in memory for this one send. */
export interface ClaimedHqMessageDelivery {
  deliveryId: string; leaseToken: string; organizationId: string; schoolId: string; messageId: string; channel: DeliverableChannel;
  recipientAddress: string; content: string; senderRef: string; senderName: string; attempt: number;
}

/**
 * The request an adapter receives for an HQ send. It is the school request plus the HQ sender: `senderServiceId` (the HQ
 * Twilio Messaging Service SID, so MMS Converter applies) or `senderEmail` (the HQ from-address). `schoolName` carries
 * the HQ display name, so a message from HQ never reads as a message from the school.
 */
export type HqCommunicationSendRequest = CommunicationSendRequest & {
  origin: 'HQ'; senderServiceId?: string | undefined; senderEmail?: string | undefined; senderName: string;
};

/**
 * A real provider adapter is used for HQ only once it declares `hqSender: true`, meaning it sends from
 * `senderServiceId`/`senderEmail` when `origin` is 'HQ'. Until then HQ deliveries for that channel are never claimed,
 * so an HQ message can never go out from a school's sender. The fake provider sends nothing and needs no declaration.
 */
export function adapterSendsAsHq(adapter: CommunicationProviderAdapter): boolean {
  return adapter.provider === 'FAKE' || (adapter as { readonly hqSender?: unknown }).hqSender === true;
}

export interface HqMessageWorkerStore {
  isConfigured(): boolean;
  claim(channels: DeliverableChannel[], limit: number, leaseSeconds: number): Promise<ClaimedHqMessageDelivery[]>;
  recordResult(deliveryId: string, leaseToken: string, result: CommunicationSendResult): Promise<{ status: string; accepted: boolean }>;
  /** A verified provider receipt for an HQ delivery (SendGrid hon_purpose HQ, Twilio HQ status path). */
  recordReceipt?(receipt: VerifiedProviderReceipt): Promise<{ outcome: 'RECORDED' | 'REPLAYED' | 'UNMATCHED'; deliveryStatus: string | null }>;
}

/** One inbound text to the HQ number, as the webhook verified it. The body is classified in the database, never stored. */
export interface HqInboundText { provider: 'FAKE' | 'TWILIO'; eventId: string; from: string; toService: string; body: string; receivedAt: string }
export interface HqInboundOutcome { outcome: string; reply: HqInboundReplyKind | null; replyText: string | null; replayed: boolean }
export const HQ_MESSAGE_WORKER_STORE = Symbol('HQ_MESSAGE_WORKER_STORE');

const SEND_TIMEOUT_MS = 20_000;
const LEASE_SECONDS = 60;

/**
 * Connects as hon_communication_worker (HON_COMMUNICATION_WORKER_DATABASE_URL) and runs only the 0281 HQ worker
 * functions. Refused if the login is a superuser, bypasses RLS, inherits, or is the runtime or migration login.
 */
@Injectable()
export class HqMessageWorkerDatabase implements HqMessageWorkerStore, OnModuleDestroy {
  private pool: Pool | undefined;
  private posture: Promise<void> | undefined;
  isConfigured(): boolean { return Boolean(process.env.HON_COMMUNICATION_WORKER_DATABASE_URL); }
  async onModuleDestroy(): Promise<void> { await this.pool?.end(); this.pool = undefined; }

  private async query<T extends object>(sql: string, values: unknown[]): Promise<T[]> {
    const url = process.env.HON_COMMUNICATION_WORKER_DATABASE_URL;
    if (!url) throw new Error('COMMUNICATION_WORKER_NOT_CONFIGURED');
    if (process.env.HON_RUNTIME_DATABASE_URL === url || process.env.DATABASE_URL === url) throw new Error('COMMUNICATION_WORKER_ROLE_UNSAFE');
    if (!this.pool) {
      const pool = new Pool({ ...runtimePoolOptions(url), max: 2, application_name: 'hon-hq-communication-worker' });
      pool.on('error', () => undefined);
      this.pool = pool;
    }
    const pool = this.pool;
    this.posture ??= (async () => {
      const role = (await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean }>(
        'SELECT rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = current_user')).rows[0];
      if (!role || role.rolsuper || role.rolbypassrls || role.rolinherit) throw new Error('COMMUNICATION_WORKER_ROLE_UNSAFE');
    })();
    try { await this.posture; } catch (error) { this.posture = undefined; throw error; }
    return (await pool.query<T>(sql, values)).rows;
  }

  async claim(channels: DeliverableChannel[], limit: number, leaseSeconds: number): Promise<ClaimedHqMessageDelivery[]> {
    const rows = await this.query<{
      delivery_id: string; lease_token: string; organization_id: string; school_id: string; message_id: string; channel: DeliverableChannel;
      recipient_address: string; content: string; sender_ref: string; sender_name: string; attempt: number;
    }>('SELECT * FROM hon.claim_hq_message_deliveries($1::text[], $2, $3)', [channels, limit, leaseSeconds]);
    return rows.map((r) => ({
      deliveryId: r.delivery_id, leaseToken: r.lease_token, organizationId: r.organization_id, schoolId: r.school_id, messageId: r.message_id,
      channel: r.channel, recipientAddress: r.recipient_address, content: r.content, senderRef: r.sender_ref, senderName: r.sender_name, attempt: r.attempt,
    }));
  }

  /**
   * 0282 seam for the Twilio inbound webhook (comms thread): records STOP / START / HELP or a confirmation code sent to the
   * HQ Messaging Service, once per provider event, and returns the fixed reply to send back.
   */
  async recordInbound(text: HqInboundText): Promise<HqInboundOutcome> {
    const row = (await this.query<{ outcome: string; reply: string | null; replayed: boolean }>(
      'SELECT * FROM hon.record_hq_inbound_text($1, $2, $3, $4, $5, $6)', [text.provider, text.eventId, text.from, text.toService, text.body, text.receivedAt]))[0];
    if (!row) throw new Error('HQ_INBOUND_NOT_RECORDED');
    const reply = (HQ_INBOUND_REPLY_KINDS as readonly string[]).includes(row.reply ?? '') ? row.reply as HqInboundReplyKind : null;
    return { outcome: row.outcome, reply, replyText: reply ? HQ_INBOUND_REPLIES[reply] : null, replayed: row.replayed };
  }

  async recordResult(deliveryId: string, leaseToken: string, result: CommunicationSendResult) {
    const row = (await this.query<{ status: string; accepted: boolean }>(
      'SELECT * FROM hon.record_hq_message_send_result($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [deliveryId, leaseToken, result.outcome, result.provider, result.providerMessageId ?? null, result.sentAs ?? null,
        result.segments ?? null, result.encoding ?? null, result.failureCode ?? null, result.retryAfterSeconds ?? null]))[0];
    if (!row) throw new Error('HQ_MESSAGE_RESULT_NOT_RECORDED');
    return row;
  }

  async recordReceipt(receipt: VerifiedProviderReceipt) {
    const row = (await this.query<{ outcome: 'RECORDED' | 'REPLAYED' | 'UNMATCHED'; delivery_status: string | null }>(
      'SELECT * FROM hon.record_hq_message_provider_event($1, $2, $3, $4, $5, $6, $7)',
      [receipt.provider, receipt.providerEventId, receipt.providerMessageId, receipt.honDeliveryId ?? null, receipt.eventType,
        receipt.occurredAt, receipt.providerCostMicrounits ?? null]))[0];
    if (!row) throw new Error('HQ_MESSAGE_RECEIPT_NOT_RECORDED');
    return { outcome: row.outcome, deliveryStatus: row.delivery_status };
  }
}

/**
 * Sends leased HQ deliveries through the same READY adapters as school messages, outside any database transaction.
 * A channel with no READY adapter is never claimed. A timeout or unexpected error is UNKNOWN, never success or retry.
 */
@Injectable()
export class HqMessageDispatcher {
  constructor(
    @Inject(HQ_MESSAGE_WORKER_STORE) private readonly store: HqMessageWorkerStore,
    @Inject(COMMUNICATION_PROVIDER_ADAPTERS) private readonly adapters: readonly CommunicationProviderAdapter[],
  ) {}

  async runOnce(limit = 25): Promise<DispatchSummary> {
    const ready = new Map<DeliverableChannel, CommunicationProviderAdapter>();
    for (const adapter of this.adapters) if (!ready.has(adapter.channel) && adapterSendsAsHq(adapter) && adapter.readiness() === 'READY') ready.set(adapter.channel, adapter);
    const readyChannels = [...ready.keys()].sort();
    const summary: DispatchSummary = { claimed: 0, accepted: 0, retrying: 0, failed: 0, unknown: 0, lateResults: 0, readyChannels };
    if (!readyChannels.length || !this.store.isConfigured()) return summary;
    const claimed = await this.store.claim(readyChannels, limit, LEASE_SECONDS);
    summary.claimed = claimed.length;
    for (const d of claimed) {
      const adapter = ready.get(d.channel)!;
      const request: HqCommunicationSendRequest = {
        deliveryId: d.deliveryId, messageId: d.messageId, organizationId: d.organizationId, schoolId: d.schoolId, channel: d.channel,
        recipientAddress: d.recipientAddress, content: d.content, schoolName: d.senderName, attempt: d.attempt, origin: 'HQ', senderName: d.senderName,
        ...(d.channel === 'SMS' ? { senderServiceId: d.senderRef } : { senderEmail: d.senderRef }),
      };
      let result: CommunicationSendResult;
      try {
        const accepted = await withTimeout(adapter.send(request), SEND_TIMEOUT_MS);
        result = { outcome: 'ACCEPTED', provider: adapter.provider, ...accepted };
      } catch (error) {
        result = error instanceof CommunicationProviderError
          ? { outcome: error.outcome, provider: adapter.provider,
              ...(error.outcome === 'FAILED' ? { failureCode: error.failureCode } : {}),
              ...(error.outcome === 'RETRYABLE' && error.retryAfterSeconds ? { retryAfterSeconds: Math.min(86_400, Math.max(30, error.retryAfterSeconds)) } : {}) }
          : { outcome: 'UNKNOWN', provider: adapter.provider };
      }
      const recorded = await this.store.recordResult(d.deliveryId, d.leaseToken, result);
      if (!recorded.accepted) summary.lateResults += 1;
      if (recorded.status === 'ACCEPTED') summary.accepted += 1;
      else if (recorded.status === 'PENDING') summary.retrying += 1;
      else if (recorded.status === 'FAILED') summary.failed += 1;
      else summary.unknown += 1;
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

/** Optional in-process loop, on under the same two settings as the school dispatcher. One run at a time. */
@Injectable()
export class HqMessageDispatchScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly dispatcher: HqMessageDispatcher) {}
  onModuleInit(): void {
    const raw = process.env.HON_COMMUNICATION_DISPATCH_INTERVAL_SECONDS;
    if (!raw || !process.env.HON_COMMUNICATION_WORKER_DATABASE_URL) return;
    const seconds = Number(raw);
    if (!Number.isSafeInteger(seconds) || seconds < 15 || seconds > 3600) {
      emitTelemetry('error', 'hq_communication.dispatch_interval_invalid', { component: 'hq-communication-dispatch' });
      return;
    }
    this.timer = setInterval(() => { void this.tick(); }, seconds * 1000);
    this.timer.unref();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const summary = await this.dispatcher.runOnce();
      if (summary.claimed) emitTelemetry('info', 'hq_communication.dispatch_completed', { component: 'hq-communication-dispatch', message: JSON.stringify(summary) });
    } catch {
      emitTelemetry('error', 'hq_communication.dispatch_failed', { component: 'hq-communication-dispatch' });
    } finally { this.running = false; }
  }
}
