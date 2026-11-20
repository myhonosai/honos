import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { isParentPushToken } from '@hon/contracts';
import { runtimePoolOptions } from '../foundation/runtime-pool-options.js';
import { emitTelemetry } from '../observability/telemetry.js';
import {
  EXPO_PUSH_TRANSPORT, EXPO_RECEIPT_BATCH, EXPO_SEND_BATCH, type ExpoPushTransport, type ExpoReceiptOutcome, type ExpoSendOutcome,
} from './expo-push-client.js';

/** One leased delivery as claim_parent_push_deliveries (0601) returns it: a token, the school name and the title only. */
export interface ClaimedParentPush { deliveryId: string; leaseToken: string; expoToken: string; title: string; body: string; announcementId: string; attempts: number }
export interface ClaimedParentPushReceipt { deliveryId: string; leaseToken: string; ticketId: string }

export interface ParentPushWorkerStore {
  isConfigured(): boolean;
  claim(limit: number, leaseSeconds: number): Promise<ClaimedParentPush[]>;
  recordSend(deliveryId: string, leaseToken: string, outcome: ExpoSendOutcome): Promise<{ recorded: boolean }>;
  claimReceipts(limit: number, leaseSeconds: number): Promise<ClaimedParentPushReceipt[]>;
  recordReceipt(deliveryId: string, leaseToken: string, outcome: ExpoReceiptOutcome): Promise<{ recorded: boolean }>;
}
export const PARENT_PUSH_WORKER_STORE = Symbol('PARENT_PUSH_WORKER_STORE');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Connects as hon_communication_worker (HON_COMMUNICATION_WORKER_DATABASE_URL), never as the runtime or migration role.
 * It can execute only the four 0601 worker functions; it is refused if it is a superuser, bypasses RLS, inherits roles or
 * is the runtime login.
 */
@Injectable()
export class ParentPushWorkerDatabase implements ParentPushWorkerStore, OnModuleDestroy {
  private pool: Pool | undefined;
  private posture: Promise<void> | undefined;
  isConfigured(): boolean { return Boolean(process.env.HON_COMMUNICATION_WORKER_DATABASE_URL); }
  async onModuleDestroy(): Promise<void> { await this.pool?.end(); this.pool = undefined; }

