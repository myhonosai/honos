import { EIAN_SPEECH_LIMITS } from '@hon/contracts';
import { EianProviderRuntimeError } from './eian-provider-runtime.js';
import { EIAN_VOICE_REFERENCE_MP3_BASE64, EIAN_VOICE_REFERENCE_TRANSCRIPT } from './eian-voice-reference.js';

export const EIAN_SPEECH_RUNTIME = Symbol('EIAN_SPEECH_RUNTIME');

/** Exactly what prepare_eian_speech (0638) returns, plus the words (which never reach the database). */
export interface EianSpeechInvocation { providerId: string; modelId: string; providerRequestId: string; text: string; maxCostMicrounits: number }
/** The audio, and the provider's own reference for the call; the cost is read later with that reference. */
export interface EianSpeechAudio { audio: Buffer; generationId: string }

/** Provider-neutral boundary. The provider gets the words to say and the fixed reference voice, nothing else. */
export interface EianSpeechRuntime {
  readiness(): 'READY' | 'CONFIGURATION_REQUIRED';
  synthesize(input: EianSpeechInvocation): Promise<EianSpeechAudio>;
  /** The provider-reported cost of one finished call in microunits, or null while the provider has not published it yet. */
  cost(generationId: string, modelId: string): Promise<number | null>;
}

export const EIAN_SPEECH_INSTRUCTIONS = 'Cheerful and friendly.';
const speechEndpoint = 'https://openrouter.ai/api/v1/audio/speech';
const generationEndpoint = 'https://openrouter.ai/api/v1/generation';
const GENERATION_ID = /^[A-Za-z0-9._:-]{1,200}$/;
/** Measured 2026-11-22: about 2.5 s for 143 characters and 6.2 s for 542, so the longest allowed answer needs well over 15 s. */
const SPEECH_TIMEOUT_MS = 30_000;
/** 3 MB: far above the longest allowed answer at the provider's bitrate. */
const MAX_AUDIO_BYTES = 3_000_000;

/** MP3 data starts with an ID3 tag or an MPEG frame sync. */
export function looksLikeMp3(bytes: Buffer): boolean {
  if (bytes.length < 256) return false;
  return bytes.subarray(0, 3).toString('latin1') === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
}

/**
 * OpenRouter speech runtime for Eian's natural voice. Inactive unless OPENROUTER_API_KEY is set, OPENROUTER_PAID_CALL_APPROVED
 * is exactly 'true' and HON_EIAN_NATURAL_VOICE_APPROVED is exactly 'true'. Fixed endpoint and model, no redirects, no
 * provider fallbacks, no data collection, one attempt, a 30-second limit; anything after the request may have reached the provider is
 * UNKNOWN and is never resent. The words are sent as the input only: delivery instructions go in their own field,
 * because a provider may read instructions aloud when they are mixed into the text.
 */
export class OpenRouterEianSpeechRuntime implements EianSpeechRuntime {
  constructor(private readonly environment: () => Record<string, string | undefined> = () => process.env, private readonly transport: typeof fetch = fetch) {}

  readiness() {
    const env = this.environment();
    return env.OPENROUTER_API_KEY?.trim() && env.OPENROUTER_PAID_CALL_APPROVED === 'true' && env.HON_EIAN_NATURAL_VOICE_APPROVED === 'true'
      ? 'READY' as const : 'CONFIGURATION_REQUIRED' as const;
  }

  async synthesize(input: EianSpeechInvocation): Promise<EianSpeechAudio> {
    if (this.readiness() !== 'READY') throw new EianProviderRuntimeError('PRE_SEND', 'CONFIGURATION_REQUIRED');
    if (input.providerId !== 'OPENROUTER') throw new EianProviderRuntimeError('PRE_SEND', 'UNSUPPORTED_PROVIDER');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(input.modelId) || input.maxCostMicrounits !== EIAN_SPEECH_LIMITS.maxProviderCostMicrounits
      || typeof input.text !== 'string' || input.text.length < 1 || input.text.length > EIAN_SPEECH_LIMITS.maxCharacters) {
      throw new EianProviderRuntimeError('PRE_SEND', 'INVALID_REQUEST');
    }
    const key = this.environment().OPENROUTER_API_KEY;
    if (!key?.trim()) throw new EianProviderRuntimeError('PRE_SEND', 'CONFIGURATION_REQUIRED');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), SPEECH_TIMEOUT_MS);
    try {
      const response = await this.transport(speechEndpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Request-Id': input.providerRequestId, 'Idempotency-Key': input.providerRequestId },
        body: JSON.stringify({ model: input.modelId, input: input.text, instructions: EIAN_SPEECH_INSTRUCTIONS, response_format: 'mp3',
          provider: { allow_fallbacks: false, data_collection: 'deny' },
          input_references: [{ type: 'input_audio', input_audio: { data: `data:audio/mp3;base64,${EIAN_VOICE_REFERENCE_MP3_BASE64}` } },
            { type: 'text', text: EIAN_VOICE_REFERENCE_TRANSCRIPT }] }),
      });
      if (response.status === 404 || response.status === 429) throw new EianProviderRuntimeError('FAILED', 'PROVIDER_UNAVAILABLE');
      if ([400, 401, 402, 403, 422].includes(response.status)) throw new EianProviderRuntimeError('FAILED', 'PROVIDER_REJECTED');
      if (!response.ok) throw new Error('UNCERTAIN');
      const type = response.headers.get('content-type') ?? '', generationId = response.headers.get('x-generation-id') ?? '';
      const audio = Buffer.from(await response.arrayBuffer());
      if (!type.toLowerCase().startsWith('audio/mpeg') || !GENERATION_ID.test(generationId) || audio.length > MAX_AUDIO_BYTES || !looksLikeMp3(audio)) {
        throw new Error('UNVERIFIED');
      }
      return { audio, generationId };
    } catch (error) {
      if (error instanceof EianProviderRuntimeError) throw error;
      throw new EianProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    } finally { clearTimeout(timer); }
  }

  async cost(generationId: string, modelId: string): Promise<number | null> {
    const key = this.environment().OPENROUTER_API_KEY;
    if (!key?.trim() || !GENERATION_ID.test(generationId)) return null;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await this.transport(`${generationEndpoint}?id=${encodeURIComponent(generationId)}`, {
        method: 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json', Authorization: `Bearer ${key}` } });
      if (!response.ok) return null;
      const data = (await response.json() as { data?: { id?: string; model?: string; api_type?: string; total_cost?: number } }).data;
      const cost = data?.total_cost;
      // The provider reports the model with a dated suffix (for example fish-audio/drama-3-20261013).
      if (data?.id !== generationId || data.api_type !== 'tts' || typeof data.model !== 'string' || !(data.model === modelId || data.model.startsWith(`${modelId}-`))
        || typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || cost > 1000) return null;
      return Math.ceil(Number((cost * 1_000_000).toFixed(6)));
    } catch { return null; } finally { clearTimeout(timer); }
  }
}
