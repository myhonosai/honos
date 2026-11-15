// Onboarding (0323): HON's welcome answers and the school's setup progress. Answers are saved by a direct human with
// onboarding.manage; progress is recomputed from the school's real records on every read and is never stored as done.
// Before trial or paid access starts (owner decision D3), school-data steps read UNAVAILABLE.

export const ONBOARDING_SITUATIONS = ['NEW_SCHOOL', 'EXISTING_SCHOOL', 'MULTI_LOCATION', 'EXPLORING'] as const;
export const ONBOARDING_DISCIPLINES = ['TAEKWONDO', 'KARATE', 'BJJ', 'KICKBOXING', 'MMA', 'JUDO', 'KUNG_FU', 'HAPKIDO', 'MUAY_THAI', 'OTHER'] as const;
export const ONBOARDING_GOALS = ['MORE_STUDENTS', 'LEAD_FOLLOW_UP', 'SIMPLER_OPERATIONS', 'SAVE_TIME', 'RETENTION', 'MEMBERSHIPS_PAYMENTS', 'REPORTING', 'MULTI_LOCATION'] as const;
export const ONBOARDING_PATHS = ['NEW', 'SWITCHING'] as const;
export const ONBOARDING_PREVIOUS_SOFTWARE = ['SPARK', 'ZEN_PLANNER', 'KICKSITE', 'MINDBODY', 'GYMDESK', 'PIKE13', 'EMBER', 'SPREADSHEET', 'PAPER', 'OTHER', 'NONE'] as const;
export const ONBOARDING_IMPORT_WISHES = ['STUDENTS', 'LEADS', 'MEMBERSHIPS', 'CLASSES', 'BALANCES', 'ATTENDANCE', 'STAFF'] as const;
export const ONBOARDING_SKIPPABLE_STEPS = ['INTERFACE', 'PROGRAM', 'CLASS_SCHEDULE', 'MEMBERSHIP_PLAN', 'FIRST_LEAD', 'TRIAL_BOOKED', 'FIRST_STUDENT', 'STAFF', 'IMPORT'] as const;
export const ONBOARDING_STEP_KEYS = ['SCHOOL_DETAILS', 'WELCOME', ...ONBOARDING_SKIPPABLE_STEPS] as const;
export const ONBOARDING_STEP_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'NEEDS_REVIEW', 'COMPLETE', 'UNAVAILABLE'] as const;
export const ONBOARDING_ACCESS_STATES = ['ACTIVE', 'NOT_STARTED', 'ENDED'] as const;
export const ONBOARDING_HUMAN_COMMAND = 'onboarding.profile.save';

export type OnboardingSituation = typeof ONBOARDING_SITUATIONS[number];
export type OnboardingDiscipline = typeof ONBOARDING_DISCIPLINES[number];
export type OnboardingGoal = typeof ONBOARDING_GOALS[number];
export type OnboardingPath = typeof ONBOARDING_PATHS[number];
export type OnboardingPreviousSoftware = typeof ONBOARDING_PREVIOUS_SOFTWARE[number];
export type OnboardingImportWish = typeof ONBOARDING_IMPORT_WISHES[number];
export type OnboardingSkippableStep = typeof ONBOARDING_SKIPPABLE_STEPS[number];
export type OnboardingStepKey = typeof ONBOARDING_STEP_KEYS[number];
export type OnboardingStepStatus = typeof ONBOARDING_STEP_STATUSES[number];
export type OnboardingAccessState = typeof ONBOARDING_ACCESS_STATES[number];

export interface OnboardingAnswers {
  situation: OnboardingSituation | null; disciplines: OnboardingDiscipline[]; customDiscipline: string | null;
  goals: OnboardingGoal[]; path: OnboardingPath | null; previousSoftware: OnboardingPreviousSoftware | null; previousSoftwareOther: string | null;
  importWishes: OnboardingImportWish[]; skippedSteps: OnboardingSkippableStep[];
}
export interface OnboardingSaveInput extends OnboardingAnswers { expectedVersion: number }
export interface OnboardingProfile extends OnboardingAnswers { version: number; updatedAt: string }
export interface OnboardingStep { key: OnboardingStepKey; status: OnboardingStepStatus; count: number; firstAt: string | null; optional: boolean; skipped: boolean }
export interface OnboardingAccess { state: OnboardingAccessState; trialStatus: 'TRIAL_ACTIVE' | 'TRIAL_ENDED' | 'SUPERSEDED' | null; trialEndsAt: string | null }
export interface SchoolOnboarding { schoolName: string; timezone: string; profile: OnboardingProfile | null; access: OnboardingAccess; steps: OnboardingStep[]; checkedAt: string }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
function fail(what: string): never { throw new Error(`Unverified school onboarding ${what}.`); }
function record(v: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(what);
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== [...keys].sort().join(',')) fail(what);
  return o;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string, nullable = false): T | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) fail(what);
  return v as T;
}
function codes<T extends string>(v: unknown, allowed: readonly T[], what: string): T[] {
  if (!Array.isArray(v) || v.length > allowed.length || new Set(v).size !== v.length) fail(what);
  return v.map((x) => oneOf(x, allowed, what)!) as T[];
}
function shortText(v: unknown, what: string): string | null {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length < 1 || v.length > 60 || v.trim() !== v || /[\u0000-\u001f\u007f<>]/.test(v)) fail(what);
  return v;
}
function time(v: unknown, what: string, nullable = false): string | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !ISO.test(v) || Number.isNaN(Date.parse(v))) fail(what);
  return v;
}
const ANSWER_KEYS = ['situation', 'disciplines', 'customDiscipline', 'goals', 'path', 'previousSoftware', 'previousSoftwareOther', 'importWishes', 'skippedSteps'] as const;

