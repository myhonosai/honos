import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CREATIVE_ASSET_MEDIA_TYPES, CREATIVE_GENERATION_LIMITS, saasUuid, validateCreativeGeneration, validateCreativeGenerationInput,
  validateCreativeGenerationReceipt, validateCreativeGenerationRecords, validateCreativeStudioGenerationList,
  type CreativeGeneration, type CreativeGenerationReceipt, type CreativeStudioGenerationList,
} from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';
import {
  CREATIVE_PROVIDER_RUNTIME, CreativeProviderRuntimeError, type CreativeProviderRoute, type CreativeProviderRuntime, type CreativeResult,
} from './creative-provider-runtime.js';

function parse<T>(work: () => T): T {
  try { return work(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); }
}

/** What the database records for a provider outcome (0216 record_creative_generation_result). */
type Outcome = {
  outcome: 'SUCCEEDED' | 'FAILED' | 'NOT_SENT' | 'UNKNOWN'; finalUnits: number | null; providerCostMicrounits: number | null;
  failureReason: string | null; assets: CreativeResult['assets'] | null;
};
const unknown = (failureReason: 'PROVIDER_UNKNOWN' | 'UNVERIFIED_RESULT' | 'INTERRUPTED'): Outcome =>
  ({ outcome: 'UNKNOWN', finalUnits: null, providerCostMicrounits: null, failureReason, assets: null });
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
const int = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;

/** A provider result is trusted only if it fits the reservation exactly; anything else is recorded UNKNOWN for HQ review. */
function verified(result: CreativeResult, g: CreativeGeneration): Outcome {
  const assets = result?.assets;
  const types: readonly string[] = CREATIVE_ASSET_MEDIA_TYPES[g.mediaKind];
  const ok = result && int(result.finalUnits, 1, g.units) && int(result.providerCostMicrounits, 0, 999_999_999_999_999) && Array.isArray(assets)
    && assets.length >= 1 && assets.length <= (g.mediaKind === 'VIDEO' ? 1 : CREATIVE_GENERATION_LIMITS.maxAssets)
    && assets.every(a => a && Object.keys(a).sort().join(',') === 'durationSeconds,height,mediaType,providerAssetReference,width'
      && types.includes(a.mediaType) && int(a.width, 1, 8192) && int(a.height, 1, 8192)
      && (g.mediaKind === 'IMAGE' ? a.durationSeconds === null : int(a.durationSeconds, 1, 600))
      && typeof a.providerAssetReference === 'string' && REFERENCE.test(a.providerAssetReference));
  if (!ok) return unknown('UNVERIFIED_RESULT');
  return { outcome: 'SUCCEEDED', finalUnits: result.finalUnits, providerCostMicrounits: result.providerCostMicrounits, failureReason: null,
    assets: assets.map(a => ({ mediaType: a.mediaType, width: a.width, height: a.height, durationSeconds: a.durationSeconds, providerAssetReference: a.providerAssetReference })) };
}

/**
 * CS1 Creative Studio generation. Authority, the S4 pause and access decision, eligibility, rates, the per-school wallet
 * lock, idempotency and audit all live in the database (0202 + 0216); this service validates closed inputs and outputs,
 * makes the one provider call through the injected runtime and records its outcome exactly once. It never retries a
 * provider call, never charges the AI team and never touches the internal agent budget.
 */
@Injectable()
export class CreativeStudioService {
  constructor(
    private readonly billing: SaasBillingService,
    @Inject(CREATIVE_PROVIDER_RUNTIME) private readonly provider: CreativeProviderRuntime,
  ) {}

  private connected(): boolean { return this.provider.readiness() === 'READY'; }

  async list(subject: string, schoolId: unknown): Promise<CreativeStudioGenerationList> {
    const school = parse(() => saasUuid(schoolId));
    const records = await this.billing.call('readCreativeGenerations', [subject, school], validateCreativeGenerationRecords);
    try { return validateCreativeStudioGenerationList({ provider: this.connected() ? 'CONNECTED' : 'NOT_CONNECTED', ...records }); }
    catch { throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' }); }
  }

  async read(subject: string, schoolId: unknown, generationId: unknown): Promise<CreativeGeneration> {
    const [school, generation] = parse(() => [saasUuid(schoolId), saasUuid(generationId)] as const);
    return this.billing.call('readCreativeGeneration', [subject, school, generation], validateCreativeGeneration);
  }

  /** Reserve -> one provider call -> record. The same key returns the same generation and never calls the provider again. */
  async create(subject: string, schoolId: unknown, body: unknown, key: unknown): Promise<CreativeGenerationReceipt> {
    const [school, input, idempotencyKey] = parse(() => [saasUuid(schoolId), validateCreativeGenerationInput(body), saasUuid(key)] as const);
    const route: CreativeProviderRoute | null = this.connected() ? this.provider.route(input.operationCode) : null;
    if (!route) throw new ServiceUnavailableException({ code: 'CREATIVE_PROVIDER_NOT_CONNECTED' });
    const created = await this.billing.call('createCreativeGeneration',
      [subject, school, JSON.stringify(input), JSON.stringify({ providerId: route.providerId, modelCode: route.modelCode }), idempotencyKey, randomUUID(), randomUUID()],
      validateCreativeGenerationReceipt);
    const g = created.generation;
    if (created.replayed) return g.status === 'GENERATING' ? this.recoverInterrupted(subject, created) : created;
    if (g.status !== 'GENERATING') return created;
    return this.record(subject, g.generationId, await this.invoke(g, route));
  }

  /** A replay of a request that never got an answer recorded: after the in-flight window the credits are held for HQ. */
  private async recoverInterrupted(subject: string, replay: CreativeGenerationReceipt): Promise<CreativeGenerationReceipt> {
    if (Date.now() - Date.parse(replay.generation.createdAt) < CREATIVE_GENERATION_LIMITS.interruptedAfterSeconds * 1000) return replay;
    try { return { ...(await this.record(subject, replay.generation.generationId, unknown('INTERRUPTED'))), replayed: true }; }
    catch (error) { if (error instanceof ConflictException) return replay; throw error; }
  }

  private async invoke(g: CreativeGeneration, route: CreativeProviderRoute): Promise<Outcome> {
    try {
      const result = await this.provider.generate({ ...route, providerRequestId: g.generationId, operationCode: g.operationCode, mediaKind: g.mediaKind,
        units: g.units, format: g.format, prompt: g.prompt });
      return verified(result, g);
    } catch (error) {
      if (error instanceof CreativeProviderRuntimeError && error.outcome === 'PRE_SEND') {
        return { outcome: 'NOT_SENT', finalUnits: null, providerCostMicrounits: null, assets: null,
          failureReason: error.reason === 'INVALID_REQUEST' ? 'INVALID_REQUEST' : 'PROVIDER_NOT_CONNECTED' };
      }
      if (error instanceof CreativeProviderRuntimeError && error.outcome === 'FAILED') {
        const cost = error.providerCostMicrounits;
        return { outcome: 'FAILED', finalUnits: null, assets: null, failureReason: 'PROVIDER_REJECTED',
          providerCostMicrounits: int(cost, 0, 999_999_999_999_999) ? cost : null };
      }
      return unknown('PROVIDER_UNKNOWN');
    }
  }

  private record(subject: string, generationId: string, outcome: Outcome): Promise<CreativeGenerationReceipt> {
    return this.billing.call('recordCreativeGenerationResult', [subject, generationId, JSON.stringify(outcome)], validateCreativeGenerationReceipt);
  }
}
