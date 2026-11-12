import type { CreativeAssetMediaType, CreativeAvatarStyle, CreativeGenerationFormat, SaasCreativeMediaKind } from '@hon/contracts';

export const CREATIVE_PROVIDER_RUNTIME = Symbol('CREATIVE_PROVIDER_RUNTIME');

/** The server-chosen provider route for one operation. Clients never choose a provider or model. */
export interface CreativeProviderRoute { providerId: string; modelCode: string }
/** Exactly what the database recorded for the generation, plus the server route. */
export interface CreativeInvocation extends CreativeProviderRoute {
  providerRequestId: string; operationCode: string; mediaKind: SaasCreativeMediaKind; units: number; format: CreativeGenerationFormat; prompt: string;
  /** Present only for avatar.create (0276): the avatar's name and look; the prompt is its description. */
  avatar?: CreativeAvatarLook;
}
export interface CreativeAvatarLook { name: string; style: CreativeAvatarStyle }
export interface CreativeResultAsset { mediaType: CreativeAssetMediaType; width: number; height: number; durationSeconds: number | null; providerAssetReference: string }
export interface CreativeResult { finalUnits: number; providerCostMicrounits: number; assets: CreativeResultAsset[] }

/**
 * Provider-neutral boundary for image and video generation. The provider gets the prompt and fixed parameters only: no
 * tools, tenant, authority, credential or wallet access. PRE_SEND = the request never left the server; FAILED = the provider
 * clearly refused it (its reported cost, if any, is passed on, never guessed); UNKNOWN = anything after the request may
 * have reached the provider. Nothing is ever resent automatically.
 */
export interface CreativeProviderRuntime {
  readiness(): 'READY' | 'CONFIGURATION_REQUIRED';
  route(operationCode: string): CreativeProviderRoute | null;
  generate(input: CreativeInvocation): Promise<CreativeResult>;
}
export class CreativeProviderRuntimeError extends Error {
  constructor(
    readonly outcome: 'PRE_SEND' | 'FAILED' | 'UNKNOWN',
    readonly reason: 'CONFIGURATION_REQUIRED' | 'INVALID_REQUEST' | 'PROVIDER_REJECTED' | 'PROVIDER_UNKNOWN',
    readonly providerCostMicrounits: number | null = null,
  ) { super(reason); }
}

/**
 * Production wiring in CS1: no creative provider is connected (a paid image/video provider needs separate owner approval),
 * so the Creative Studio reports NOT_CONNECTED and nothing is reserved. There is no environment switch that changes this.
 */
export class UnconfiguredCreativeProviderRuntime implements CreativeProviderRuntime {
  readiness() { return 'CONFIGURATION_REQUIRED' as const; }
  route(): CreativeProviderRoute | null { return null; }
  async generate(): Promise<CreativeResult> { throw new CreativeProviderRuntimeError('PRE_SEND', 'CONFIGURATION_REQUIRED'); }
}

const SIZES: Readonly<Record<CreativeGenerationFormat, [number, number]>> = { SQUARE: [1024, 1024], PORTRAIT: [1080, 1920], LANDSCAPE: [1920, 1080] };
export type SyntheticCreativeBehaviour = 'SUCCEED' | 'PRE_SEND' | 'REJECT' | 'REJECT_WITH_COST' | 'UNKNOWN' | 'UNVERIFIED';

/**
 * Deterministic fake provider for tests and disposable fixtures ONLY. It is injected explicitly by a test and never selected
 * by environment or used as a production fallback. Results are SYNTHETIC metadata (no media bytes, no network).
 */
export class SyntheticCreativeProviderRuntime implements CreativeProviderRuntime {
  readonly calls: CreativeInvocation[] = [];
  constructor(
    public behaviour: SyntheticCreativeBehaviour = 'SUCCEED',
    private readonly options: { providerId?: string; costMicrounitsPerUnit?: number; ready?: boolean } = {},
  ) {}
  readiness() { return this.options.ready === false ? 'CONFIGURATION_REQUIRED' as const : 'READY' as const; }
  route(operationCode: string): CreativeProviderRoute | null {
    if (this.readiness() !== 'READY') return null;
    return { providerId: this.options.providerId ?? 'HIGGSFIELD', modelCode: operationCode.startsWith('avatar.') ? 'synthetic-avatar-1' : operationCode.startsWith('video') ? 'synthetic-video-1' : 'synthetic-image-1' };
  }
  async generate(input: CreativeInvocation): Promise<CreativeResult> {
    this.calls.push(input);
    const cost = input.units * (this.options.costMicrounitsPerUnit ?? 1000);
    if (this.behaviour === 'PRE_SEND') throw new CreativeProviderRuntimeError('PRE_SEND', 'INVALID_REQUEST');
    if (this.behaviour === 'REJECT') throw new CreativeProviderRuntimeError('FAILED', 'PROVIDER_REJECTED');
    if (this.behaviour === 'REJECT_WITH_COST') throw new CreativeProviderRuntimeError('FAILED', 'PROVIDER_REJECTED', 250);
    if (this.behaviour === 'UNKNOWN') throw new CreativeProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    const [width, height] = SIZES[input.format];
    const video = input.mediaKind === 'VIDEO';
    const count = video ? 1 : Math.min(input.units, 8);
    const assets = Array.from({ length: count }, (_, i) => ({ mediaType: video ? 'video/mp4' as const : 'image/png' as const, width, height,
      durationSeconds: video ? Math.min(input.units, 600) : null, providerAssetReference: `synthetic:${input.providerRequestId}:${i + 1}` }));
    // UNVERIFIED: claims more units than were reserved, which the API must refuse to trust.
    return { finalUnits: this.behaviour === 'UNVERIFIED' ? input.units + 1 : input.units, providerCostMicrounits: cost, assets };
  }
}
