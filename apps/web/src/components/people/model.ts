import type { PersonRecord } from '@hon/contracts';
import { PersonRecordError, type PersonErrorKind, type PersonSummary } from './http';

export type ListState =
  | Readonly<{ state: 'LOADING' }> | Readonly<{ state: 'DENIED' }> | Readonly<{ state: 'UNAVAILABLE' }>
  | Readonly<{ state: 'READY'; query: string; items: readonly PersonSummary[] }>;
export type RecordState =
  | Readonly<{ state: 'NONE' }> | Readonly<{ state: 'LOADING' }> | Readonly<{ state: 'DENIED' }> | Readonly<{ state: 'MISSING' }>
  | Readonly<{ state: 'UNAVAILABLE' }> | Readonly<{ state: 'READY'; record: PersonRecord }>;

export type CommandKind = 'contact' | 'birthDate';
/**
 * What the last save from this tab is known to have done. Nothing is claimed that the server did not answer.
 * UNKNOWN and BUSY keep the exact request and key so "Try again" sends the same request; every other answer is final.
 */
export type SaveOutcome =
  | null | Readonly<{ kind: 'SENDING'; command: CommandKind }>
  | Readonly<{ kind: 'SAVED'; command: 'contact'; fields: readonly string[] }>
  | Readonly<{ kind: 'SAVED'; command: 'birthDate'; enrollmentCorrected: boolean }>
  | Readonly<{ kind: Exclude<PersonErrorKind, 'SESSION'> | 'LOCAL_INVALID' | 'LOCAL_UNCHANGED'; command: CommandKind }>;

/** Whether a failed attempt may be repeated with the same key and body. Only an unknown or busy answer keeps it. */
export function attemptOutcome(error: unknown, command: CommandKind): Readonly<{ outcome: SaveOutcome; keep: boolean }> {
  if (!(error instanceof PersonRecordError)) return { outcome: { kind: 'UNKNOWN', command }, keep: true };
  if (error.kind === 'SESSION') return { outcome: null, keep: false };
  return { outcome: { kind: error.kind, command }, keep: error.kind === 'UNKNOWN' || error.kind === 'BUSY' };
}

/** Today as YYYY-MM-DD in the browser's calendar. The server decides "today" in the school's time zone. */
export function localToday(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
