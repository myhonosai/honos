import type { CreativeAvatarStyle, CreativeGenerationFormat } from '@hon/contracts';
import { CREATIVE_PROVIDER_JOB_ID } from '@hon/contracts';
import {
  CreativeProviderRuntimeError, type AsyncCreativeProviderRuntime, type CreativeInvocation, type CreativePollResult, type CreativeProviderJob,
  type CreativeProviderRoute, type CreativeResult, type CreativeSubmission, type CreativeDownload,
} from '../creative-provider-runtime.js';
import { allowedDownloadUrl, creativeRequestJson, CreativeTransportError, isRecord, SUBMIT_REFUSED_STATUSES, type CreativeFetch } from './creative-provider-http.js';

/**
 * Higgsfield adapter (C2): images, short video and avatar looks.
 *
 * Every provider fact below is **to confirm** against the live Higgsfield docs before HON_CREATIVE_HIGGSFIELD_APPROVED is
 * turned on (the docs hosts are blocked from the build container; design doc §2.1). They all live in this one object.
 */
export const HIGGSFIELD_API = {
  baseUrl: 'https://platform.higgsfield.ai',
  /** HON model code (recorded on the reservation) -> provider model path. Server configuration, never chosen by a client. */
  models: {
    'hf-image-soul-1': '/higgsfield-ai/soul/standard',
    'hf-video-kling-1': '/kling-video/v2.1/pro/text-to-video',
  } as Record<string, string>,
  operations: { 'image.generate': 'hf-image-soul-1', 'avatar.create': 'hf-image-soul-1', 'video.generate': 'hf-video-kling-1' } as Record<string, string>,
  statusPath: (requestId: string) => `/requests/${encodeURIComponent(requestId)}/status`,
  /** Authorization header carrying the key id and secret pair. */
  authorization: (keyId: string, secret: string) => `Key ${keyId}:${secret}`,
  pendingStatuses: ['queued', 'in_progress'] as readonly string[],
  refusedStatuses: ['failed', 'nsfw', 'canceled', 'cancelled'] as readonly string[],
  completedStatus: 'completed',
  downloadHosts: ['higgsfield.ai'] as readonly string[],
  /** HON's upper cost estimate in micro-USD per unit (doc §3) until a real invoice is linked; rates stay PROVISIONAL. */
  costMicrosPerUnit: { 'image.generate': 16_000, 'avatar.create': 16_000, 'video.generate': 120_000 } as Record<string, number>,
} as const;

const KEY_PART = /^[A-Za-z0-9_-]{8,200}$/;
const ASPECT: Readonly<Record<CreativeGenerationFormat, string>> = { SQUARE: '1:1', PORTRAIT: '9:16', LANDSCAPE: '16:9' };
const SIZE: Readonly<Record<CreativeGenerationFormat, [number, number]>> = { SQUARE: [1024, 1024], PORTRAIT: [1080, 1920], LANDSCAPE: [1920, 1080] };
const STYLE: Readonly<Record<CreativeAvatarStyle, string>> = {
  REALISTIC: 'Photorealistic head-and-shoulders portrait of a fictional adult martial arts instructor',
  ILLUSTRATED: 'Friendly illustrated cartoon portrait of a fictional martial arts instructor',
  CHIBI: 'Cute chibi-style illustrated portrait of a fictional martial arts instructor',
};

export interface HiggsfieldOptions { send?: CreativeFetch; baseUrl?: string; downloadHosts?: readonly string[]; timeoutMs?: number }

export class HiggsfieldCreativeRuntime implements AsyncCreativeProviderRuntime {
  private readonly send: CreativeFetch;
  constructor(private readonly environment: () => NodeJS.ProcessEnv = () => process.env, private readonly options: HiggsfieldOptions = {}) {
    this.send = options.send ?? ((url, init) => fetch(url, init));
  }

  private credential(): { keyId: string; secret: string } | null {
    const env = this.environment();
    const keyId = env.HIGGSFIELD_API_KEY_ID, secret = env.HIGGSFIELD_API_SECRET;
    return keyId && secret && KEY_PART.test(keyId) && KEY_PART.test(secret) ? { keyId, secret } : null;
  }
  /** READY only with a well-formed key pair AND the switch exactly "true". */
  readiness(): 'READY' | 'CONFIGURATION_REQUIRED' {
    return this.credential() && this.environment().HON_CREATIVE_HIGGSFIELD_APPROVED === 'true' ? 'READY' : 'CONFIGURATION_REQUIRED';
  }
  route(operationCode: string): CreativeProviderRoute | null {
    const modelCode = HIGGSFIELD_API.operations[operationCode];
    return modelCode && this.readiness() === 'READY' ? { providerId: 'HIGGSFIELD', modelCode } : null;
  }
  async generate(): Promise<CreativeResult> { throw new CreativeProviderRuntimeError('PRE_SEND', 'INVALID_REQUEST'); }

