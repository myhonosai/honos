import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { runtimePoolOptions } from '../../foundation/runtime-pool-options.js';
import { emitTelemetry } from '../../observability/telemetry.js';
import { SHOPIFY_APP, type ShopifyApp } from './shopify-adapter.js';
import { begunSync, runShopifySync, type SyncOutcome } from './shopify-sync-engine.js';
import type { VerifiedShopifyWebhook } from './shopify-webhook.js';

type Env = Record<string, string | undefined>;
export const SHOPIFY_WORKER_STORE = Symbol('SHOPIFY_WORKER_STORE');
export const SHOPIFY_WORKER_CLOCK = Symbol('SHOPIFY_WORKER_CLOCK');

export type ShopifyWebhookOutcome = 'SYNC_REQUESTED' | 'UNINSTALLED' | 'SHOP_ERASED' | 'NO_CUSTOMER_DATA' | 'IGNORED';
export interface ShopifyFinished { syncId: string; source: string; outcome: SyncOutcome; failureCode: string | null; connectionStatus: string }

/** The 0449 and 0470 worker functions. Each takes one closed JSON input and answers JSON. */
export interface ShopifyWorkerStore {
  isConfigured(): boolean;
  recordWebhook(input: VerifiedShopifyWebhook): Promise<{ outcome: ShopifyWebhookOutcome; replayed: boolean }>;
  claim(): Promise<unknown>;
  rotate(input: object): Promise<unknown>;
  page(input: object): Promise<unknown>;
  /** SH-F1 (0557): the Shopify Payments snapshot a leased run read. */
  finance(input: object): Promise<unknown>;
  finish(input: object): Promise<unknown>;
  /** 0470: deletes up to 2,000 mirrored orders placed more than 60 days ago (any store) and their lines. */
  purgeExpiredOrders(): Promise<{ orders: number; lines: number; more: boolean }>;
}

const SQL = {
  recordWebhook: 'SELECT hon.record_shopify_webhook($1::jsonb) AS data',
  claim: 'SELECT hon.claim_shopify_background_sync() AS data',
  rotate: 'SELECT hon.rotate_shopify_background_credential($1::jsonb) AS data',
  page: 'SELECT hon.record_shopify_background_page($1::jsonb) AS data',
  finance: 'SELECT hon.record_shopify_background_finance($1::jsonb) AS data',
  finish: 'SELECT hon.finish_shopify_background_sync($1::jsonb) AS data',
  purge: 'SELECT hon.purge_expired_shopify_orders() AS data',
} as const;
export type ShopifyWorkerQuery = (sql: string, values: unknown[]) => Promise<{ data: unknown }[]>;

/** The worker store over any query function (the worker login in production; a proof's owner connection in tests). */
export class ShopifyWorkerSql implements ShopifyWorkerStore {
  constructor(private readonly query: ShopifyWorkerQuery, private readonly configured: () => boolean = () => true) {}
  isConfigured(): boolean { return this.configured(); }
  private async one(sql: string, values: unknown[]): Promise<unknown> { return (await this.query(sql, values))[0]?.data ?? null; }
  async recordWebhook(input: VerifiedShopifyWebhook) {
    const r = await this.one(SQL.recordWebhook, [JSON.stringify(input)]) as { outcome?: unknown; replayed?: unknown } | null;
    if (!r || typeof r.outcome !== 'string' || typeof r.replayed !== 'boolean') throw new Error('SHOPIFY_WORKER_ANSWER_INVALID');
    return { outcome: r.outcome as ShopifyWebhookOutcome, replayed: r.replayed };
  }
  claim() { return this.one(SQL.claim, []); }
  rotate(input: object) { return this.one(SQL.rotate, [JSON.stringify(input)]); }
  page(input: object) { return this.one(SQL.page, [JSON.stringify(input)]); }
  finance(input: object) { return this.one(SQL.finance, [JSON.stringify(input)]); }
  finish(input: object) { return this.one(SQL.finish, [JSON.stringify(input)]); }
  async purgeExpiredOrders() {
    const r = await this.one(SQL.purge, []) as { orders?: unknown; lines?: unknown; more?: unknown } | null;
    if (!r || !Number.isSafeInteger(r.orders) || !Number.isSafeInteger(r.lines) || typeof r.more !== 'boolean') throw new Error('SHOPIFY_WORKER_ANSWER_INVALID');
    return { orders: r.orders as number, lines: r.lines as number, more: r.more };
  }
}

/**
 * Connects as hon_communication_worker (HON_COMMUNICATION_WORKER_DATABASE_URL), the existing worker login, never as
 * the runtime or migration role, and only executes the 0449 and 0470 worker functions. Refused if the login is a superuser,
 * bypasses RLS, inherits roles or is the runtime login.
 */
