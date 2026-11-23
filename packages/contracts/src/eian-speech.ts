/**
 * Eian natural voice (E-V2, 0638). The HON Family app can have an Eian answer read aloud in one fixed voice made by a
 * speech provider. The app sends the exact text it would have given the phone's own voice and gets one audio clip back.
 * Nothing is run and nothing is stored but a digest and a length.
 */

/** Fixed limits, mirrored from hon.eian_speech_limits() (the database owns them). */
export const EIAN_SPEECH_LIMITS = { maxCharacters: 1500, maxProviderCostMicrounits: 20000, burst: 20, dailyClips: 60 } as const;
export const EIAN_VOICES = ['NATURAL', 'PHONE'] as const;
export type EianVoiceKind = (typeof EIAN_VOICES)[number];
/** Why the natural voice is not used now. Closed, and never a ceiling, spend amount, provider or model name. */
export const EIAN_SPEECH_REASONS = ['NOT_INCLUDED', 'PAUSED', 'NOT_CONFIGURED', 'BUDGET_REACHED'] as const;
export type EianSpeechReason = (typeof EIAN_SPEECH_REASONS)[number];

export interface EianSpeechStatus { voice: EianVoiceKind; reason: EianSpeechReason | null }
export interface EianSpeechInput { text: string }
/** One clip: base64 MP3. Kept in memory by the app only while it is being played. */
export interface EianSpeechClip { audio: string; mime: 'audio/mpeg' }

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** About 3 MB of audio, far above the longest allowed answer. */
const MAX_AUDIO_BASE64 = 4_200_000;

function invalid(): never { throw new Error('Invalid Eian speech data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}

/** The text is trimmed, 1 to 1,500 characters, plain (no control characters other than newlines) and carries no link. */
export function validateEianSpeechInput(value: unknown): EianSpeechInput {
  const row = record(value, ['text']);
  if (typeof row.text !== 'string') invalid();
  const text = row.text.trim();
  if (text.length < 1 || text.length > EIAN_SPEECH_LIMITS.maxCharacters || CONTROL.test(text) || /https?:\/\/|www\./i.test(text)) invalid();
  return { text };
}

export function verifyEianSpeechStatus(value: unknown): EianSpeechStatus {
  const row = record(value, ['voice', 'reason']);
  if (row.voice !== 'NATURAL' && row.voice !== 'PHONE') invalid();
  if (row.reason !== null && (typeof row.reason !== 'string' || !(EIAN_SPEECH_REASONS as readonly string[]).includes(row.reason))) invalid();
  if ((row.voice === 'NATURAL') !== (row.reason === null)) invalid();
  return { voice: row.voice, reason: row.reason as EianSpeechReason | null };
}

export function verifyEianSpeechClip(value: unknown): EianSpeechClip {
  const row = record(value, ['audio', 'mime']);
  if (row.mime !== 'audio/mpeg' || typeof row.audio !== 'string' || row.audio.length < 16 || row.audio.length > MAX_AUDIO_BASE64
    || row.audio.length % 4 !== 0 || !BASE64.test(row.audio)) invalid();
  return { audio: row.audio, mime: 'audio/mpeg' };
}
