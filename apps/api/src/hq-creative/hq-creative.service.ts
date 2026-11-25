import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  CREATIVE_GENERATION_LIMITS, saasUuid, validateHqCreativeBudgetInput, validateHqCreativeBudgetReceipt,
  validateHqCreativeGeneration, validateHqCreativeGenerationInput, validateHqCreativeGenerationReceipt, validateHqCreativeResolveInput,
  validateHqCreativeStudio, validateHqCreativeStudioRecords,
  type HqCreativeGeneration, type HqCreativeGenerationReceipt, type HqCreativeStudio,
} from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';
import { CREATIVE_PROVIDER_RUNTIME, type CreativeProviderRoute, type CreativeProviderRuntime } from '../creative-studio/creative-provider-runtime.js';
import { thrownOutcome, unknownOutcome, verifiedOutcome, type CreativeOutcome } from '../creative-studio/creative-outcome.js';

function parse<T>(work: () => T): T {
  try { return work(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); }
}

/**
 * What the database records for a provider outcome (0253 record_hq_creative_generation_result, same shape as 0216). The
 * school studio's verification is reused, so the cost basis (0637) travels with every cost and 0651 stores it.
 */
type Outcome = CreativeOutcome;
const unknown = unknownOutcome;

/**
 * M2 HQ Creative Studio. HQ authority, the HQ credit cap, the platform creative pause, idempotency and immutability live in
 * the database (0253); this service validates closed inputs and outputs, makes the one provider call through the injected
 * runtime (unconfigured in production: 503 before any write) and records its outcome exactly once. It never retries a
 * provider call and never touches a school creative wallet.
 */
@Injectable()
export class HqCreativeService {
  constructor(
    private readonly billing: SaasBillingService,
    @Inject(CREATIVE_PROVIDER_RUNTIME) private readonly provider: CreativeProviderRuntime,
  ) {}

  private connected(): boolean { return this.provider.readiness() === 'READY'; }

  async studio(subject: string): Promise<HqCreativeStudio> {
    const records = await this.billing.call('readHqCreativeStudio', [subject], validateHqCreativeStudioRecords);
    try { return validateHqCreativeStudio({ provider: this.connected() ? 'CONNECTED' : 'NOT_CONNECTED', ...records }); }
    catch { throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' }); }
  }

  async read(subject: string, id: unknown): Promise<HqCreativeGeneration> {
    const generationId = parse(() => saasUuid(id));
    return this.billing.call('readHqCreativeGeneration', [subject, generationId], (v) => {
      const g = validateHqCreativeGeneration(v); if (g.generationId.toLowerCase() !== generationId.toLowerCase()) throw new Error('mismatch'); return g;
    });
  }

  async setBudget(subject: string, body: unknown, key: unknown) {
    const [input, k] = parse(() => [validateHqCreativeBudgetInput(body), saasUuid(key)] as const);
    return this.billing.call('setHqCreativeBudget', [subject, JSON.stringify(input), k], (v) => {
      const r = validateHqCreativeBudgetReceipt(v); if (r.budget.periodStart !== input.periodStart) throw new Error('mismatch'); return r;
    });
  }

  async resolve(subject: string, id: unknown, body: unknown, key: unknown) {
    const [generationId, input, k] = parse(() => [saasUuid(id), validateHqCreativeResolveInput(body), saasUuid(key)] as const);
    return this.billing.call('resolveHqCreativeGeneration', [subject, generationId, JSON.stringify(input), k], (v) => {
      const r = validateHqCreativeGenerationReceipt(v);
      if (r.generation.generationId.toLowerCase() !== generationId.toLowerCase()
        || r.generation.status !== (input.resolution === 'SUCCEEDED' ? 'RESOLVED_CHARGED' : 'RESOLVED_NOT_CHARGED')) throw new Error('mismatch');
      return r;
    });
  }

  /** Reserve -> one provider call -> record. The same key returns the same request and never calls the provider again. */
  async create(subject: string, body: unknown, key: unknown): Promise<HqCreativeGenerationReceipt> {
    const [input, idempotencyKey] = parse(() => [validateHqCreativeGenerationInput(body), saasUuid(key)] as const);
    const route: CreativeProviderRoute | null = this.connected() ? this.provider.route(input.operationCode) : null;
    if (!route) throw new ServiceUnavailableException({ code: 'CREATIVE_PROVIDER_NOT_CONNECTED' });
    const created = await this.billing.call('createHqCreativeGeneration',
      [subject, JSON.stringify(input), JSON.stringify({ providerId: route.providerId, modelCode: route.modelCode }), idempotencyKey],
      validateHqCreativeGenerationReceipt);
    const g = created.generation;
    if (created.replayed) return g.status === 'GENERATING' ? this.recoverInterrupted(subject, created) : created;
    if (g.status !== 'GENERATING') return created;
    return this.record(subject, g.generationId, await this.invoke(g, route));
  }

  /** A replay of a request that never got an answer recorded: after the in-flight window it is held for the HQ owner. */
  private async recoverInterrupted(subject: string, replay: HqCreativeGenerationReceipt): Promise<HqCreativeGenerationReceipt> {
    if (Date.now() - Date.parse(replay.generation.createdAt) < CREATIVE_GENERATION_LIMITS.interruptedAfterSeconds * 1000) return replay;
    try { return { ...(await this.record(subject, replay.generation.generationId, unknown('INTERRUPTED'))), replayed: true }; }
    catch (error) { if (error instanceof ConflictException) return replay; throw error; }
  }

  private async invoke(g: HqCreativeGeneration, route: CreativeProviderRoute): Promise<Outcome> {
    try {
      const result = await this.provider.generate({ ...route, providerRequestId: g.generationId, operationCode: g.operationCode, mediaKind: g.mediaKind,
        units: g.units, format: g.format, prompt: g.prompt });
      return verifiedOutcome(result, g);
    } catch (error) {
      return thrownOutcome(error);
    }
  }

  private record(subject: string, generationId: string, outcome: Outcome): Promise<HqCreativeGenerationReceipt> {
    return this.billing.call('recordHqCreativeGenerationResult', [subject, generationId, JSON.stringify(outcome)], validateHqCreativeGenerationReceipt);
  }
}