@Injectable()
export class ShopifyWorkerDatabase extends ShopifyWorkerSql implements OnModuleDestroy {
  private pool: Pool | undefined;
  private posture: Promise<void> | undefined;
  constructor() {
    super((sql, values) => this.run(sql, values), () => Boolean(process.env.HON_COMMUNICATION_WORKER_DATABASE_URL));
  }
  async onModuleDestroy(): Promise<void> { await this.pool?.end(); this.pool = undefined; }
  private async run(sql: string, values: unknown[]): Promise<{ data: unknown }[]> {
    const url = process.env.HON_COMMUNICATION_WORKER_DATABASE_URL;
    if (!url) throw new Error('COMMUNICATION_WORKER_NOT_CONFIGURED');
    if (process.env.HON_RUNTIME_DATABASE_URL === url || process.env.DATABASE_URL === url) throw new Error('COMMUNICATION_WORKER_ROLE_UNSAFE');
    if (!this.pool) {
      const pool = new Pool({ ...runtimePoolOptions(url), max: 2, application_name: 'hon-shopify-worker' });
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
    return (await pool.query<{ data: unknown }>(sql, values)).rows;
  }
}

/** Background sync runs when the worker login and HON_SHOPIFY_SYNC_POLL_SECONDS (30-3600) are both set. */
export function shopifyBackgroundEnabled(env: Env): boolean {
  const seconds = Number(env.HON_SHOPIFY_SYNC_POLL_SECONDS);
  return Boolean(env.HON_COMMUNICATION_WORKER_DATABASE_URL) && Number.isSafeInteger(seconds) && seconds >= 30 && seconds <= 3600;
}

export interface ShopifyBackgroundSummary { claimed: number; succeeded: number; failed: number; needsReconnect: number; errors: number; purgedOrders: number }

/**
 * SH1b (0449) background sync: claim one due store, run the same sync as Sync now under the claim's lease, repeat up to
 * `limit` stores. The database decides which store is due and refuses any write without the lease. A run that breaks on
 * HON's side is closed as FAILED when it can be, else it is abandoned after 15 minutes and claimed again later.
 */
@Injectable()
export class ShopifyBackgroundSync {
  constructor(@Inject(SHOPIFY_WORKER_STORE) private readonly store: ShopifyWorkerStore,
    @Optional() @Inject(SHOPIFY_APP) private readonly app: ShopifyApp | null = null,
    @Optional() @Inject(SHOPIFY_WORKER_CLOCK) private readonly now: () => number = Date.now) {}

  async runOnce(limit = 5): Promise<ShopifyBackgroundSummary> {
    const summary: ShopifyBackgroundSummary = { claimed: 0, succeeded: 0, failed: 0, needsReconnect: 0, errors: 0, purgedOrders: 0 };
    const app = this.app;
    if (!app || !this.store.isConfigured()) return summary;
    // Retention first (0470): orders placed more than 60 days ago leave every store, connected or not. At most 5 batches a run.
    for (let i = 0; i < 5; i++) {
      try {
        const p = await this.store.purgeExpiredOrders();
        summary.purgedOrders += p.orders;
        if (!p.more) break;
      } catch { summary.errors += 1; break; }
    }
    for (let i = 0; i < limit; i++) {
      const claimed = await this.store.claim() as Record<string, unknown> | null;
      if (!claimed) break;
      summary.claimed += 1;
      const b = begunSync(claimed), leaseToken = claimed.leaseToken;
      if (!b || typeof leaseToken !== 'string') { summary.errors += 1; continue; }
      const lease = { syncId: b.syncId, leaseToken };
      try {
        const done = await runShopifySync(app, this.now, b, {
          rotate: body => this.store.rotate({ ...lease, ...body }),
          page: body => this.store.page({ ...lease, ...body }),
          finance: body => this.store.finance({ ...lease, ...body }),
          finish: async (outcome, failureCode) => {
            const r = await this.store.finish({ ...lease, outcome, failureCode }) as ShopifyFinished | null;
            if (!r || r.syncId !== b.syncId || r.outcome !== outcome) throw new Error('SHOPIFY_WORKER_ANSWER_INVALID');
            return r;
          },
        });
        if (done.outcome === 'SUCCEEDED') summary.succeeded += 1; else if (done.outcome === 'NEEDS_RECONNECT') summary.needsReconnect += 1; else summary.failed += 1;
      } catch {
        summary.errors += 1;
      }
    }
    return summary;
  }
}

/** Optional in-process loop: off unless shopifyBackgroundEnabled(env) and the Shopify app is configured. One run at a time. */
@Injectable()
export class ShopifyBackgroundScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly worker: ShopifyBackgroundSync, @Optional() @Inject(SHOPIFY_APP) private readonly app: ShopifyApp | null = null) {}

  onModuleInit(): void {
    if (!process.env.HON_SHOPIFY_SYNC_POLL_SECONDS || !this.app) return;
    if (!shopifyBackgroundEnabled(process.env)) {
      emitTelemetry('error', 'shopify.sync_poll_interval_invalid', { component: 'shopify-sync' });
      return;
    }
    this.timer = setInterval(() => { void this.tick(); }, Number(process.env.HON_SHOPIFY_SYNC_POLL_SECONDS) * 1000);
    this.timer.unref();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const summary = await this.worker.runOnce();
      if (summary.claimed || summary.purgedOrders) emitTelemetry('info', 'shopify.background_synced', { component: 'shopify-sync', message: JSON.stringify(summary) });
    } catch {
      emitTelemetry('error', 'shopify.background_sync_failed', { component: 'shopify-sync' });
    } finally { this.running = false; }
  }
}
