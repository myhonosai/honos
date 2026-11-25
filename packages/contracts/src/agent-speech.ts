/**
 * Staff agent natural voices (0652). A staff member can have one of the nine school AI agents read its answer aloud in
 * that agent's own fixed Gemini voice instead of the browser's built-in voice. The web sends the exact text it would have
 * given the browser voice and gets one audio clip back. Nothing is run and nothing is stored but a digest and a length.
 */

/** The nine school agents, as in 0635 (per-staff agent switches). */
export const AGENT_SPEECH_AGENTS = ['hon', 'kai', 'alex', 'chad', 'maya', 'marcus', 'jordan', 'claire', 'lena'] as const;
export type AgentSpeechAgent = (typeof AGENT_SPEECH_AGENTS)[number];
/** Fixed limits, mirrored from hon.agent_speech_limits() (the database owns them). */
export const AGENT_SPEECH_LIMITS = { maxCharacters: 1000, maxProviderCostMicrounits: 20000, burst: 30, dailyClips: 200 } as const;
/** Each agent's Gemini voice, mirrored from hon.agent_speech_limits() (the samples the owner heard on 2026-11-22). */
export const AGENT_SPEECH_VOICES: Readonly<Record<AgentSpeechAgent, string>> = {
  hon: 'Kore', maya: 'Leda', chad: 'Puck', kai: 'Charon', alex: 'Orus', jordan: 'Iapetus', marcus: 'Fenrir', claire: 'Despina', lena: 'Aoede',
};
export const AGENT_SPEECH_VOICE_KINDS = ['NATURAL', 'BROWSER'] as const;
export type AgentSpeechVoiceKind = (typeof AGENT_SPEECH_VOICE_KINDS)[number];
/** Why the natural voice is not used now. Closed, and never a ceiling, spend amount, provider or model name. */
export const AGENT_SPEECH_REASONS = ['NOT_INCLUDED', 'PAUSED', 'NOT_CONFIGURED', 'BUDGET_REACHED'] as const;
export type AgentSpeechReason = (typeof AGENT_SPEECH_REASONS)[number];

export interface AgentSpeechStatus { voice: AgentSpeechVoiceKind; reason: AgentSpeechReason | null }
export interface AgentSpeechInput { text: string }
/** One clip: base64 WAV (16-bit mono PCM). Kept in memory by the browser only while it is being played. */
export interface AgentSpeechClip { audio: string; mime: 'audio/wav' }

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** About 5 MB of audio, far above the longest allowed answer. */
const MAX_AUDIO_BASE64 = 7_000_000;

function invalid(): never { throw new Error('Invalid agent speech data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}

export function isAgentSpeechAgent(value: unknown): value is AgentSpeechAgent {
  return typeof value === 'string' && (AGENT_SPEECH_AGENTS as readonly string[]).includes(value);
}

/** The text is trimmed, 1 to 1,000 characters, plain (no control characters other than newlines) and carries no link. */
export function validateAgentSpeechInput(value: unknown): AgentSpeechInput {
  const row = record(value, ['text']);
  if (typeof row.text !== 'string') invalid();
  const text = row.text.trim();
  if (text.length < 1 || text.length > AGENT_SPEECH_LIMITS.maxCharacters || CONTROL.test(text) || /https?:\/\/|www\./i.test(text)) invalid();
  return { text };
}

export function verifyAgentSpeechStatus(value: unknown): AgentSpeechStatus {
  const row = record(value, ['voice', 'reason']);
  if (row.voice !== 'NATURAL' && row.voice !== 'BROWSER') invalid();
  if (row.reason !== null && (typeof row.reason !== 'string' || !(AGENT_SPEECH_REASONS as readonly string[]).includes(row.reason))) invalid();
  if ((row.voice === 'NATURAL') !== (row.reason === null)) invalid();
  return { voice: row.voice, reason: row.reason as AgentSpeechReason | null };
}

export function verifyAgentSpeechClip(value: unknown): AgentSpeechClip {
  const row = record(value, ['audio', 'mime']);
  if (row.mime !== 'audio/wav' || typeof row.audio !== 'string' || row.audio.length < 16 || row.audio.length > MAX_AUDIO_BASE64
    || row.audio.length % 4 !== 0 || !BASE64.test(row.audio)) invalid();
  return { audio: row.audio, mime: 'audio/wav' };
}
