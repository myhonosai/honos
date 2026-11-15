import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { runtimePoolOptions } from '../foundation/runtime-pool-options.js';
import { emitTelemetry } from '../observability/telemetry.js';

export interface AutomationEngineCounts { consumed: number; runsStarted: number; eventsFailed: number; ran: number; failed: number; exited: number; paused: number }

/**
 * Connects as hon_automation_worker (HON_AUTOMATION_WORKER_DATABASE_URL), never as the runtime, migration or communication
 * worker login. The role can only execute the two 0368 engine functions; it is refused if it is a superuser, bypasses RLS,
 * inherits roles or reuses another login's URL. Every action happens inside those database functions.
 */
@Injectable()
export class AutomationWorkerDatabase implements OnModuleDestroy {
  private pool: Pool | undefined;
  private posture: Promise<void> | undefined;

  isConfigured(): boolean { return Boolean(process.env.HON_AUTOMATION_WORKER_DATABASE_URL); }

  async onModuleDestroy(): Promise<void> { await this.pool?.end(); this.pool = undefined; }

  private getPool(): Pool {
    const url = process.env.HON_AUTOMATION_WORKER_DATABASE_URL;
    if (!url) throw new Error('AUTOMATION_WORKER_NOT_CONFIGURED');
    if ([process.env.HON_RUNTIME_DATABASE_URL, process.env.DATABASE_URL, process.env.HON_COMMUNICATION_WORKER_DATABASE_URL].includes(url)) {
      throw new Error('AUTOMATION_WORKER_ROLE_UNSAFE');
    }
    if (!this.pool) {
      const pool = new Pool({ ...runtimePoolOptions(url), max: 1, application_name: 'hon-automation-worker' });
      pool.on('error', () => undefined);
      this.pool = pool;
    }
    return this.pool;
  }

  private async call(fn: 'consume_automation_events' | 'run_due_automation_steps', limit: number): Promise<Record<string, unknown>> {
    const pool = this.getPool();
    this.posture ??= (async () => {
      const role = (await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean }>(
        'SELECT rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = current_user')).rows[0];
      if (!role || role.rolsuper || role.rolbypassrls || role.rolinherit) throw new Error('AUTOMATION_WORKER_ROLE_UNSAFE');
    })();
    try { await this.posture; } catch (error) { this.posture = undefined; throw error; }
    const rows = (await pool.query<{ data: Record<string, unknown> }>(`SELECT hon.${fn}($1::integer) AS data`, [limit])).rows;
    if (rows.length !== 1 || !rows[0]!.data || typeof rows[0]!.data !== 'object') throw new Error('AUTOMATION_ENGINE_UNVERIFIED');
    return rows[0]!.data;
  }

  async runOnce(limit = 100): Promise<AutomationEngineCounts> {
    const count = (o: Record<string, unknown>, k: string): number => {
      const v = o[k];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error('AUTOMATION_ENGINE_UNVERIFIED');
      return v;
    };
    const events = await this.call('consume_automation_events', limit);
    const steps = await this.call('run_due_automation_steps', limit);
    return { consumed: count(events, 'consumed'), runsStarted: count(events, 'runsStarted'), eventsFailed: count(events, 'failed'), ran: count(steps, 'ran'),
      failed: count(steps, 'failed'), exited: count(steps, 'exited'), paused: count(steps, 'paused') };
  }
}

/**
 * Optional in-process loop. Off unless HON_AUTOMATION_WORKER_DATABASE_URL and HON_AUTOMATION_ENGINE_INTERVAL_SECONDS (15-3600)
 * are both set. One run at a time; a failed tick is reported by name only and retried on the next tick.
 */
@Injectable()
export class AutomationEngineScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly worker: AutomationWorkerDatabase) {}

  onModuleInit(): void {
    const raw = process.env.HON_AUTOMATION_ENGINE_INTERVAL_SECONDS;
    if (!raw || !this.worker.isConfigured()) return;
    const seconds = Number(raw);
    if (!Number.isSafeInteger(seconds) || seconds < 15 || seconds > 3600) {
      emitTelemetry('error', 'automation.engine_interval_invalid', { component: 'automation-engine' });
      return;
    }
    this.timer = setInterval(() => { void this.tick(); }, seconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async tick(): Promise<AutomationEngineCounts | undefined> {
    if (this.running) return undefined;
    this.running = true;
    try {
      const counts = await this.worker.runOnce();
      if (counts.consumed || counts.eventsFailed || counts.ran || counts.failed || counts.exited || counts.paused) {
        emitTelemetry('info', 'automation.engine_completed', { component: 'automation-engine', message: JSON.stringify(counts) });
      }
      return counts;
    } catch {
      emitTelemetry('error', 'automation.engine_failed', { component: 'automation-engine' });
      return undefined;
    } finally { this.running = false; }
  }
}