  async submit(input: CreativeInvocation): Promise<CreativeSubmission> {
    const credential = this.credential();
    if (!credential || this.readiness() !== 'READY') throw new CreativeProviderRuntimeError('PRE_SEND', 'CONFIGURATION_REQUIRED');
    const path = HIGGSFIELD_API.models[input.modelCode];
    if (input.providerId !== 'HIGGSFIELD' || !path || HIGGSFIELD_API.operations[input.operationCode] !== input.modelCode)
      throw new CreativeProviderRuntimeError('PRE_SEND', 'INVALID_REQUEST');
    const body = this.requestBody(input);
    let answer;
    try {
      answer = await creativeRequestJson(this.send, `${this.base()}${path}`, { method: 'POST', body,
        headers: { Authorization: HIGGSFIELD_API.authorization(credential.keyId, credential.secret) } }, { timeoutMs: this.options.timeoutMs ?? 20_000, maxBytes: 16_384 });
    } catch (error) {
      if (error instanceof CreativeTransportError) throw new CreativeProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
      throw error;
    }
    if (SUBMIT_REFUSED_STATUSES.includes(answer.status)) throw new CreativeProviderRuntimeError('FAILED', 'PROVIDER_REJECTED');
    const id = isRecord(answer.body) ? answer.body.request_id : undefined;
    if (answer.status < 200 || answer.status > 202 || typeof id !== 'string' || !CREATIVE_PROVIDER_JOB_ID.test(id))
      throw new CreativeProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    return { providerJobId: id };
  }

  /** Only the prompt and fixed parameters reach the provider: no school, person, name or HON identifier. */
  private requestBody(input: CreativeInvocation): Record<string, unknown> {
    const aspect_ratio = ASPECT[input.format];
    if (input.operationCode === 'video.generate') return { prompt: input.prompt, aspect_ratio, duration: input.units };
    if (input.operationCode === 'avatar.create') {
      const style = input.avatar ? STYLE[input.avatar.style] : undefined;
      if (!style) throw new CreativeProviderRuntimeError('PRE_SEND', 'INVALID_REQUEST');
      return { prompt: `${style}. ${input.prompt}`, aspect_ratio: '1:1', batch_size: 1 };
    }
    return { prompt: input.prompt, aspect_ratio, batch_size: input.units };
  }

  async poll(job: CreativeProviderJob): Promise<CreativePollResult> {
    const credential = this.credential();
    // Polling needs only the key: a job already submitted is still followed after the switch is turned off.
    if (!credential || job.providerId !== 'HIGGSFIELD' || !CREATIVE_PROVIDER_JOB_ID.test(job.providerJobId)) throw new Error('higgsfield poll unavailable');
    const answer = await creativeRequestJson(this.send, `${this.base()}${HIGGSFIELD_API.statusPath(job.providerJobId)}`, { method: 'GET',
      headers: { Authorization: HIGGSFIELD_API.authorization(credential.keyId, credential.secret) } }, { timeoutMs: this.options.timeoutMs ?? 15_000, maxBytes: 65_536 });
    // Anything but a clear status answer is retried by the worker until the deadline (never a guessed outcome).
    if (answer.status !== 200 || !isRecord(answer.body) || typeof answer.body.status !== 'string') throw new Error('higgsfield poll unanswered');
    const status = answer.body.status.toLowerCase();
    if (HIGGSFIELD_API.pendingStatuses.includes(status)) return { state: 'PENDING' };
    if (HIGGSFIELD_API.refusedStatuses.includes(status)) throw new CreativeProviderRuntimeError('FAILED', 'PROVIDER_REJECTED');
    if (status !== HIGGSFIELD_API.completedStatus) throw new CreativeProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    return this.completed(job, answer.body);
  }

  /** A completed answer becomes a result only when every download URL is acceptable; otherwise UNKNOWN for HQ. */
  private completed(job: CreativeProviderJob, body: Record<string, unknown>): CreativePollResult {
    const hosts = this.options.downloadHosts ?? HIGGSFIELD_API.downloadHosts;
    const video = job.mediaKind === 'VIDEO';
    const raw: unknown[] = video ? [isRecord(body.video) ? body.video.url : undefined] : Array.isArray(body.images) ? body.images.map(i => isRecord(i) ? i.url : undefined) : [];
    const urls = raw.map(u => allowedDownloadUrl(u, hosts));
    if (!urls.length || urls.some(u => u === null) || (!video && urls.length > job.units)) throw new CreativeProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    const [width, height] = job.operationCode === 'avatar.create' ? SIZE.SQUARE : SIZE[job.format];
    const finalUnits = video ? job.units : urls.length;
    const cost = (HIGGSFIELD_API.costMicrosPerUnit[job.operationCode] ?? 0) * finalUnits;
    const mediaType = video ? 'video/mp4' as const : 'image/png' as const;
    const downloads: CreativeDownload[] = urls.map(url => ({ url: url!, mediaType }));
    return { state: 'DONE', downloads, result: { finalUnits, providerCostMicrounits: cost,
      assets: downloads.map((_, i) => ({ mediaType, width, height, durationSeconds: video ? job.units : null, providerAssetReference: `hf:${job.providerJobId}:${i + 1}` })) } };
  }

  private base(): string { return (this.options.baseUrl ?? HIGGSFIELD_API.baseUrl).replace(/\/+$/, ''); }
}
