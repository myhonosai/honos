/** HON OS sign-up and trial admission limits (0274): HQ sees when a cap is hit, and the HQ owner changes the limits. */
import { accountClosed, accountUuid } from './school-owner-invitations.js';

export const ADMISSION_LIMITS_COMMAND = 'hon-os-admission-limits-set' as const;
export const ADMISSION_LIMIT_BOUNDS = Object.freeze({ perHourMax: 10_000, perDayMax: 100_000, reasonMin: 10, reasonMax: 500 });

export interface AdmissionLimits {
  versionId: string; version: number; signupsPerHour: number; signupsPerDay: number; trialsPerHour: number; trialsPerDay: number;
  reason: string | null; recordedBy: 'MIGRATION_OWNER' | 'HQ_OWNER'; actorPrincipalId: string | null; recordedAt: string;
}
export interface AdmissionUsage { lastHour: number; lastDay: number; perHour: number; perDay: number; full: boolean }
export interface AdmissionRefusalHour { kind: 'SIGNUP' | 'TRIAL'; hourStart: string; count: number; firstAt: string; lastAt: string }
export interface AdmissionStatus {
  limits: AdmissionLimits; history: readonly AdmissionLimits[]; historyHasMore: boolean;
  usage: { signups: AdmissionUsage; trials: AdmissionUsage };
  refusals: readonly AdmissionRefusalHour[];
  programs: { signup: 'CLOSED' | 'TEST_MODE'; trial: 'CLOSED' | 'TEST_MODE' };
  blockedEmailDomains: number; asOf: string;
}
export interface AdmissionLimitsInput { expectedVersion: number; signupsPerHour: number; signupsPerDay: number; trialsPerHour: number; trialsPerDay: number; reason: string }
export interface AdmissionLimitsReceipt { limits: AdmissionLimits; replayed: boolean }

const bad = (): never => { throw new Error('ADMISSION_INVALID'); };
const int = (v: unknown, low: number, high: number): number => (Number.isInteger(v) && (v as number) >= low && (v as number) <= high ? (v as number) : bad());
const instant = (v: unknown): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) ? v : bad());
const closed = (v: unknown, keys: readonly string[]) => { try { return accountClosed(v, keys); } catch { return bad(); } };
const id = (v: unknown) => { try { return accountUuid(v); } catch { return bad(); } };
function reasonText(v: unknown): string {
  // eslint-disable-next-line no-control-regex
  if (typeof v !== 'string' || v.trim() !== v || v.length < ADMISSION_LIMIT_BOUNDS.reasonMin || v.length > ADMISSION_LIMIT_BOUNDS.reasonMax || /[\u0000-\u001f\u007f]/.test(v)) bad();
  return v as string;
}

export function validateAdmissionLimitsInput(v: unknown): AdmissionLimitsInput {
  const o = closed(v, ['expectedVersion', 'signupsPerHour', 'signupsPerDay', 'trialsPerHour', 'trialsPerDay', 'reason']);
  const out = {
    expectedVersion: int(o.expectedVersion, 1, 999_999_998),
    signupsPerHour: int(o.signupsPerHour, 1, ADMISSION_LIMIT_BOUNDS.perHourMax), signupsPerDay: int(o.signupsPerDay, 1, ADMISSION_LIMIT_BOUNDS.perDayMax),
    trialsPerHour: int(o.trialsPerHour, 1, ADMISSION_LIMIT_BOUNDS.perHourMax), trialsPerDay: int(o.trialsPerDay, 1, ADMISSION_LIMIT_BOUNDS.perDayMax),
    reason: reasonText(o.reason),
  };
  if (out.signupsPerHour > out.signupsPerDay || out.trialsPerHour > out.trialsPerDay) bad();
  return Object.freeze(out);
}

