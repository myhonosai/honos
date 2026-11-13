import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { OnboardingProfile, OnboardingStep, SchoolOnboarding } from '@hon/contracts';
import { ONBOARDING_LANGUAGES, onboardingText } from '../src/components/school-onboarding/copy';
import { OnboardingError, keepForRetry, onboardingApi, onboardingErrorFor } from '../src/components/school-onboarding/http';
import { EMPTY_ANSWERS, cleanAnswers, goalsForStep, nextStep, progressOf, saveInputFor, schoolTime, skipInputFor, textProblem } from '../src/components/school-onboarding/plan';
import { SchoolOnboardingView, type SchoolOnboardingViewProps } from '../src/components/school-onboarding/view';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), key = id(77), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as OnboardingError; } throw new Error('expected a failure'); };

const answers = { situation: 'NEW_SCHOOL', disciplines: ['KARATE'], customDiscipline: null, goals: ['MORE_STUDENTS'], path: 'NEW', previousSoftware: null,
  previousSoftwareOther: null, importWishes: [], skippedSteps: [] } as const;
const profile = (over: Partial<OnboardingProfile> = {}): OnboardingProfile => ({ ...answers, disciplines: ['KARATE'], goals: ['MORE_STUDENTS'], importWishes: [], skippedSteps: [],
  version: 1, updatedAt: '2026-11-13T07:00:00.000Z', ...over });
const step = (key: OnboardingStep['key'], status: OnboardingStep['status'] = 'NOT_STARTED', over: Partial<OnboardingStep> = {}): OnboardingStep =>
  ({ key, status, count: status === 'COMPLETE' ? 1 : 0, firstAt: status === 'COMPLETE' ? '2026-11-13T06:00:00.000Z' : null, optional: false, skipped: false, ...over });
const preAccess = (): SchoolOnboarding => ({ schoolName: 'Synthetic Dojo', timezone: 'America/Chicago', profile: null,
  access: { state: 'NOT_STARTED', trialStatus: null, trialEndsAt: null },
  steps: [step('SCHOOL_DETAILS', 'COMPLETE'), step('WELCOME'), step('INTERFACE'), step('PROGRAM', 'UNAVAILABLE'), step('STAFF', 'UNAVAILABLE', { optional: true })],
  checkedAt: '2026-11-13T07:00:00.000Z' });
const active = (over: Partial<SchoolOnboarding> = {}): SchoolOnboarding => ({ ...preAccess(), profile: profile(),
  access: { state: 'ACTIVE', trialStatus: 'TRIAL_ACTIVE', trialEndsAt: '2026-11-27T05:30:00.000Z' },
  steps: [step('SCHOOL_DETAILS', 'COMPLETE'), step('WELCOME', 'COMPLETE'), step('INTERFACE', 'COMPLETE'), step('PROGRAM', 'IN_PROGRESS'), step('FIRST_LEAD'),
    step('TRIAL_BOOKED', 'NOT_STARTED', { optional: true }), step('STAFF', 'NOT_STARTED', { optional: true, skipped: true })], ...over });

