import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { emitTelemetry } from '../../observability/telemetry.js';
import {
  COMMUNICATION_PROVIDER_ADAPTERS,
  CommunicationProviderError,
  type CommunicationProviderAdapter,
  type DeliverableChannel,
} from './communication-provider.js';
import {
  COMMUNICATION_WORKER_STORE,
  type CommunicationSendResult,
  type CommunicationWorkerStore,
} from './communication-worker-database.js';
import { MissedCallTextBackDispatcher } from './missed-call-text-back.js';

export interface DispatchSummary {
  claimed: number;
  accepted: number;
  retrying: number;
  failed: number;
  unknown: number;
  lateResults: number;
  readyChannels: DeliverableChannel[];
}

const SEND_TIMEOUT_MS = 20_000;
const LEASE_SECONDS = 60;
/** Claim in small batches so every send of a batch (each bounded by SEND_TIMEOUT_MS) finishes inside its lease. */
export const DISPATCH_BATCH_SIZE = Math.max(1, Math.floor((LEASE_SECONDS * 1000 - 10_000) / SEND_TIMEOUT_MS));

/**
 * Sends leased deliveries through the one READY adapter per channel, outside any database transaction,
 * and records each outcome. A channel with no READY adapter is never claimed, so its messages stay
 * QUEUED with no delivery record. A timeout or unexpected error is UNKNOWN, never success or retry.
 */
@Injectable()
export class CommunicationDispatcher {
  constructor(
    @Inject(COMMUNICATION_WORKER_STORE) private readonly store: CommunicationWorkerStore,
    @Inject(COMMUNICATION_PROVIDER_ADAPTERS) private readonly adapters: readonly CommunicationProviderAdapter[],
  ) {}

  readyAdapters(): Map<DeliverableChannel, CommunicationProviderAdapter> {
    const ready = new Map<DeliverableChannel, CommunicationProviderAdapter>();
    for (const adapter of this.adapters) {
      if (!ready.has(adapter.channel) && adapter.readiness() === 'READY') ready.set(adapter.channel, adapter);
    }
    return ready;
  }

  async runOnce(limit = 25): Promise<DispatchSummary> {
    const ready = this.readyAdapters();
    const readyChannels = [...ready.keys()].sort();
    const summary: DispatchSummary = { claimed: 0, accepted: 0, retrying: 0, failed: 0, unknown: 0, lateResults: 0, readyChannels };
    if (!readyChannels.length || !this.store.isConfigured()) return summary;
    while (summary.claimed < limit) {
      const claimed = await this.store.claim(readyChannels, Math.min(DISPATCH_BATCH_SIZE, limit - summary.claimed), LEASE_SECONDS);
      if (!claimed.length) break;
      summary.claimed += claimed.length;
      await this.sendBatch(claimed, ready, summary);
    }
    return summary;
  }

  private async sendBatch(claimed: Awaited<ReturnType<CommunicationWorkerStore['claim']>>, ready: Map<DeliverableChannel, CommunicationProviderAdapter>, summary: DispatchSummary): Promise<void> {
    for (const delivery of claimed) {
      // Only READY channels are claimed, so the adapter exists.
      const adapter = ready.get(delivery.channel)!;
      let result: CommunicationSendResult;
      try {
        const accepted = await withTimeout(adapter.send({
          deliveryId: delivery.deliveryId, messageId: delivery.messageId, organizationId: delivery.organizationId,
          schoolId: delivery.schoolId, channel: delivery.channel, recipientAddress: delivery.recipientAddress,
          content: delivery.content, schoolName: delivery.schoolName, attempt: delivery.attempt,
          senderAddress: delivery.senderAddress, senderServiceId: delivery.senderServiceId,
        }), SEND_TIMEOUT_MS);
        result = { outcome: 'ACCEPTED', provider: adapter.provider, ...accepted };
      } catch (error) {
        result = error instanceof CommunicationProviderError
          ? { outcome: error.outcome, provider: adapter.provider,
              ...(error.outcome === 'FAILED' ? { failureCode: error.failureCode } : {}),
              ...(error.outcome === 'RETRYABLE' && error.retryAfterSeconds ? { retryAfterSeconds: Math.min(86_400, Math.max(30, error.retryAfterSeconds)) } : {}) }
          : { outcome: 'UNKNOWN', provider: adapter.provider };
      }
      const recorded = await this.store.recordResult(delivery.deliveryId, delivery.leaseToken, result);
      if (!recorded.accepted) summary.lateResults += 1;
      if (recorded.status === 'ACCEPTED') summary.accepted += 1;
      else if (recorded.status === 'PENDING') summary.retrying += 1;
      else if (recorded.status === 'FAILED') summary.failed += 1;
      else summary.unknown += 1;
    }
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CommunicationProviderError('UNKNOWN')), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * Optional in-process loop. Off unless HON_COMMUNICATION_WORKER_DATABASE_URL and
 * HON_COMMUNICATION_DISPATCH_INTERVAL_SECONDS (15-3600) are both set. One run at a time.
 */
@Injectable()
export class CommunicationDispatchScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly dispatcher: CommunicationDispatcher, @Optional() private readonly missedCalls?: MissedCallTextBackDispatcher) {}

  onModuleInit(): void {
    const raw = process.env.HON_COMMUNICATION_DISPATCH_INTERVAL_SECONDS;
    if (!raw || !process.env.HON_COMMUNICATION_WORKER_DATABASE_URL) return;
    const seconds = Number(raw);
    if (!Number.isSafeInteger(seconds) || seconds < 15 || seconds > 3600) {
      emitTelemetry('error', 'communication.dispatch_interval_invalid', { component: 'communication-dispatch' });
      return;
    }
    this.timer = setInterval(() => { void this.tick(); }, seconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const summary = await this.dispatcher.runOnce();
      if (summary.claimed) emitTelemetry('info', 'communication.dispatch_completed', { component: 'communication-dispatch', message: JSON.stringify(summary) });
      const missed = await this.missedCalls?.runOnce();
      if (missed?.claimed) emitTelemetry('info', 'communication.missed_call_text_back_completed', { component: 'communication-dispatch', message: JSON.stringify(missed) });
    } catch {
      emitTelemetry('error', 'communication.dispatch_failed', { component: 'communication-dispatch' });
    } finally { this.running = false; }
  }
}