function limits(v: unknown): AdmissionLimits {
  const o = closed(v, ['versionId', 'version', 'signupsPerHour', 'signupsPerDay', 'trialsPerHour', 'trialsPerDay', 'reason', 'recordedBy', 'actorPrincipalId', 'recordedAt']);
  const recordedBy = o.recordedBy === 'MIGRATION_OWNER' || o.recordedBy === 'HQ_OWNER' ? o.recordedBy : bad();
  const actor = o.actorPrincipalId === null ? null : id(o.actorPrincipalId);
  if ((recordedBy === 'HQ_OWNER') !== (actor !== null)) bad();
  const reason = o.reason === null ? null : reasonText(o.reason);
  if (recordedBy === 'HQ_OWNER' && reason === null) bad();
  const out = {
    versionId: id(o.versionId), version: int(o.version, 1, 999_999_999),
    signupsPerHour: int(o.signupsPerHour, 1, ADMISSION_LIMIT_BOUNDS.perHourMax), signupsPerDay: int(o.signupsPerDay, 1, ADMISSION_LIMIT_BOUNDS.perDayMax),
    trialsPerHour: int(o.trialsPerHour, 1, ADMISSION_LIMIT_BOUNDS.perHourMax), trialsPerDay: int(o.trialsPerDay, 1, ADMISSION_LIMIT_BOUNDS.perDayMax),
    reason, recordedBy, actorPrincipalId: actor, recordedAt: instant(o.recordedAt),
  };
  if (out.signupsPerHour > out.signupsPerDay || out.trialsPerHour > out.trialsPerDay) bad();
  return Object.freeze(out);
}
function usage(v: unknown): AdmissionUsage {
  const o = closed(v, ['lastHour', 'lastDay', 'perHour', 'perDay', 'full']);
  const out = { lastHour: int(o.lastHour, 0, 1e9), lastDay: int(o.lastDay, 0, 1e9), perHour: int(o.perHour, 1, ADMISSION_LIMIT_BOUNDS.perHourMax), perDay: int(o.perDay, 1, ADMISSION_LIMIT_BOUNDS.perDayMax), full: o.full };
  if (typeof out.full !== 'boolean' || out.lastHour > out.lastDay || out.full !== (out.lastHour >= out.perHour || out.lastDay >= out.perDay)) bad();
  return Object.freeze(out as AdmissionUsage);
}
function refusal(v: unknown): AdmissionRefusalHour {
  const o = closed(v, ['kind', 'hourStart', 'count', 'firstAt', 'lastAt']);
  const out = { kind: o.kind === 'SIGNUP' || o.kind === 'TRIAL' ? o.kind : bad(), hourStart: instant(o.hourStart), count: int(o.count, 1, 2_000_000_000), firstAt: instant(o.firstAt), lastAt: instant(o.lastAt) };
  const hour = Date.parse(out.hourStart), first = Date.parse(out.firstAt), last = Date.parse(out.lastAt);
  if (hour % 3_600_000 !== 0 || first < hour || last < first || last >= hour + 3_600_000) bad();
  return Object.freeze(out);
}
const status = (v: unknown) => (v === 'CLOSED' || v === 'TEST_MODE' ? v : bad());

export function validateAdmissionStatus(v: unknown): AdmissionStatus {
  const o = closed(v, ['limits', 'history', 'historyHasMore', 'usage', 'refusals', 'programs', 'blockedEmailDomains', 'asOf']);
  const current = limits(o.limits);
  if (!Array.isArray(o.history) || o.history.length < 1 || o.history.length > 50 || typeof o.historyHasMore !== 'boolean') bad();
  const history = (o.history as unknown[]).map(limits);
  if (history[0]!.versionId !== current.versionId || history.some((h, i) => i > 0 && h.version >= history[i - 1]!.version)) bad();
  const u = closed(o.usage, ['signups', 'trials']), signups = usage(u.signups), trials = usage(u.trials);
  if (signups.perHour !== current.signupsPerHour || signups.perDay !== current.signupsPerDay || trials.perHour !== current.trialsPerHour || trials.perDay !== current.trialsPerDay) bad();
  if (!Array.isArray(o.refusals) || o.refusals.length > 400) bad();
  const p = closed(o.programs, ['signup', 'trial']);
  return Object.freeze({
    limits: current, history: Object.freeze(history), historyHasMore: o.historyHasMore as boolean,
    usage: Object.freeze({ signups, trials }), refusals: Object.freeze((o.refusals as unknown[]).map(refusal)),
    programs: Object.freeze({ signup: status(p.signup), trial: status(p.trial) }),
    blockedEmailDomains: int(o.blockedEmailDomains, 0, 1_000_000), asOf: instant(o.asOf),
  });
}
export function validateAdmissionLimitsReceipt(v: unknown): AdmissionLimitsReceipt {
  const o = closed(v, ['limits', 'replayed']);
  const out = limits(o.limits);
  if (typeof o.replayed !== 'boolean' || out.recordedBy !== 'HQ_OWNER') bad();
  return Object.freeze({ limits: out, replayed: o.replayed as boolean });
}