it('reads with a plain same-origin GET (no query, no key, no command header) and verifies the answer', async () => {
  const f = stub(json({ data: preAccess(), meta }));
  const read = await onboardingApi.read({ organizationId: org.toUpperCase(), schoolId: school }, signal(), () => true);
  expect(read.access.state).toBe('NOT_STARTED');
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/onboarding`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  // A school-data step claiming progress before access starts is not believed.
  stub(json({ data: { ...preAccess(), steps: [step('SCHOOL_DETAILS', 'COMPLETE'), step('WELCOME'), step('PROGRAM', 'COMPLETE')] }, meta }));
  expect((await fails(onboardingApi.read(scope, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ code: 'ONBOARDING_FORBIDDEN' }, 403));
  expect((await fails(onboardingApi.read(scope, signal(), () => true))).kind).toBe('DENIED');
  expect((await fails(onboardingApi.read({ organizationId: 'x', schoolId: school }, signal(), () => true))).kind).toBe('INVALID');
});

it('saves the closed answer set with its own command and key, and accepts only the version it created', async () => {
  const input = { expectedVersion: 0, ...answers, disciplines: ['KARATE' as const], goals: ['MORE_STUDENTS' as const], importWishes: [], skippedSteps: [] };
  const f = stub(json({ data: profile(), meta: { ...meta, replayed: false } }));
  await expect(onboardingApi.save(scope, input, key, signal(), () => true)).resolves.toMatchObject({ version: 1 });
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/onboarding/profile`);
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'onboarding.profile.save', 'Idempotency-Key': key, 'Content-Type': 'application/json' });
  expect(JSON.parse(init.body as string)).toEqual(input);
  stub(json({ data: profile({ version: 3 }), meta }));
  expect((await fails(onboardingApi.save(scope, input, key, signal(), () => true))).kind).toBe('UNKNOWN');
  const g = stub(json({}));
  expect((await fails(onboardingApi.save(scope, { ...input, goals: ['BOSS' as never] }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(onboardingApi.save(scope, input, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect(g).not.toHaveBeenCalled();
  stub(json({ code: 'VERSION_CONFLICT' }, 409));
  expect((await fails(onboardingApi.save(scope, input, key, signal(), () => true))).kind).toBe('CHANGED');
});

it('maps refusals to definitive kinds, and keeps a save for retry only when its outcome is unknown', () => {
  expect(onboardingErrorFor(403, 'ONBOARDING_FORBIDDEN').kind).toBe('DENIED');
  expect(onboardingErrorFor(400, 'ONBOARDING_INVALID').kind).toBe('INVALID');
  expect(onboardingErrorFor(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('INVALID');
  expect(onboardingErrorFor(409, 'ONBOARDING_BUSY').kind).toBe('UNKNOWN');
  expect(onboardingErrorFor(503, 'ONBOARDING_UNAVAILABLE').kind).toBe('UNKNOWN');
  expect(keepForRetry(new OnboardingError('UNKNOWN'))).toBe(true); expect(keepForRetry(new OnboardingError('RATE'))).toBe(true);
  expect(keepForRetry(new OnboardingError('CHANGED'))).toBe(false); expect(keepForRetry(new OnboardingError('DENIED'))).toBe(false);
});

it('sends clean answers: dependent answers cleared, skips kept from the last save, and only valid free text', () => {
  const draft = { ...EMPTY_ANSWERS, disciplines: ['KARATE' as const], customDiscipline: 'Yudo', path: 'NEW' as const, previousSoftware: 'SPARK' as const,
    importWishes: ['STUDENTS' as const], skippedSteps: [] };
  expect(cleanAnswers(draft)).toMatchObject({ customDiscipline: null, previousSoftware: null, importWishes: [] });
  const switching = { ...draft, disciplines: ['OTHER' as const], customDiscipline: '  Yudo ', path: 'SWITCHING' as const, previousSoftware: 'OTHER' as const, previousSoftwareOther: '' };
  expect(cleanAnswers(switching)).toMatchObject({ customDiscipline: 'Yudo', previousSoftware: 'OTHER', previousSoftwareOther: null, importWishes: ['STUDENTS'] });
  expect(saveInputFor(switching, profile({ version: 4, skippedSteps: ['STAFF'] }))).toMatchObject({ expectedVersion: 4, skippedSteps: ['STAFF'] });
  expect(saveInputFor({ ...switching, customDiscipline: '<b>' }, null)).toBeNull();
  expect(textProblem('a'.repeat(61))).toBe(true); expect(textProblem('   ')).toBe(false); expect(textProblem('Kendo')).toBe(false);
  expect(skipInputFor(profile({ version: 2 }), 'TRIAL_BOOKED', true)).toMatchObject({ expectedVersion: 2, situation: 'NEW_SCHOOL', skippedSteps: ['TRIAL_BOOKED'] });
  expect(skipInputFor(profile({ skippedSteps: ['STAFF', 'IMPORT'] }), 'STAFF', false).skippedSteps).toEqual(['IMPORT']);
  expect(skipInputFor(null, 'STAFF', true)).toMatchObject({ expectedVersion: 0, situation: null, skippedSteps: ['STAFF'] });
});

it('picks the next required step and counts only required steps, never trusting a visit', () => {
  const o = active();
  expect(nextStep(o)?.key).toBe('PROGRAM');
  expect(progressOf(o)).toEqual({ done: 3, total: 5 });
  expect(nextStep(preAccess())?.key).toBe('WELCOME');
  expect(goalsForStep('FIRST_LEAD', ['MORE_STUDENTS', 'RETENTION'])).toEqual(['MORE_STUDENTS']);
  expect(schoolTime('2026-11-27T05:30:00.000Z', 'America/Chicago', 'en-US', true)).toBe('November 26, 2026');
  expect(schoolTime('2026-11-27T05:30:00.000Z', 'Not/AZone', 'en-US', true)).toBe('November 27, 2026');
});

const base = (over: Partial<SchoolOnboardingViewProps> = {}): SchoolOnboardingViewProps => ({ language: 'en', locale: 'en-US', waiting: false, concealed: false, hasSchool: true,
  read: { state: 'READY', onboarding: active() }, draft: EMPTY_ANSWERS, editing: false, outcome: null, locked: false, canRetry: false,
  mode: 'modern', modeState: 'IDLE', languageBlocked: false, ...over });

it('shows nothing from the school while waiting, hidden, with no school, or refused', () => {
  for (const over of [{ waiting: true }, { concealed: true }, { hasSchool: false }, { read: { state: 'DENIED' as const } }, { read: { state: 'UNAVAILABLE' as const } }]) {
    const html = renderToStaticMarkup(<SchoolOnboardingView {...base(over)} />);
    expect(html).not.toContain('data-onboarding-checklist'); expect(html).not.toContain('Synthetic Dojo');
  }
});

it('before access starts: welcome and view are open, school-data steps say they open later and link nowhere, and the trial link shows', () => {
  const html = renderToStaticMarkup(<SchoolOnboardingView {...base({ read: { state: 'READY', onboarding: preAccess() } })} />);
  expect(html).toContain('data-onboarding-access="NOT_STARTED"'); expect(html).toContain('href="/account/start"');
  expect(html).toContain('data-onboarding-form'); expect(html).toContain('Opens when your access is active');
  expect(html).not.toContain('href="/staff/launch"'); expect(html).not.toContain('Skip for now');
  expect(html).toContain('Next step: Welcome questions'); expect(html).toContain('data-mode="big-button"');
});

it('with access: trial end in the school time zone, saved answers as a summary, the next step linked, and optional steps skippable', () => {
  const html = renderToStaticMarkup(<SchoolOnboardingView {...base()} />);
  expect(html).toContain('Your trial ends November 26, 2026.');
  expect(html).not.toContain('data-onboarding-form'); expect(html).toContain('Opening a new school'); expect(html).toContain('Change answers');
  expect(html).toMatch(/data-step="PROGRAM"[^>]*data-next="true"/); expect(html).toContain('href="/staff/launch"');
  expect(html).toContain('3 of 5 required steps complete'); expect(html).toContain('Helps with: Get more students');
  expect(html).toContain('Bring back'); expect(html).toContain('Skip for now');
  const done = html.match(/<li[^>]*data-step="INTERFACE"[^]*?<\/li>/)?.[0] ?? '';
  expect(done).toContain('Complete'); expect(done).not.toContain('href=');
});

it('the switching path asks what they use and what to bring over, and says honestly what imports exist today', () => {
  const draft = { ...EMPTY_ANSWERS, path: 'SWITCHING' as const, previousSoftware: 'OTHER' as const, previousSoftwareOther: 'x>y' };
  const html = renderToStaticMarkup(<SchoolOnboardingView {...base({ read: { state: 'READY', onboarding: active({ profile: null }) }, draft })} />);
  expect(html).toContain('What do you use today?'); expect(html).toContain('Zen Planner'); expect(html).toContain('Attendance history');
  expect(html).toContain('data-onboarding-import-note'); expect(html).toContain('Use 1 to 60 characters');
  expect(html).toMatch(/<button type="submit"[^>]*disabled/);
});

it('an unknown save offers Try again; a done save says saved', () => {
  expect(renderToStaticMarkup(<SchoolOnboardingView {...base({ outcome: { kind: 'UNKNOWN' }, canRetry: true, locked: true })} />)).toContain('Try again');
  expect(renderToStaticMarkup(<SchoolOnboardingView {...base({ outcome: { kind: 'DONE' } })} />)).toContain('Answers saved.');
  expect(renderToStaticMarkup(<SchoolOnboardingView {...base({ modeState: 'FAILED' })} />)).toContain('Your view could not be saved');
});

it('has every wording in English, Korean and Spanish, a staff route, and saves the view as an onboarding choice', () => {
  const keys = Object.keys(ONBOARDING_LANGUAGES.en).sort();
  expect(Object.keys(ONBOARDING_LANGUAGES.ko).sort()).toEqual(keys); expect(Object.keys(ONBOARDING_LANGUAGES.es).sort()).toEqual(keys);
  for (const table of Object.values(ONBOARDING_LANGUAGES)) expect(Object.values(table).every(v => v.trim().length > 0)).toBe(true);
  expect(onboardingText('ko', 'title')).toBe('HON에 오신 것을 환영합니다');
  expect(renderToStaticMarkup(<SchoolOnboardingView {...base({ language: 'es' })} />)).toContain('Su lista de configuración');
  expect(SCHOOL_SHELL_NAV.flatMap(g => g.routes.map(r => r.href))).toContain('/staff/welcome');
  expect(schoolShellActiveRoute('/staff/welcome')?.href).toBe('/staff/welcome');
  expect(readFileSync('src/app/staff/welcome/page.tsx', 'utf8')).toContain('await requireVerifiedWebSession()');
  expect(readFileSync('public/manus-routes.json', 'utf8')).toContain('"/staff/welcome"');
  const controller = readFileSync('src/components/school-onboarding/welcome.tsx', 'utf8');
  expect(controller).toContain("shell.onMode(mode, 'ONBOARDING')"); expect(controller).toContain('data-shell-private');
  expect(readFileSync('src/components/school-shell/shell.tsx', 'utf8')).toContain('onMode: saveMode');
});
