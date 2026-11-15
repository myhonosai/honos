import type { CreativeAvatarStyle, CreativeGenerationFormat } from '@hon/contracts';
import { CREATIVE_PROVIDER_JOB_ID } from '@hon/contracts';
import {
  CreativeProviderRuntimeError, type AsyncCreativeProviderRuntime, type CreativeInvocation, type CreativePollResult, type CreativeProviderJob,
  type CreativeProviderRoute, type CreativeResult, type CreativeSubmission,
} from '../creative-provider-runtime.js';
import { allowedDownloadUrl, creativeRequestJson, CreativeTransportError, isRecord, SUBMIT_REFUSED_STATUSES, type CreativeFetch } from './creative-provider-http.js';

/**
 * HeyGen adapter (C2): talking avatar video (`avatar.video`) with a server-configured stock avatar per HON look style and
 * one stock voice. Every provider fact below is **to confirm** against the live HeyGen docs before
 * HON_CREATIVE_HEYGEN_APPROVED is turned on (design doc §2.2). They all live in this one object.
 */
export const HEYGEN_API = {
  baseUrl: 'https://api.heygen.com',
  generatePath: '/v2/video/generate',
  statusPath: (videoId: string) => `/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`,
  operations: { 'avatar.video': 'heygen-avatar-iv-1' } as Record<string, string>,
  pendingStatuses: ['pending', 'waiting', 'processing'] as readonly string[],
  refusedStatuses: ['failed'] as readonly string[],
  completedStatus: 'completed',
  downloadHosts: ['heygen.ai', 'heygen.com'] as readonly string[],
  /** HON's upper cost estimate in micro-USD per second (doc §3: $4.83/min) until a real invoice is linked. */
  costMicrosPerSecond: { 'avatar.video': 80_500 } as Record<string, number>,
} as const;

const KEY = /^[A-Za-z0-9_=-]{16,200}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const SIZE: Readonly<Record<CreativeGenerationFormat, [number, number]>> = { SQUARE: [1080, 1080], PORTRAIT: [1080, 1920], LANDSCAPE: [1920, 1080] };
const STYLE_ENV: Readonly<Record<CreativeAvatarStyle, string>> = {
  REALISTIC: 'HON_CREATIVE_HEYGEN_AVATAR_REALISTIC', ILLUSTRATED: 'HON_CREATIVE_HEYGEN_AVATAR_ILLUSTRATED', CHIBI: 'HON_CREATIVE_HEYGEN_AVATAR_CHIBI',
};

export interface HeyGenOptions { send?: CreativeFetch; baseUrl?: string; downloadHosts?: readonly string[]; timeoutMs?: number }

export class HeyGenCreativeRuntime implements AsyncCreativeProviderRuntime {
  private readonly send: CreativeFetch;
  constructor(private readonly environment: () => NodeJS.ProcessEnv = () => process.env, private readonly options: HeyGenOptions = {}) {
    this.send = options.send ?? ((url, init) => fetch(url, init));
  }

  private key(): string | null { const k = this.environment().HEYGEN_API_KEY; return k && KEY.test(k) ? k : null; }
  private voice(): string | null { const v = this.environment().HON_CREATIVE_HEYGEN_VOICE_ID; return v && ID.test(v) ? v : null; }
  private avatarFor(style: CreativeAvatarStyle | undefined): string | null {
    const name = style ? STYLE_ENV[style] : undefined;
    const v = name ? this.environment()[name] : undefined;
    return v && ID.test(v) ? v : null;
  }
  /** READY only with a well-formed key, a stock voice, at least one stock avatar AND the switch exactly "true". */
  readiness(): 'READY' | 'CONFIGURATION_REQUIRED' {
    const anyAvatar = (Object.keys(STYLE_ENV) as CreativeAvatarStyle[]).some(s => this.avatarFor(s));
    return this.key() && this.voice() && anyAvatar && this.environment().HON_CREATIVE_HEYGEN_APPROVED === 'true' ? 'READY' : 'CONFIGURATION_REQUIRED';
  }
  route(operationCode: string): CreativeProviderRoute | null {
    const modelCode = HEYGEN_API.operations[operationCode];
    return modelCode && this.readiness() === 'READY' ? { providerId: 'HEYGEN', modelCode } : null;
  }
  async generate(): Promise<CreativeResult> { throw new CreativeProviderRuntimeError('PRE_SEND', 'INVALID_REQUEST'); }

