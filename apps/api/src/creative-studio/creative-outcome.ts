import { CREATIVE_ASSET_MEDIA_TYPES, CREATIVE_GENERATION_LIMITS, type SaasCreativeMediaKind } from '@hon/contracts';
import { CreativeProviderRuntimeError, type CreativeResult } from './creative-provider-runtime.js';

/** What the database records for a provider outcome (0216 / 0354 record_creative_generation_result). */
export type CreativeOutcome = {
  outcome: 'SUCCEEDED' | 'FAILED' | 'NOT_SENT' | 'UNKNOWN'; finalUnits: number | null; providerCostMicrounits: number | null;
  failureReason: string | null; assets: CreativeResult['assets'] | null;
};
export const unknownOutcome = (failureReason: 'PROVIDER_UNKNOWN' | 'UNVERIFIED_RESULT' | 'INTERRUPTED'): CreativeOutcome =>
  ({ outcome: 'UNKNOWN', finalUnits: null, providerCostMicrounits: null, failureReason, assets: null });
export const notSentOutcome = (failureReason: 'INVALID_REQUEST' | 'PROVIDER_NOT_CONNECTED'): CreativeOutcome =>
  ({ outcome: 'NOT_SENT', finalUnits: null, providerCostMicrounits: null, failureReason, assets: null });
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
export const isBoundedInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;

/** A provider result is trusted only if it fits the reservation exactly; anything else is recorded UNKNOWN for HQ review. */
export function verifiedOutcome(result: CreativeResult, g: { mediaKind: SaasCreativeMediaKind; units: number }): CreativeOutcome {
  const assets = result?.assets;
  const types: readonly string[] = CREATIVE_ASSET_MEDIA_TYPES[g.mediaKind];
  const ok = result && isBoundedInt(result.finalUnits, 1, g.units) && isBoundedInt(result.providerCostMicrounits, 0, 999_999_999_999_999) && Array.isArray(assets)
    && assets.length >= 1 && assets.length <= (g.mediaKind === 'VIDEO' ? 1 : CREATIVE_GENERATION_LIMITS.maxAssets)
    && assets.every(a => a && Object.keys(a).sort().join(',') === 'durationSeconds,height,mediaType,providerAssetReference,width'
      && types.includes(a.mediaType) && isBoundedInt(a.width, 1, 8192) && isBoundedInt(a.height, 1, 8192)
      && (g.mediaKind === 'IMAGE' ? a.durationSeconds === null : isBoundedInt(a.durationSeconds, 1, 600))
      && typeof a.providerAssetReference === 'string' && REFERENCE.test(a.providerAssetReference));
  if (!ok) return unknownOutcome('UNVERIFIED_RESULT');
  return { outcome: 'SUCCEEDED', finalUnits: result.finalUnits, providerCostMicrounits: result.providerCostMicrounits, failureReason: null,
    assets: assets.map(a => ({ mediaType: a.mediaType, width: a.width, height: a.height, durationSeconds: a.durationSeconds, providerAssetReference: a.providerAssetReference })) };
}

/** A thrown provider answer: PRE_SEND never left the server, FAILED keeps only a reported cost, anything else is UNKNOWN. */
export function thrownOutcome(error: unknown): CreativeOutcome {
  if (error instanceof CreativeProviderRuntimeError && error.outcome === 'PRE_SEND')
    return notSentOutcome(error.reason === 'INVALID_REQUEST' ? 'INVALID_REQUEST' : 'PROVIDER_NOT_CONNECTED');
  if (error instanceof CreativeProviderRuntimeError && error.outcome === 'FAILED') {
    const cost = error.providerCostMicrounits;
    return { outcome: 'FAILED', finalUnits: null, assets: null, failureReason: 'PROVIDER_REJECTED',
      providerCostMicrounits: isBoundedInt(cost, 0, 999_999_999_999_999) ? cost : null };
  }
  return unknownOutcome('PROVIDER_UNKNOWN');
}