  private async query<T extends object>(sql: string, values: unknown[]): Promise<T[]> {
    const url = process.env.HON_COMMUNICATION_WORKER_DATABASE_URL;
    if (!url) throw new Error('COMMUNICATION_WORKER_NOT_CONFIGURED');
    if (process.env.HON_RUNTIME_DATABASE_URL === url || process.env.DATABASE_URL === url) throw new Error('COMMUNICATION_WORKER_ROLE_UNSAFE');
    if (!this.pool) {
      const pool = new Pool({ ...runtimePoolOptions(url), max: 2, application_name: 'hon-parent-push-worker' });
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

  async claim(limit: number, leaseSeconds: number): Promise<ClaimedParentPush[]> {
    const rows = await this.query<{ delivery_id: string; lease_token: string; expo_token: string; title: string; body: string; announcement_id: string; attempts: number }>(
      'SELECT * FROM hon.claim_parent_push_deliveries($1, $2)', [limit, leaseSeconds]);
    return rows.map(r => ({ deliveryId: r.delivery_id, leaseToken: r.lease_token, expoToken: r.expo_token, title: r.title, body: r.body,
      announcementId: r.announcement_id, attempts: r.attempts }));
  }
  async recordSend(deliveryId: string, leaseToken: string, outcome: ExpoSendOutcome): Promise<{ recorded: boolean }> {
    const rows = await this.query<{ data: { recorded: boolean } }>('SELECT hon.record_parent_push_send($1::uuid, $2::uuid, $3::jsonb) AS data',
      [deliveryId, leaseToken, JSON.stringify(outcome)]);
    return { recorded: rows[0]?.data?.recorded === true };
  }
  async claimReceipts(limit: number, leaseSeconds: number): Promise<ClaimedParentPushReceipt[]> {
    const rows = await this.query<{ delivery_id: string; lease_token: string; ticket_id: string }>(
      'SELECT * FROM hon.claim_parent_push_receipts($1, $2)', [limit, leaseSeconds]);
    return rows.map(r => ({ deliveryId: r.delivery_id, leaseToken: r.lease_token, ticketId: r.ticket_id }));
  }
  async recordReceipt(deliveryId: string, leaseToken: string, outcome: ExpoReceiptOutcome): Promise<{ recorded: boolean }> {
    const rows = await this.query<{ data: { recorded: boolean } }>('SELECT hon.record_parent_push_receipt($1::uuid, $2::uuid, $3::jsonb) AS data',
      [deliveryId, leaseToken, JSON.stringify(outcome)]);
    return { recorded: rows[0]?.data?.recorded === true };
  }
}

export interface ParentPushRunSummary { claimed: number; sent: number; failed: number; unknown: number; retrying: number; receipts: number; delivered: number; errors: number }

/**
 * 0601 worker: claim -> send to Expo -> record, then claim receipts -> read -> record. Does nothing (not even claim, so
 * nothing is fanned out or skipped) unless the owner approved real sends. A send whose answer is lost is UNKNOWN and
 * is never sent again; a lost receipt answer is checked again later.
 */
@Injectable()
export class ParentPushWorker {
  constructor(
    @Inject(PARENT_PUSH_WORKER_STORE) private readonly store: ParentPushWorkerStore,
    @Inject(EXPO_PUSH_TRANSPORT) private readonly expo: ExpoPushTransport,
  ) {}

  async runOnce(limit = EXPO_SEND_BATCH, leaseSeconds = 120): Promise<ParentPushRunSummary> {
    const summary: ParentPushRunSummary = { claimed: 0, sent: 0, failed: 0, unknown: 0, retrying: 0, receipts: 0, delivered: 0, errors: 0 };
    if (!this.store.isConfigured() || this.expo.readiness() !== 'READY') return summary;
    const claimed = await this.store.claim(Math.min(limit, EXPO_SEND_BATCH), leaseSeconds);
    summary.claimed = claimed.length;
    const sendable = claimed.filter(c => UUID.test(c.deliveryId) && UUID.test(c.leaseToken) && UUID.test(c.announcementId) && isParentPushToken(c.expoToken)
      && typeof c.title === 'string' && c.title.length > 0 && typeof c.body === 'string' && c.body.length > 0);
    for (const bad of claimed.filter(c => !sendable.includes(c))) {
      await this.record(summary, bad, { outcome: 'FAILED', failureCode: 'UNVERIFIED_CLAIM' });
    }
    if (sendable.length) {
      let outcomes: ExpoSendOutcome[];
      try {
        outcomes = await this.expo.send(sendable.map(c => ({ to: c.expoToken, title: c.title, body: c.body, data: { type: 'school_announcement', announcementId: c.announcementId } })));
      } catch { outcomes = sendable.map(() => ({ outcome: 'UNKNOWN', failureCode: 'NO_ANSWER' })); }
      if (outcomes.length !== sendable.length) outcomes = sendable.map(() => ({ outcome: 'UNKNOWN', failureCode: 'UNVERIFIED_ANSWER' }));
      for (let i = 0; i < sendable.length; i += 1) await this.record(summary, sendable[i]!, outcomes[i]!);
    }
    await this.checkReceipts(summary, leaseSeconds);
    return summary;
  }

  private async record(summary: ParentPushRunSummary, claim: ClaimedParentPush, outcome: ExpoSendOutcome): Promise<void> {
    try {
      const { recorded } = await this.store.recordSend(claim.deliveryId, claim.leaseToken, outcome);
      if (!recorded) { summary.errors += 1; return; }
      if (outcome.outcome === 'SENT') summary.sent += 1;
      else if (outcome.outcome === 'FAILED') summary.failed += 1;
      else if (outcome.outcome === 'UNKNOWN') summary.unknown += 1;
      else summary.retrying += 1;
    } catch {
      // The lease runs out and the claim records it UNKNOWN: it is never sent twice.
      summary.errors += 1;
    }
  }

  private async checkReceipts(summary: ParentPushRunSummary, leaseSeconds: number): Promise<void> {
    const due = (await this.store.claimReceipts(EXPO_RECEIPT_BATCH, leaseSeconds)).filter(r => UUID.test(r.deliveryId) && UUID.test(r.leaseToken));
    summary.receipts = due.length;
    if (!due.length) return;
    let answers: Map<string, ExpoReceiptOutcome>;
    try { answers = await this.expo.receipts(due.map(r => r.ticketId)); } catch { answers = new Map(); }
    for (const receipt of due) {
      const outcome = answers.get(receipt.ticketId) ?? { outcome: 'PENDING' };
      try {
        const { recorded } = await this.store.recordReceipt(receipt.deliveryId, receipt.leaseToken, outcome);
        if (recorded && outcome.outcome === 'DELIVERED') summary.delivered += 1;
        if (!recorded) summary.errors += 1;
      } catch { summary.errors += 1; }
    }
  }
}

/**
 * Optional in-process loop. Off unless HON_PARENT_PUSH_APPROVED=true, HON_COMMUNICATION_WORKER_DATABASE_URL and
 * HON_PARENT_PUSH_INTERVAL_SECONDS (10-3600) are all set. One run at a time.
 */
@Injectable()
export class ParentPushScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly worker: ParentPushWorker) {}

  onModuleInit(): void {
    const raw = process.env.HON_PARENT_PUSH_INTERVAL_SECONDS;
    if (!raw || process.env.HON_PARENT_PUSH_APPROVED !== 'true' || !process.env.HON_COMMUNICATION_WORKER_DATABASE_URL) return;
    const seconds = Number(raw);
    if (!Number.isSafeInteger(seconds) || seconds < 10 || seconds > 3600) {
      emitTelemetry('error', 'parent_push.interval_invalid', { component: 'parent-push' });
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
      const summary = await this.worker.runOnce();
      if (summary.claimed || summary.receipts) emitTelemetry('info', 'parent_push.run', { component: 'parent-push', message: JSON.stringify(summary) });
    } catch {
      emitTelemetry('error', 'parent_push.run_failed', { component: 'parent-push' });
    } finally { this.running = false; }
  }
}
