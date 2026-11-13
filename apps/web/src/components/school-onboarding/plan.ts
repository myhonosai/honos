import {
  type OnboardingAnswers, type OnboardingGoal, type OnboardingProfile, type OnboardingSaveInput, type OnboardingSkippableStep, type OnboardingStep,
  type OnboardingStepKey, type SchoolOnboarding, ONBOARDING_SKIPPABLE_STEPS,
} from '@hon/contracts';

/**
 * Pure onboarding helpers: where each step is done, which goals a step serves, the next step, and the exact answer set a
 * save sends. Presentation only: the server recomputes every step from real records on each read.
 */

/** Where each step's real work happens. Every href is an existing staff page that re-verifies the school itself. */
export const STEP_HREF: Readonly<Partial<Record<OnboardingStepKey, string>>> = {
  PROGRAM: '/staff/launch', CLASS_SCHEDULE: '/staff/schedule/sessions/create', MEMBERSHIP_PLAN: '/staff/billing/membership-plans', FIRST_LEAD: '/staff/crm/leads',
  TRIAL_BOOKED: '/staff/crm/trials', FIRST_STUDENT: '/staff/launch', STAFF: '/staff/team/invitations', IMPORT: '/staff/migration/students',
};

/** Which setup steps move each welcome goal forward. Used for a hint only; it never changes a status. */
const GOAL_STEPS: Readonly<Record<OnboardingGoal, readonly OnboardingStepKey[]>> = {
  MORE_STUDENTS: ['FIRST_LEAD', 'TRIAL_BOOKED'], LEAD_FOLLOW_UP: ['FIRST_LEAD', 'TRIAL_BOOKED'], SIMPLER_OPERATIONS: ['CLASS_SCHEDULE', 'STAFF'],
  SAVE_TIME: ['IMPORT', 'STAFF'], RETENTION: ['FIRST_STUDENT', 'CLASS_SCHEDULE'], MEMBERSHIPS_PAYMENTS: ['MEMBERSHIP_PLAN'],
  REPORTING: ['FIRST_STUDENT', 'IMPORT'], MULTI_LOCATION: ['STAFF'],
};
export const goalsForStep = (key: OnboardingStepKey, goals: readonly OnboardingGoal[]): OnboardingGoal[] => goals.filter((g) => GOAL_STEPS[g].includes(key));

const actionable = (s: OnboardingStep) => s.status !== 'COMPLETE' && s.status !== 'UNAVAILABLE' && !s.skipped;

/** The first required step that is not complete and can be worked on now, in the server's order. */
export function nextStep(onboarding: SchoolOnboarding): OnboardingStep | null {
  return onboarding.steps.find((s) => !s.optional && actionable(s)) ?? null;
}
export function progressOf(onboarding: SchoolOnboarding): { done: number; total: number } {
  const required = onboarding.steps.filter((s) => !s.optional);
  return { done: required.filter((s) => s.status === 'COMPLETE').length, total: required.length };
}
export const canSkip = (s: OnboardingStep) => s.optional && s.status !== 'COMPLETE' && (ONBOARDING_SKIPPABLE_STEPS as readonly string[]).includes(s.key);

export const EMPTY_ANSWERS: OnboardingAnswers = { situation: null, disciplines: [], customDiscipline: null, goals: [], path: null, previousSoftware: null,
  previousSoftwareOther: null, importWishes: [], skippedSteps: [] };
export function answersOf(profile: OnboardingProfile | null): OnboardingAnswers {
  if (!profile) return { ...EMPTY_ANSWERS };
  const { version: _v, updatedAt: _u, ...answers } = profile;
  return { ...answers, disciplines: [...answers.disciplines], goals: [...answers.goals], importWishes: [...answers.importWishes], skippedSteps: [...answers.skippedSteps] };
}

const TEXT_OK = (v: string) => v.length >= 1 && v.length <= 60 && !/[\u0000-\u001f\u007f<>]/.test(v);
/** A free-text answer the server accepts: trimmed, 1 to 60 characters, no control characters or angle brackets. Blank is no answer. */
export function textProblem(value: string | null): boolean { const v = (value ?? '').trim(); return v !== '' && !TEXT_OK(v); }

/** The exact, clean answer set a save sends: dependent answers are cleared when the answer they depend on is not chosen. */
export function cleanAnswers(draft: OnboardingAnswers): OnboardingAnswers | null {
  const text = (v: string | null) => { const t = (v ?? '').trim(); return t === '' ? null : t; };
  if (textProblem(draft.customDiscipline) || textProblem(draft.previousSoftwareOther)) return null;
  const switching = draft.path === 'SWITCHING';
  const previousSoftware = switching ? draft.previousSoftware : null;
  return {
    situation: draft.situation, disciplines: [...new Set(draft.disciplines)], customDiscipline: draft.disciplines.includes('OTHER') ? text(draft.customDiscipline) : null,
    goals: [...new Set(draft.goals)], path: draft.path, previousSoftware, previousSoftwareOther: previousSoftware === 'OTHER' ? text(draft.previousSoftwareOther) : null,
    importWishes: switching ? [...new Set(draft.importWishes)] : [], skippedSteps: [...new Set(draft.skippedSteps)],
  };
}
/** The welcome form never edits skipped steps: they always come from the last saved answers, so a save cannot undo a skip. */
export function saveInputFor(draft: OnboardingAnswers, profile: OnboardingProfile | null): OnboardingSaveInput | null {
  const answers = cleanAnswers(draft);
  return answers ? { expectedVersion: profile?.version ?? 0, ...answers, skippedSteps: [...(profile?.skippedSteps ?? [])] } : null;
}
/** Skipping or bringing back one optional step saves the answers as last saved (never an unsaved draft) with that one change. */
export function skipInputFor(profile: OnboardingProfile | null, key: OnboardingSkippableStep, skip: boolean): OnboardingSaveInput {
  const answers = answersOf(profile);
  const skippedSteps = skip ? [...new Set([...answers.skippedSteps, key])] : answers.skippedSteps.filter((s) => s !== key);
  return { expectedVersion: profile?.version ?? 0, ...answers, skippedSteps };
}
export function toggle<T>(list: readonly T[], value: T, on: boolean): T[] { return on ? [...new Set([...list, value])] : list.filter((v) => v !== value); }

/** A time shown in the school's own time zone (falls back to UTC if the zone is not usable here). */
export function schoolTime(iso: string, timeZone: string, locale: string, dateOnly = false): string {
  const options: Intl.DateTimeFormatOptions = dateOnly ? { dateStyle: 'long' } : { dateStyle: 'medium', timeStyle: 'short' };
  try { return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(iso)); }
  catch { return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(new Date(iso)); }
}
