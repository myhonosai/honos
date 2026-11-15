import { Inject, Injectable } from '@nestjs/common';
import { COMMUNICATION_WORKER_STORE, type ClaimedSocialPostTarget, type CommunicationWorkerStore } from '../../communication/delivery/communication-worker-database.js';
import { SocialProviderError, ZERNIO_SOCIAL_ADAPTER, type ZernioSocialAdapter } from './zernio-social-adapter.js';

export interface SocialPublishSummary { claimed: number; published: number; failed: number; unknown: number; lateResults: number; ready: boolean }

const PUBLISH_TIMEOUT_MS = 20_000;
const LEASE_SECONDS = 60;
/** Small batches, so every publish of a batch (each bounded by PUBLISH_TIMEOUT_MS) finishes inside its lease. */
export const SOCIAL_PUBLISH_BATCH_SIZE = Math.max(1, Math.floor((LEASE_SECONDS * 1000 - 10_000) / PUBLISH_TIMEOUT_MS));

/**
 * 0348: publishes leased post targets through Zernio, outside any database transaction, and records each outcome.
 * Nothing is claimed unless publishing is READY (HON_ZERNIO_PUBLISH_APPROVED=true with a Zernio key, or the fake outside
 * production), so approved posts simply wait. Each target is sent at most once: a timeout, a lost answer or any
 * unexpected error is UNKNOWN, never retried; only a clear provider refusal is FAILED.
 */
@Injectable()
export class SocialPostDispatcher {
  constructor(
    @Inject(COMMUNICATION_WORKER_STORE) private readonly store: CommunicationWorkerStore,
    @Inject(ZERNIO_SOCIAL_ADAPTER) private readonly adapter: ZernioSocialAdapter,
  ) {}

  async runOnce(limit = 25): Promise<SocialPublishSummary> {
    const summary: SocialPublishSummary = { claimed: 0, published: 0, failed: 0, unknown: 0, lateResults: 0, ready: this.adapter.publishReady() };
    if (!summary.ready || !this.store.isConfigured() || !this.store.claimSocialPostTargets || !this.store.recordSocialPostResult) return summary;
    while (summary.claimed < limit) {
      const claimed = await this.store.claimSocialPostTargets(Math.min(SOCIAL_PUBLISH_BATCH_SIZE, limit - summary.claimed), LEASE_SECONDS);
      if (!claimed.length) break;
      summary.claimed += claimed.length;
      for (const target of claimed) await this.publish(target, summary);
    }
    return summary;
  }

  private async publish(target: ClaimedSocialPostTarget, summary: SocialPublishSummary): Promise<void> {
    let outcome: 'PUBLISHED' | 'FAILED' | 'UNKNOWN' = 'UNKNOWN', providerPostId: string | null = null;
    try {
      ({ providerPostId } = await withTimeout(this.adapter.publishPost({ profileId: target.providerProfileId, providerAccountId: target.providerAccountId,
        platform: target.platform, text: target.text, linkUrl: target.linkUrl, idempotencyKey: target.targetId }), PUBLISH_TIMEOUT_MS));
      outcome = 'PUBLISHED';
    } catch (error) {
      // Only a definite "not done" is FAILED. Everything else may have been published and is left for a receipt or a person.
      outcome = error instanceof SocialProviderError && ['REJECTED', 'RATE_LIMITED', 'NOT_ENABLED'].includes(error.failure) ? 'FAILED' : 'UNKNOWN';
    }
    const recorded = await this.store.recordSocialPostResult!(target.targetId, target.leaseToken, outcome, providerPostId);
    if (!recorded.accepted) summary.lateResults += 1;
    if (recorded.status === 'PUBLISHED') summary.published += 1;
    else if (recorded.status === 'FAILED') summary.failed += 1;
    else summary.unknown += 1;
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SocialProviderError('UNKNOWN')), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}