  async submit(input: CreativeInvocation): Promise<CreativeSubmission> {
    const key = this.key(), voice = this.voice();
    if (!key || !voice || this.readiness() !== 'READY') throw new CreativeProviderRuntimeError('PRE_SEND', 'CONFIGURATION_REQUIRED');
    if (input.providerId !== 'HEYGEN' || HEYGEN_API.operations[input.operationCode] !== input.modelCode || input.mediaKind !== 'VIDEO')
      throw new CreativeProviderRuntimeError('PRE_SEND', 'INVALID_REQUEST');
    // The look's stock avatar must be configured; otherwise nothing is sent and the credits come back.
    const avatar = this.avatarFor(input.avatar?.style);
    if (!avatar) throw new CreativeProviderRuntimeError('PRE_SEND', 'CONFIGURATION_REQUIRED');
    const [width, height] = SIZE[input.format];
    // Only the script and fixed parameters: no school, person, avatar name or HON identifier.
    const body = { video_inputs: [{ character: { type: 'avatar', avatar_id: avatar, avatar_style: 'normal' },
      voice: { type: 'text', input_text: input.prompt, voice_id: voice } }], dimension: { width, height } };
    let answer;
    try {
      answer = await creativeRequestJson(this.send, `${this.base()}${HEYGEN_API.generatePath}`, { method: 'POST', body, headers: { 'X-Api-Key': key } },
        { timeoutMs: this.options.timeoutMs ?? 20_000, maxBytes: 16_384 });
    } catch (error) {
      if (error instanceof CreativeTransportError) throw new CreativeProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
      throw error;
    }
    if (SUBMIT_REFUSED_STATUSES.includes(answer.status)) throw new CreativeProviderRuntimeError('FAILED', 'PROVIDER_REJECTED');
    const data = isRecord(answer.body) && isRecord(answer.body.data) ? answer.body.data : undefined;
    const id = data?.video_id;
    if (answer.status !== 200 || typeof id !== 'string' || !CREATIVE_PROVIDER_JOB_ID.test(id)) throw new CreativeProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    return { providerJobId: id };
  }

  async poll(job: CreativeProviderJob): Promise<CreativePollResult> {
    const key = this.key();
    if (!key || job.providerId !== 'HEYGEN' || !CREATIVE_PROVIDER_JOB_ID.test(job.providerJobId)) throw new Error('heygen poll unavailable');
    const answer = await creativeRequestJson(this.send, `${this.base()}${HEYGEN_API.statusPath(job.providerJobId)}`, { method: 'GET', headers: { 'X-Api-Key': key } },
      { timeoutMs: this.options.timeoutMs ?? 15_000, maxBytes: 65_536 });
    const data = answer.status === 200 && isRecord(answer.body) && isRecord(answer.body.data) ? answer.body.data : undefined;
    if (!data || typeof data.status !== 'string') throw new Error('heygen poll unanswered');
    const status = data.status.toLowerCase();
    if (HEYGEN_API.pendingStatuses.includes(status)) return { state: 'PENDING' };
    if (HEYGEN_API.refusedStatuses.includes(status)) throw new CreativeProviderRuntimeError('FAILED', 'PROVIDER_REJECTED');
    if (status !== HEYGEN_API.completedStatus) throw new CreativeProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    const url = allowedDownloadUrl(data.video_url, this.options.downloadHosts ?? HEYGEN_API.downloadHosts);
    const duration = data.duration;
    if (!url || typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 600) throw new CreativeProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    // Charged by the second actually generated. Longer than reserved is never charged silently: the result fails
    // verification and is held UNKNOWN for HQ.
    const seconds = Math.ceil(duration);
    const [width, height] = SIZE[job.format];
    return { state: 'DONE', downloads: [{ url, mediaType: 'video/mp4' }], result: { finalUnits: seconds,
      providerCostMicrounits: (HEYGEN_API.costMicrosPerSecond[job.operationCode] ?? 0) * seconds,
      assets: [{ mediaType: 'video/mp4', width, height, durationSeconds: seconds, providerAssetReference: `heygen:${job.providerJobId}:1` }] } };
  }

  private base(): string { return (this.options.baseUrl ?? HEYGEN_API.baseUrl).replace(/\/+$/, ''); }
}
