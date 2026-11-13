import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CREATIVE_WEBSITE_LIMITS, CREATIVE_WEBSITE_PAGES, isCreativeWebsiteLine, isCreativeWebsiteSections, saasUuid, validateCreativeWebsiteDraft,
  validateCreativeWebsiteDraftInput, validateCreativeWebsiteDraftList, validateCreativeWebsiteDraftReceipt, validateCreativeWebsiteDraftRecords,
  type CreativeWebsiteDraft, type CreativeWebsiteDraftList, type CreativeWebsiteDraftReceipt,
} from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';
import { CreativeProviderRuntimeError, type CreativeProviderRoute } from './creative-provider-runtime.js';
import { WEBSITE_DRAFT_RUNTIME, type WebsiteDraftPageResult, type WebsiteDraftResult, type WebsiteDraftRuntime } from './website-draft-runtime.js';

function parse<T>(work: () => T): T {
  try { return work(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); }
}

/** What the database records for a provider outcome (0344 record_creative_website_draft_result). */
type Outcome = {
  outcome: 'SUCCEEDED' | 'FAILED' | 'NOT_SENT' | 'UNKNOWN'; providerCostMicrounits: number | null; failureReason: string | null;
  pages: WebsiteDraftPageResult[] | null;
};
const unknown = (failureReason: 'PROVIDER_UNKNOWN' | 'UNVERIFIED_RESULT' | 'INTERRUPTED'): Outcome =>
  ({ outcome: 'UNKNOWN', providerCostMicrounits: null, failureReason, pages: null });
const int = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const rank = (p: unknown) => (CREATIVE_WEBSITE_PAGES as readonly unknown[]).indexOf(p);

/** A provider result is trusted only if every page was requested, appears once in order, and is well-formed; else UNKNOWN. */
function verified(result: WebsiteDraftResult, d: CreativeWebsiteDraft): Outcome {
  const pages = result?.pages;
  const ok = result && int(result.providerCostMicrounits, 0, 999_999_999_999_999) && Array.isArray(pages) && pages.length >= 1 && pages.length <= d.pages.length
    && pages.every((p, i) => p && Object.keys(p).sort().join(',') === 'pageKey,sections,title' && d.pages.includes(p.pageKey)
      && (i === 0 || rank(p.pageKey) > rank(pages[i - 1]!.pageKey))
      && isCreativeWebsiteLine(p.title, CREATIVE_WEBSITE_LIMITS.titleCharacters) && isCreativeWebsiteSections(p.sections));
  if (!ok) return unknown('UNVERIFIED_RESULT');
  return { outcome: 'SUCCEEDED', providerCostMicrounits: result.providerCostMicrounits, failureReason: null,
    pages: pages.map(p => ({ pageKey: p.pageKey, title: p.title, sections: p.sections.map(s => ({ heading: s.heading, body: s.body })) })) };
}

/**
 * WB1 AI website drafts (0344). Authority, the S4 and R2 decisions, eligibility, the WEBSITE rate, the per-school wallet
 * lock, idempotency and audit all live in the database; this service validates closed inputs and outputs, makes the one
 * provider call through the injected runtime and records its outcome exactly once. It never retries a provider call,
 * never publishes a site and never charges the included AI team.
 */
@Injectable()
export class CreativeWebsiteService {
  constructor(
    private readonly billing: SaasBillingService,
    @Inject(WEBSITE_DRAFT_RUNTIME) private readonly provider: WebsiteDraftRuntime,
  ) {}

  private connected(): boolean { return this.provider.readiness() === 'READY'; }

  async list(subject: string, schoolId: unknown): Promise<CreativeWebsiteDraftList> {
    const school = parse(() => saasUuid(schoolId));
    const records = await this.billing.call('readCreativeWebsiteDrafts', [subject, school], validateCreativeWebsiteDraftRecords);
    try { return validateCreativeWebsiteDraftList({ provider: this.connected() ? 'CONNECTED' : 'NOT_CONNECTED', ...records }); }
    catch { throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' }); }
  }

  async read(subject: string, schoolId: unknown, draftId: unknown): Promise<CreativeWebsiteDraft> {
    const [school, draft] = parse(() => [saasUuid(schoolId), saasUuid(draftId)] as const);
    return this.billing.call('readCreativeWebsiteDraft', [subject, school, draft], validateCreativeWebsiteDraft);
  }

  /** Reserve -> one provider call -> record. The same key returns the same draft and never calls the provider again. */
  async create(subject: string, schoolId: unknown, body: unknown, key: unknown): Promise<CreativeWebsiteDraftReceipt> {
    const [school, input, idempotencyKey] = parse(() => [saasUuid(schoolId), validateCreativeWebsiteDraftInput(body), saasUuid(key)] as const);
    const route: CreativeProviderRoute | null = this.connected() ? this.provider.route(input.operationCode) : null;
    if (!route) throw new ServiceUnavailableException({ code: 'CREATIVE_PROVIDER_NOT_CONNECTED' });
    const created = await this.billing.call('createCreativeWebsiteDraft',
      [subject, school, JSON.stringify(input), JSON.stringify({ providerId: route.providerId, modelCode: route.modelCode }), idempotencyKey, randomUUID(), randomUUID()],
      validateCreativeWebsiteDraftReceipt);
    const d = created.draft;
    if (created.replayed) return d.status === 'GENERATING' ? this.recoverInterrupted(subject, created) : created;
    if (d.status !== 'GENERATING') return created;
    return this.record(subject, d.draftId, await this.invoke(d, route));
  }

  /** A replay of a request that never got an answer recorded: after the in-flight window the credits are held for HQ. */
  private async recoverInterrupted(subject: string, replay: CreativeWebsiteDraftReceipt): Promise<CreativeWebsiteDraftReceipt> {
    if (Date.now() - Date.parse(replay.draft.createdAt) < CREATIVE_WEBSITE_LIMITS.interruptedAfterSeconds * 1000) return replay;
    try { return { ...(await this.record(subject, replay.draft.draftId, unknown('INTERRUPTED'))), replayed: true }; }
    catch (error) { if (error instanceof ConflictException) return replay; throw error; }
  }

  private async invoke(d: CreativeWebsiteDraft, route: CreativeProviderRoute): Promise<Outcome> {
    try {
      return verified(await this.provider.draft({ ...route, providerRequestId: d.draftId, operationCode: d.operationCode, pages: d.pages, brief: d.brief }), d);
    } catch (error) {
      if (error instanceof CreativeProviderRuntimeError && error.outcome === 'PRE_SEND') {
        return { outcome: 'NOT_SENT', providerCostMicrounits: null, pages: null,
          failureReason: error.reason === 'INVALID_REQUEST' ? 'INVALID_REQUEST' : 'PROVIDER_NOT_CONNECTED' };
      }
      if (error instanceof CreativeProviderRuntimeError && error.outcome === 'FAILED') {
        const cost = error.providerCostMicrounits;
        return { outcome: 'FAILED', pages: null, failureReason: 'PROVIDER_REJECTED', providerCostMicrounits: int(cost, 0, 999_999_999_999_999) ? cost : null };
      }
      return unknown('PROVIDER_UNKNOWN');
    }
  }

  private record(subject: string, draftId: string, outcome: Outcome): Promise<CreativeWebsiteDraftReceipt> {
    return this.billing.call('recordCreativeWebsiteDraftResult', [subject, draftId, JSON.stringify(outcome)], validateCreativeWebsiteDraftReceipt);
  }
}