function answers(o: Record<string, unknown>): OnboardingAnswers {
  const a: OnboardingAnswers = {
    situation: oneOf(o.situation, ONBOARDING_SITUATIONS, 'situation', true), disciplines: codes(o.disciplines, ONBOARDING_DISCIPLINES, 'disciplines'),
    customDiscipline: shortText(o.customDiscipline, 'custom discipline'), goals: codes(o.goals, ONBOARDING_GOALS, 'goals'),
    path: oneOf(o.path, ONBOARDING_PATHS, 'path', true), previousSoftware: oneOf(o.previousSoftware, ONBOARDING_PREVIOUS_SOFTWARE, 'previous software', true),
    previousSoftwareOther: shortText(o.previousSoftwareOther, 'previous software'), importWishes: codes(o.importWishes, ONBOARDING_IMPORT_WISHES, 'import wishes'),
    skippedSteps: codes(o.skippedSteps, ONBOARDING_SKIPPABLE_STEPS, 'skipped steps'),
  };
  if (a.customDiscipline !== null && !a.disciplines.includes('OTHER')) fail('custom discipline');
  if (a.previousSoftwareOther !== null && a.previousSoftware !== 'OTHER') fail('previous software');
  return a;
}

/** Closed check of a save body before it is sent to the database (which checks it again). */
export function validateOnboardingSaveInput(v: unknown): OnboardingSaveInput {
  const o = record(v, [...ANSWER_KEYS, 'expectedVersion'], 'save input');
  if (typeof o.expectedVersion !== 'number' || !Number.isInteger(o.expectedVersion) || o.expectedVersion < 0 || o.expectedVersion > 999999999) fail('expected version');
  return { expectedVersion: o.expectedVersion, ...answers(o) };
}

export function verifyOnboardingProfile(v: unknown): OnboardingProfile {
  const o = record(v, [...ANSWER_KEYS, 'version', 'updatedAt'], 'profile');
  if (typeof o.version !== 'number' || !Number.isInteger(o.version) || o.version < 1) fail('profile version');
  return { ...answers(o), version: o.version, updatedAt: time(o.updatedAt, 'profile time')! };
}

export function verifySchoolOnboarding(v: unknown): SchoolOnboarding {
  const o = record(v, ['schoolName', 'timezone', 'profile', 'access', 'steps', 'checkedAt'], 'read');
  if (typeof o.schoolName !== 'string' || !o.schoolName || o.schoolName.length > 200) fail('school name');
  if (typeof o.timezone !== 'string' || !o.timezone || o.timezone.length > 64) fail('time zone');
  const a = record(o.access, ['state', 'trialStatus', 'trialEndsAt'], 'access');
  const access: OnboardingAccess = { state: oneOf(a.state, ONBOARDING_ACCESS_STATES, 'access state')!,
    trialStatus: oneOf(a.trialStatus, ['TRIAL_ACTIVE', 'TRIAL_ENDED', 'SUPERSEDED'] as const, 'trial status', true), trialEndsAt: time(a.trialEndsAt, 'trial end', true) };
  if ((access.trialStatus === null) !== (access.trialEndsAt === null)) fail('trial');
  if (!Array.isArray(o.steps) || o.steps.length < 2 || o.steps.length > ONBOARDING_STEP_KEYS.length) fail('steps');
  const seen = new Set<string>();
  const steps = o.steps.map((s): OnboardingStep => {
    const x = record(s, ['key', 'status', 'count', 'firstAt', 'optional', 'skipped'], 'step');
    const key = oneOf(x.key, ONBOARDING_STEP_KEYS, 'step key')!;
    if (seen.has(key)) fail('step key'); seen.add(key);
    if (typeof x.count !== 'number' || !Number.isInteger(x.count) || x.count < 0 || typeof x.optional !== 'boolean' || typeof x.skipped !== 'boolean') fail('step');
    const step: OnboardingStep = { key, status: oneOf(x.status, ONBOARDING_STEP_STATUSES, 'step status')!, count: x.count, firstAt: time(x.firstAt, 'step time', true), optional: x.optional, skipped: x.skipped };
    if (step.status === 'COMPLETE' && (step.firstAt === null || step.count < 1)) fail('step evidence');
    if (step.status === 'COMPLETE' && step.skipped) fail('step skipped');
    if (access.state !== 'ACTIVE' && !['SCHOOL_DETAILS', 'WELCOME', 'INTERFACE'].includes(key) && step.status !== 'UNAVAILABLE') fail('step access');
    return step;
  });
  if (steps[0]?.key !== 'SCHOOL_DETAILS' || steps[1]?.key !== 'WELCOME') fail('step order');
  return { schoolName: o.schoolName, timezone: o.timezone, profile: o.profile === null ? null : verifyOnboardingProfile(o.profile), access, steps, checkedAt: time(o.checkedAt, 'checked time')! };
}
