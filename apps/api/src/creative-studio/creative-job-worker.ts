import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { CREATIVE_GENERATION_FORMATS, CREATIVE_PROVIDER_JOB_ID, type CreativeGenerationFormat, type SaasCreativeMediaKind } from '@hon/contracts';
import { runtimePoolOptions } from '../foundation/runtime-pool-options.js';
import { emitTelemetry } from '../observability/telemetry.js';
import {
  CREATIVE_PROVIDER_RUNTIME, CreativeProviderRuntimeError, isAsyncCreativeProviderRuntime, type CreativeProviderJob, type CreativeProviderRuntime,
} from './creative-provider-runtime.js';
import { thrownOutcome, unknownOutcome, verifiedOutcome, type CreativeOutcome } from './creative-outcome.js';
import { CREATIVE_MEDIA_INGEST, CreativeDownloadRetry, type CreativeMediaIngest, type StoredCreativeObject } from './media/creative-media-store.js';
import { CreativeMediaRejected } from './media/creative-media-inspect.js';

/** One leased job as claim_creative_provider_jobs (0354) returns it: never the prompt, school or requester. */
export interface ClaimedCreativeJob extends CreativeProviderJob { jobId: string; leaseToken: string; pollCount: number; deadlineAt: string }

export interface CreativeJobWorkerStore {
  isConfigured(): boolean;
  claim(limit: number, leaseSeconds: number): Promise<ClaimedCreativeJob[]>;
  recordPoll(jobId: string, leaseToken: string): Promise<{ status: string; nextPollAt: string }>;
  /** RECORDED, or REQUESTER_UNAVAILABLE / RESOLVED_ELSEWHERE when the answer is kept on the job for HQ. */
  recordResult(jobId: string, leaseToken: string, outcome: CreativeOutcome): Promise<{ status: string }>;
  /** C3 (0691): a provider success together with its stored files, one object per asset in order. */
  recordStoredResult(jobId: string, leaseToken: string, outcome: CreativeOutcome, objects: StoredCreativeObject[]): Promise<{ status: string }>;
}
export const CREATIVE_JOB_WORKER_STORE = Symbol('CREATIVE_JOB_WORKER_STORE');

