import { AGENT_SPEECH_LIMITS } from '@hon/contracts';
import { EianProviderRuntimeError as SpeechProviderRuntimeError } from '../eian/eian-provider-runtime.js';

export { SpeechProviderRuntimeError };
export const AGENT_SPEECH_RUNTIME = Symbol('AGENT_SPEECH_RUNTIME');

/** Exactly what prepare_agent_speech (0652) returns, plus the words (which never reach the database). */
export interface AgentSpeechInvocation { providerId: string; modelId: string; voice: string; providerRequestId: string; text: string; maxCostMicrounits: number }
/** The audio as WAV, and the provider's own reference for the call; the cost is read later with that reference. */
export interface AgentSpeechAudio { audio: Buffer; generationId: string }

/** Provider-neutral boundary. The provider gets the words to say and the agent's fixed voice name, nothing else. */
export interface AgentSpeechRuntime {
  readiness(): 'READY' | 'CONFIGURATION_REQUIRED';
  synthesize(input: AgentSpeechInvocation): Promise<AgentSpeechAudio>;
  /** The provider-reported cost of one finished call in microunits, or null while the provider has not published it yet. */
  cost(generationId: string, modelId: string): Promise<number | null>;
}

const speechEndpoint = 'https://openrouter.ai/api/v1/audio/speech';
const generationEndpoint = 'https://openrouter.ai/api/v1/generation';
const GENERATION_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const VOICE = /^[A-Z][a-z]{1,30}$/;
/** The longest allowed answer is about a minute of speech; a short sentence came back in about a second (2026-11-22). */
const SPEECH_TIMEOUT_MS = 30_000;
/** Gemini speech is raw 24 kHz 16-bit mono PCM: 48,000 bytes a second. 5 MB is well over 100 seconds. */
export const SAMPLE_RATE = 24_000;
const MAX_PCM_BYTES = 5_000_000;
const MIN_PCM_BYTES = 2_400;

/** Wraps raw 16-bit mono PCM in a 44-byte WAV header so every browser can play it. */
export function pcmToWav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1'); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * OpenRouter speech runtime for the staff agents' Gemini voices. Inactive unless OPENROUTER_API_KEY is set,
 * OPENROUTER_PAID_CALL_APPROVED is exactly 'true' and HON_AGENT_NATURAL_VOICE_APPROVED is exactly 'true'. Fixed endpoint
 * and model, no redirects, no provider fallbacks, no data collection, one attempt, a 30-second limit; anything after the
 * request may have reached the provider is UNKNOWN and is never resent. Only the words go in the input: this model reads
 * any delivery instructions aloud, so none are sent.
 */
export class OpenRouterAgentSpeechRuntime implements AgentSpeechRuntime {
  constructor(private readonly environment: () => Record<string, string | undefined> = () => process.env, private readonly transport: typeof fetch = fetch) {}

  readiness() {
    const env = this.environment();
    return env.OPENROUTER_API_KEY?.trim() && env.OPENROUTER_PAID_CALL_APPROVED === 'true' && env.HON_AGENT_NATURAL_VOICE_APPROVED === 'true'
      ? 'READY' as const : 'CONFIGURATION_REQUIRED' as const;
  }

  async synthesize(input: AgentSpeechInvocation): Promise<AgentSpeechAudio> {
    if (this.readiness() !== 'READY') throw new SpeechProviderRuntimeError('PRE_SEND', 'CONFIGURATION_REQUIRED');
    if (input.providerId !== 'OPENROUTER') throw new SpeechProviderRuntimeError('PRE_SEND', 'UNSUPPORTED_PROVIDER');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(input.modelId) || input.maxCostMicrounits !== AGENT_SPEECH_LIMITS.maxProviderCostMicrounits
      || !VOICE.test(input.voice) || typeof input.text !== 'string' || input.text.length < 1 || input.text.length > AGENT_SPEECH_LIMITS.maxCharacters) {
      throw new SpeechProviderRuntimeError('PRE_SEND', 'INVALID_REQUEST');
    }
    const key = this.environment().OPENROUTER_API_KEY;
    if (!key?.trim()) throw new SpeechProviderRuntimeError('PRE_SEND', 'CONFIGURATION_REQUIRED');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), SPEECH_TIMEOUT_MS);
    try {
      const response = await this.transport(speechEndpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Request-Id': input.providerRequestId, 'Idempotency-Key': input.providerRequestId },
        body: JSON.stringify({ model: input.modelId, input: input.text, voice: input.voice, response_format: 'pcm',
          provider: { allow_fallbacks: false, data_collection: 'deny' } }),
      });
      if (response.status === 404 || response.status === 429) throw new SpeechProviderRuntimeError('FAILED', 'PROVIDER_UNAVAILABLE');
      if ([400, 401, 402, 403, 422].includes(response.status)) throw new SpeechProviderRuntimeError('FAILED', 'PROVIDER_REJECTED');
      if (!response.ok) throw new Error('UNCERTAIN');
      const type = (response.headers.get('content-type') ?? '').toLowerCase().replace(/\s+/g, ''), generationId = response.headers.get('x-generation-id') ?? '';
      const pcm = Buffer.from(await response.arrayBuffer());
      // Measured 2026-11-22: "audio/pcm;rate=24000;channels=1".
      if (!type.startsWith('audio/pcm') || !type.includes(`rate=${SAMPLE_RATE}`) || (type.includes('channels=') && !type.includes('channels=1'))
        || !GENERATION_ID.test(generationId) || pcm.length < MIN_PCM_BYTES || pcm.length > MAX_PCM_BYTES || pcm.length % 2 !== 0) {
        throw new Error('UNVERIFIED');
      }
      return { audio: pcmToWav(pcm), generationId };
    } catch (error) {
      if (error instanceof SpeechProviderRuntimeError) throw error;
      throw new SpeechProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
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
      // The provider reports the model with a dated suffix (2026-11-22: google/gemini-3.8-flash-lite-tts-20260922).
      if (data?.id !== generationId || data.api_type !== 'tts' || typeof data.model !== 'string' || !(data.model === modelId || data.model.startsWith(`${modelId}-`))
        || typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || cost > 1000) return null;
      return Math.ceil(Number((cost * 1_000_000).toFixed(6)));
    } catch { return null; } finally { clearTimeout(timer); }
  }
}