const MEDIA: readonly string[] = ['IMAGE', 'VIDEO'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Connects as hon_communication_worker (HON_COMMUNICATION_WORKER_DATABASE_URL), the existing worker login, never as the
 * runtime or migration role. It can only execute the three 0354 job functions here; it is refused if it is a superuser,
 * bypasses RLS, inherits roles or is the runtime login.
 */
@Injectable()
export class CreativeJobWorkerDatabase implements CreativeJobWorkerStore, OnModuleDestroy {
  private pool: Pool | undefined;
  private posture: Promise<void> | undefined;
  isConfigured(): boolean { return Boolean(process.env.HON_COMMUNICATION_WORKER_DATABASE_URL); }
  async onModuleDestroy(): Promise<void> { await this.pool?.end(); this.pool = undefined; }

  private async query<T extends object>(sql: string, values: unknown[]): Promise<T[]> {
    const url = process.env.HON_COMMUNICATION_WORKER_DATABASE_URL;
    if (!url) throw new Error('COMMUNICATION_WORKER_NOT_CONFIGURED');
    if (process.env.HON_RUNTIME_DATABASE_URL === url || process.env.DATABASE_URL === url) throw new Error('COMMUNICATION_WORKER_ROLE_UNSAFE');
    if (!this.pool) {
      const pool = new Pool({ ...runtimePoolOptions(url), max: 2, application_name: 'hon-creative-job-worker' });
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

  async claim(limit: number, leaseSeconds: number): Promise<ClaimedCreativeJob[]> {
    const rows = await this.query<{ job_id: string; lease_token: string; provider_id: string; provider_job_id: string; model_code: string; operation_code: string;
      media_kind: string; units: number; format: string; poll_count: number; deadline_at: Date | string }>(
      'SELECT * FROM hon.claim_creative_provider_jobs($1, $2)', [limit, leaseSeconds]);
    return rows.map(r => ({ jobId: r.job_id, leaseToken: r.lease_token, providerId: r.provider_id, providerJobId: r.provider_job_id, modelCode: r.model_code,
      operationCode: r.operation_code, mediaKind: r.media_kind as SaasCreativeMediaKind, units: r.units, format: r.format as CreativeGenerationFormat,
      pollCount: r.poll_count, deadlineAt: new Date(r.deadline_at).toISOString() }));
  }
  async recordPoll(jobId: string, leaseToken: string): Promise<{ status: string; nextPollAt: string }> {
    const rows = await this.query<{ data: { status: string; nextPollAt: string } }>('SELECT hon.record_creative_provider_job_poll($1::uuid, $2::uuid) AS data', [jobId, leaseToken]);
    return rows[0]!.data;
  }
  async recordResult(jobId: string, leaseToken: string, outcome: CreativeOutcome): Promise<{ status: string }> {
    const rows = await this.query<{ data: { status: string } }>('SELECT hon.record_creative_provider_job_result($1::uuid, $2::uuid, $3::jsonb) AS data',
      [jobId, leaseToken, JSON.stringify(outcome)]);
    return rows[0]!.data;
  }
  async recordStoredResult(jobId: string, leaseToken: string, outcome: CreativeOutcome, objects: StoredCreativeObject[]): Promise<{ status: string }> {
    const rows = await this.query<{ data: { status: string } }>('SELECT hon.record_creative_provider_job_stored_result($1::uuid, $2::uuid, $3::jsonb, $4::jsonb) AS data',
      [jobId, leaseToken, JSON.stringify(outcome), JSON.stringify(objects)]);
    return rows[0]!.data;
  }
}

/** What the worker learned from one poll: still running (null), a final answer, or a success with stored files. */
type JobAnswer = null | { outcome: CreativeOutcome; objects?: StoredCreativeObject[] };

export interface CreativeJobRunSummary { claimed: number; recorded: number; heldForHq: number; pending: number; errors: number }

/**
 * C1 (0354) worker: claim -> poll -> record, one job at a time. Deadlines are swept by the claim itself (UNKNOWN for HQ,
 * never resent). The provider is only ever asked about a job it already has; a poll error is PENDING until the deadline,
 * never a guessed outcome. The worker never sees a prompt, a school, a requester, a wallet or a credential.
 */
@Injectable()
export class CreativeJobWorker {
  constructor(
    @Inject(CREATIVE_JOB_WORKER_STORE) private readonly store: CreativeJobWorkerStore,
    @Inject(CREATIVE_PROVIDER_RUNTIME) private readonly provider: CreativeProviderRuntime,
    @Optional() @Inject(CREATIVE_MEDIA_INGEST) private readonly media?: CreativeMediaIngest,
  ) {}

  async runOnce(limit = 10, leaseSeconds = 120): Promise<CreativeJobRunSummary> {
    const summary: CreativeJobRunSummary = { claimed: 0, recorded: 0, heldForHq: 0, pending: 0, errors: 0 };
    if (!this.store.isConfigured()) return summary;
    const jobs = await this.store.claim(limit, leaseSeconds);
    summary.claimed = jobs.length;
    for (const job of jobs) {
      try {
        const answer = await this.ask(job);
        if (!answer) { await this.store.recordPoll(job.jobId, job.leaseToken); summary.pending += 1; continue; }
        const { status } = answer.objects
          ? await this.store.recordStoredResult(job.jobId, job.leaseToken, answer.outcome, answer.objects)
          : await this.store.recordResult(job.jobId, job.leaseToken, answer.outcome);
        if (status === 'RECORDED') summary.recorded += 1; else summary.heldForHq += 1;
      } catch {
        // A lost lease or a refused record: the job stays open and is claimed again (or swept at its deadline).
        summary.errors += 1;
      }
    }
    return summary;
  }

  /** The provider's final answer as a record, or null while it is still running (or cannot be asked right now). */
  private async ask(job: ClaimedCreativeJob): Promise<JobAnswer> {
    if (!UUID.test(job.jobId) || !UUID.test(job.leaseToken) || !CREATIVE_PROVIDER_JOB_ID.test(job.providerJobId) || !MEDIA.includes(job.mediaKind)
      || !(CREATIVE_GENERATION_FORMATS as readonly string[]).includes(job.format) || !Number.isSafeInteger(job.units) || job.units < 1) return null;
    if (!isAsyncCreativeProviderRuntime(this.provider) || this.provider.readiness() !== 'READY') return null;
    const { providerId, modelCode, providerJobId, operationCode, mediaKind, units, format } = job;
    let answer;
    try { answer = await this.provider.poll({ providerId, modelCode, providerJobId, operationCode, mediaKind, units, format }); }
    catch (error) {
      // Only a provider's explicit final answer closes the job. It was sent, so PRE_SEND is not an answer here.
      if (error instanceof CreativeProviderRuntimeError && (error.outcome === 'FAILED' || error.outcome === 'UNKNOWN')) return { outcome: thrownOutcome(error) };
      return null;
    }
    if (answer?.state === 'PENDING') return null;
    if (answer?.state !== 'DONE') return null;
    // A provider success is recorded only together with its files in HON's storage (0691): credits are never charged for
    // media HON does not hold. A success without files cannot be trusted (UNKNOWN for HQ).
    const claimed = verifiedOutcome(answer.result, { mediaKind, units });
    if (claimed.outcome !== 'SUCCEEDED') return { outcome: claimed };
    if (!answer.downloads?.length) return { outcome: unknownOutcome('UNVERIFIED_RESULT') };
    if (!this.media || this.media.readiness() !== 'READY') {
      // No storage yet: the job stays open and, at its deadline, becomes UNKNOWN for HQ.
      emitTelemetry('warn', 'creative.result_storage_unavailable', { component: 'creative-jobs' });
      return null;
    }
    let stored;
    try { stored = await this.media.ingest({ jobId: job.jobId, mediaKind }, answer.downloads, claimed.assets!); }
    catch (error) {
      if (error instanceof CreativeMediaRejected) {
        emitTelemetry('warn', 'creative.result_file_rejected', { component: 'creative-jobs', message: error.why });
        return { outcome: unknownOutcome('UNVERIFIED_RESULT') };
      }
      // A download that may work later, or a storage error: try again on the next poll (deadline still applies).
      emitTelemetry('warn', error instanceof CreativeDownloadRetry ? 'creative.result_download_retry' : 'creative.result_store_retry', { component: 'creative-jobs' });
      return null;
    }
    // The measured files decide. A video more than a second longer than reserved, or anything else out of bounds, is
    // held for HQ; a fraction of a second over is recorded at the reserved length.
    const assets = stored.assets.map(a => a.durationSeconds === null ? a : { ...a, durationSeconds: a.durationSeconds > units + 1 ? a.durationSeconds : Math.min(a.durationSeconds, units) });
    if (assets.some(a => a.durationSeconds !== null && a.durationSeconds > units)) return { outcome: unknownOutcome('UNVERIFIED_RESULT') };
    const measured = verifiedOutcome({ ...answer.result, assets }, { mediaKind, units });
    if (measured.outcome !== 'SUCCEEDED') return { outcome: measured };
    return { outcome: measured, objects: stored.objects };
  }
}

/**
 * Optional in-process loop. Off unless HON_COMMUNICATION_WORKER_DATABASE_URL and HON_CREATIVE_JOB_POLL_INTERVAL_SECONDS
 * (10-3600) are both set. One run at a time.
 */
@Injectable()
export class CreativeJobScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly worker: CreativeJobWorker) {}

  onModuleInit(): void {
    const raw = process.env.HON_CREATIVE_JOB_POLL_INTERVAL_SECONDS;
    if (!raw || !process.env.HON_COMMUNICATION_WORKER_DATABASE_URL) return;
    const seconds = Number(raw);
    if (!Number.isSafeInteger(seconds) || seconds < 10 || seconds > 3600) {
      emitTelemetry('error', 'creative.job_poll_interval_invalid', { component: 'creative-jobs' });
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
      if (summary.claimed) emitTelemetry('info', 'creative.jobs_polled', { component: 'creative-jobs', message: JSON.stringify(summary) });
    } catch {
      emitTelemetry('error', 'creative.jobs_failed', { component: 'creative-jobs' });
    } finally { this.running = false; }
  }
}
