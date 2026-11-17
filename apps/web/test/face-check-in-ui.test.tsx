import React from 'react';
import { existsSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validateFaceCheckInRead, validateFamilyFaceCheckInRead, type FaceCheckInRead, type FamilyFaceCheckInRead } from '@hon/contracts';
import { FaceError, faceApi, faceErrorFor, familyFaceApi, keepFaceForRetry } from '../src/components/face-check-in/http';
import { faceCodeText, faceText } from '../src/components/face-check-in/copy';
import { faceErrorText } from '../src/components/face-check-in/commands';
import { FaceSettingsView, canTurnOn, chosenAnswer, studentActions, type FaceSettingsViewProps } from '../src/components/face-check-in/settings';
import { FaceScanView, decisionText, fileToPicture, type FaceScanViewProps } from '../src/components/face-check-in/scan';
import { FamilyFaceCheckInView, childActions, type FamilyViewProps } from '../src/components/face-check-in/family';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const school = id(2), key = id(77), at = '2026-11-17T03:00:00.000Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as FaceError; } throw new Error('expected a failure'); };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];

const digest = (n: number) => n.toString(16).padStart(64, '0');
const forms = (profile: string) => (['en', 'ko', 'es'] as const).map((language, i) => ({ formId: 10 + i, profile, language, version: 1, title: `Form ${language}`, body: `Body ${language}\nline two`, digest: digest(i + 1), reviewStatus: 'TEST_ONLY_DRAFT' }));
const consent = (state: 'GIVEN' | 'RENEW' | 'WITHDRAWN', method: 'PARENT_PORTAL' | 'IN_PERSON' = 'IN_PERSON') => ({ consentId: id(50), state, formId: 10, signerKind: 'GUARDIAN', method, version: 1, signedAt: at, withdrawnAt: state === 'WITHDRAWN' ? at : null });
const studentRow = (n: number, extra: Record<string, unknown> = {}) => ({ studentProfileId: id(n), givenName: `Kid${n}`, familyName: 'Synthetic', studentStatus: 'ACTIVE', adult: false, hasPhoto: true, consent: null, enrolled: false, enrolledAt: null, ...extra });
const notice = (profile: string | null, status = 'AVAILABLE_WITH_CONSENT') => ({ profile, status, laws: profile ? ['Synthetic law'] : [], addOns: [], reviewStatus: 'TEST_ONLY_DRAFT', rulesVersion: 1 });
const NY_CHOICES = [{ cityLimits: 'NONE', profile: 'US_GENERAL', status: 'AVAILABLE_WITH_CONSENT', acknowledgements: ['ALTERNATIVE_CHECK_IN_OFFERED', 'RETENTION_POLICY_PUBLISHED'] },
  { cityLimits: 'US_NYC', profile: 'US_NYC', status: 'AVAILABLE_WITH_CONSENT', acknowledgements: ['ALTERNATIVE_CHECK_IN_OFFERED', 'ENTRANCE_SIGN_POSTED', 'RETENTION_POLICY_PUBLISHED'] }];
function rawRead(o: { program?: string; on?: boolean; choices?: unknown[]; students?: unknown[]; noticeStatus?: string } = {}) {
  const on = o.on ?? false;
  return { program: o.program ?? 'TEST_MODE', matcher: 'SYNTHETIC', addressNotice: notice('US_GENERAL', o.noticeStatus), choices: o.choices ?? NY_CHOICES,
    settings: { status: on ? 'ON' : 'OFF', profile: on ? 'US_GENERAL' : null, cityLimits: on ? 'NONE' : null, acknowledgements: on ? ['ALTERNATIVE_CHECK_IN_OFFERED', 'RETENTION_POLICY_PUBLISHED'] : [],
      offReason: null, version: on ? 1 : 0, updatedAt: on ? at : null },
    forms: on ? forms('US_GENERAL') : [], deletionsLast30Days: 2, students: o.students ?? [studentRow(10)] };
}
const read = (o?: Parameters<typeof rawRead>[0]): FaceCheckInRead => validateFaceCheckInRead(rawRead(o));
const familyRaw = (o: { on?: boolean; canSign?: boolean; children?: unknown[]; program?: string } = {}) => ({ program: o.program ?? 'TEST_MODE', schoolStatus: o.on === false ? 'OFF' : 'ON',
  canSign: o.canSign ?? o.on !== false, canWithdraw: o.canSign ?? o.on !== false, forms: o.on === false ? [] : forms('US_GENERAL'),
  children: o.children ?? [{ studentProfileId: id(10), givenName: 'Kid10', familyName: 'Synthetic', consent: null, enrolled: false }] });
const family = (o?: Parameters<typeof familyRaw>[0]): FamilyFaceCheckInRead => validateFamilyFaceCheckInRead(familyRaw(o));

it('only exact refusals are definitive; unknown and busy keep the exact request', () => {
  expect(faceErrorFor(403, 'FACE_CHECKIN_OFF').kind).toBe('DENIED');
  expect(faceErrorFor(404, 'FACE_CHECKIN_MATCH_NOT_FOUND').kind).toBe('MISSING');
  expect(faceErrorFor(404, null).kind).toBe('UNKNOWN');
  expect(faceErrorFor(400, 'FACE_CHECKIN_ADULT_SIGNS').kind).toBe('INVALID');
  expect(faceErrorFor(409, 'FACE_CHECKIN_FORM_CHANGED').kind).toBe('CONFLICT');
  expect(faceErrorFor(409, 'FACE_CHECKIN_VERSION_CONFLICT').kind).toBe('CONFLICT');
  expect(faceErrorFor(409, 'FACE_CHECKIN_KEY_REUSED').kind).toBe('INVALID');
  expect(faceErrorFor(409, 'SOMETHING_ELSE').kind).toBe('UNKNOWN');
  expect(faceErrorFor(503, 'FACE_CHECKIN_BUSY').kind).toBe('BUSY');
  expect(faceErrorFor(503, 'FACE_CHECKIN_UNAVAILABLE').kind).toBe('UNKNOWN');
  expect(keepFaceForRetry(new FaceError('UNKNOWN'))).toBe(true); expect(keepFaceForRetry(new FaceError('BUSY'))).toBe(true);
  expect(keepFaceForRetry(new FaceError('DENIED'))).toBe(false); expect(keepFaceForRetry(new Error('x'))).toBe(true);
});

it('refusals show the server code in plain words when HON explains it, in each language', () => {
  expect(faceErrorText('en', new FaceError('INVALID', 'FACE_CHECKIN_ADULT_SIGNS'))).toBe('This student is 18 or older and signs for themselves.');
  expect(faceErrorText('es', new FaceError('DENIED', 'FACE_CHECKIN_OFF'))).toBe('El registro facial está desactivado en esta escuela.');
  expect(faceErrorText('ko', new FaceError('DENIED', null))).toBe(faceText('ko', 'outDenied'));
  // An unknown outcome never shows a definitive code.
  expect(faceErrorText('en', new FaceError('UNKNOWN', 'FACE_CHECKIN_OFF'))).toBe(faceText('en', 'outUnknown'));
  expect(faceCodeText('en', 'title')).toBeNull(); expect(faceCodeText('en', 'NOT_A_CODE')).toBeNull();
});

it('the staff read names the school in the path only and checks the answer', async () => {
  const f = stub(json({ data: rawRead() }));
  const out = await faceApi.read(school, signal(), () => true);
  expect(out.choices).toHaveLength(2);
  const [path, init] = call(f);
  expect(path).toBe(`/api/v1/school/schools/${school}/face-check-in`);
  expect(init.method).toBe('GET'); expect(init.body).toBeUndefined(); expect(init.headers).not.toHaveProperty('Idempotency-Key');
  stub(json({ data: { ...rawRead(), matcher: 'REAL' } }));
  expect((await fails(faceApi.read(school, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ code: 'FACE_CHECKIN_FORBIDDEN' }, 403));
  expect((await fails(faceApi.read(school, signal(), () => true))).kind).toBe('DENIED');
  expect((await fails(faceApi.read('not-a-school', signal(), () => true))).kind).toBe('INVALID');
});

it('turning on sends one closed body with the manage marker and key; an answer that does not match is unknown', async () => {
  const settings = { status: 'ON', profile: 'US_NYC', cityLimits: 'US_NYC', acknowledgements: ['ALTERNATIVE_CHECK_IN_OFFERED'], offReason: null, version: 1, updatedAt: at, templatesDeleted: 0 };
  const f = stub(json({ data: { record: settings, replayed: false } }));
  const input = { schoolId: school, expectedVersion: 0, enabled: true, cityLimits: 'US_NYC', acknowledgements: ['ALTERNATIVE_CHECK_IN_OFFERED'] as const };
  await faceApi.saveSettings(input, key, signal(), () => true);
  const [path, init] = call(f);
  expect(path).toBe('/api/v1/school/face-check-in/settings');
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'face-checkin', 'Idempotency-Key': key, 'Content-Type': 'application/json' });
  expect(JSON.parse(init.body as string)).toEqual(input);
  stub(json({ data: { record: { ...settings, status: 'OFF', profile: null, cityLimits: null, acknowledgements: [], offReason: 'OWNER' }, replayed: false } }));
  expect((await fails(faceApi.saveSettings(input, key, signal(), () => true))).kind).toBe('UNKNOWN');
  // Off may not carry an answer: refused here, nothing sent.
  const g = stub(json({}));
  expect((await fails(faceApi.saveSettings({ ...input, enabled: false }, key, signal(), () => true))).kind).toBe('INVALID');
  expect(g).not.toHaveBeenCalled();
});

it('a paper consent carries the exact form digest and witness; the reply must be for that student', async () => {
  const f = stub(json({ data: { record: { studentProfileId: id(10), consent: consent('GIVEN') }, replayed: false } }));
  const input = { schoolId: school, studentProfileId: id(10), formId: 10, formDigest: digest(1), signerKind: 'GUARDIAN' as const, signerName: 'Pat Synthetic', witnessAttested: true as const };
  await faceApi.recordConsent(input, key, signal(), () => true);
  expect(JSON.parse(call(f)[1].body as string)).toEqual(input);
  stub(json({ data: { record: { studentProfileId: id(11), consent: consent('GIVEN') }, replayed: false } }));
  expect((await fails(faceApi.recordConsent(input, key, signal(), () => true))).kind).toBe('UNKNOWN');
  expect((await fails(faceApi.recordConsent({ ...input, signerName: '<b>x</b>' }, key, signal(), () => true))).kind).toBe('INVALID');
});

it('a scan sends the picture with the scan marker; a confirm that says CONFIRMED to a No is unknown', async () => {
  const match = { matchId: id(60), sessionId: id(40), outcome: 'PROPOSED', student: { studentProfileId: id(10), givenName: 'Kid10', familyName: 'Synthetic' }, proposedAt: at };
  const f = stub(json({ data: { record: match, replayed: false } }));
  const out = await faceApi.match({ schoolId: school, sessionId: id(40), mediaType: 'image/jpeg', data: 'AAAA' }, key, signal(), () => true);
  expect(out.student?.givenName).toBe('Kid10');
  expect(call(f)[0]).toBe('/api/v1/school/face-check-in/match');
  expect(call(f)[1].headers).toMatchObject({ 'X-HON-Human-Command': 'face-checkin-scan' });
  stub(json({ data: { record: { ...match, sessionId: id(41) }, replayed: false } }));
  expect((await fails(faceApi.match({ schoolId: school, sessionId: id(40), mediaType: 'image/jpeg', data: 'AAAA' }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  const confirmed = { matchId: id(60), sessionId: id(40), studentProfileId: id(10), outcome: 'CONFIRMED', checkIn: { outcome: 'RECORDED', attendance: { id: id(70), status: 'PRESENT', version: 1, recordedAt: at } } };
  const g = stub(json({ data: { record: confirmed, replayed: false } }));
  await faceApi.confirm({ schoolId: school, matchId: id(60), accept: true, status: 'PRESENT' }, key, signal(), () => true);
  expect(call(g)[1].headers).toMatchObject({ 'X-HON-Human-Command': 'face-checkin-scan' });
  stub(json({ data: { record: confirmed, replayed: false } }));
  expect((await fails(faceApi.confirm({ schoolId: school, matchId: id(60), accept: false, status: 'PRESENT' }, key, signal(), () => true))).kind).toBe('UNKNOWN');
});

it('the parent portal names no family, school or child, and each command has its own marker', async () => {
  const f = stub(json({ data: familyRaw() }));
  await familyFaceApi.read(signal(), () => true);
  expect(call(f)[0]).toBe('/api/v1/parent/face-check-in');
  expect(call(f)[1].method).toBe('GET');
  const g = stub(json({ data: { record: { studentProfileId: id(10), consent: consent('GIVEN', 'PARENT_PORTAL') }, replayed: false } }));
  await familyFaceApi.sign({ studentProfileId: id(10), formId: 10, formDigest: digest(1), signerName: 'Pat Synthetic' }, key, signal(), () => true);
  expect(call(g)[0]).toBe('/api/v1/parent/face-check-in/sign');
  expect(call(g)[1].headers).toMatchObject({ 'X-HON-Human-Command': 'family-face-checkin', 'Idempotency-Key': key });
  expect(Object.keys(JSON.parse(call(g)[1].body as string)).sort()).toEqual(['formDigest', 'formId', 'signerName', 'studentProfileId']);
  const h = stub(json({ data: { record: { studentProfileId: id(10), consent: consent('WITHDRAWN', 'PARENT_PORTAL') }, replayed: false } }));
  await familyFaceApi.withdraw(id(50), 1, key, signal(), () => true);
  expect(call(h)[0]).toBe('/api/v1/parent/face-check-in/withdraw');
  expect(call(h)[1].headers).toMatchObject({ 'X-HON-Human-Command': 'family-face-checkin-withdraw' });
  stub(json({ data: { record: { studentProfileId: id(10), consent: consent('GIVEN', 'PARENT_PORTAL') }, replayed: false } }));
  expect((await fails(familyFaceApi.withdraw(id(50), 1, key, signal(), () => true))).kind).toBe('UNKNOWN');
});

it('turning on needs test mode, an available answer and every step that answer requires', () => {
  const r = read();
  expect(chosenAnswer(r.choices, undefined)).toBeNull();
  const nyc = chosenAnswer(r.choices, 'US_NYC')!;
  expect(nyc.profile).toBe('US_NYC');
  expect(canTurnOn(r, nyc, new Set(['ALTERNATIVE_CHECK_IN_OFFERED', 'RETENTION_POLICY_PUBLISHED']))).toBe(false);
  expect(canTurnOn(r, nyc, new Set(['ALTERNATIVE_CHECK_IN_OFFERED', 'RETENTION_POLICY_PUBLISHED', 'ENTRANCE_SIGN_POSTED']))).toBe(true);
  expect(canTurnOn(read({ program: 'CLOSED' }), nyc, new Set(nyc.acknowledgements))).toBe(false);
  const only = read({ choices: [{ cityLimits: null, profile: 'US_IL_BIPA', status: 'AVAILABLE_WITH_CONSENT', acknowledgements: ['ALTERNATIVE_CHECK_IN_OFFERED'] }] });
  expect(chosenAnswer(only.choices, undefined)?.profile).toBe('US_IL_BIPA');
  const abroad = read({ choices: [{ cityLimits: null, profile: 'EU_GDPR', status: 'NOT_LAUNCHED', acknowledgements: [] }] });
  expect(canTurnOn(abroad, chosenAnswer(abroad.choices, undefined), new Set())).toBe(false);
});

it('a student row offers paper consent, withdrawal and set-up only when each is possible', () => {
  const r = read({ on: true, students: [studentRow(10), studentRow(11, { consent: consent('GIVEN') }), studentRow(12, { consent: consent('GIVEN'), hasPhoto: false }),
    studentRow(13, { consent: consent('GIVEN'), enrolled: true, enrolledAt: at }), studentRow(14, { consent: consent('RENEW') })] });
  expect(r.students.map(studentActions)).toEqual([
    { record: true, withdraw: false, enroll: 'NEEDS_CONSENT' }, { record: false, withdraw: true, enroll: 'READY' }, { record: false, withdraw: true, enroll: 'NEEDS_PHOTO' },
    { record: false, withdraw: true, enroll: 'DONE' }, { record: true, withdraw: true, enroll: 'NEEDS_CONSENT' }]);
});

const settingsProps = (o: Partial<FaceSettingsViewProps> = {}): FaceSettingsViewProps => ({ language: 'en', state: { state: 'READY', read: read() }, picked: undefined, acks: new Set(),
  formLanguage: 'en', paper: null, confirm: null, outcome: null, busy: false, ...o });

it('the settings page asks the city-limits question and lists only the steps the chosen answer needs', () => {
  const closed = renderToStaticMarkup(<FaceSettingsView {...settingsProps({ state: { state: 'READY', read: read({ program: 'CLOSED' }) }, picked: 'NONE', acks: new Set(['ALTERNATIVE_CHECK_IN_OFFERED', 'RETENTION_POLICY_PUBLISHED']) })}/>);
  expect(closed).toContain(faceText('en', 'programClosed'));
  expect(closed).toMatch(/data-testid="face-turn-on"[^>]*disabled=""|disabled=""[^>]*data-testid="face-turn-on"/);
  const html = renderToStaticMarkup(<FaceSettingsView {...settingsProps({ picked: 'US_NYC' })}/>);
  expect(html).toContain('Inside New York City'); expect(html).toContain('Outside those city limits');
  expect(html).toContain('A clear sign at our entrance');
  expect(html).not.toContain('impact assessment');
  expect(html).toContain('Face check-in at your address');
  const ready = renderToStaticMarkup(<FaceSettingsView {...settingsProps({ picked: 'NONE', acks: new Set(['ALTERNATIVE_CHECK_IN_OFFERED', 'RETENTION_POLICY_PUBLISHED']) })}/>);
  expect(ready).not.toMatch(/data-testid="face-turn-on"[^>]*disabled=""|disabled=""[^>]*data-testid="face-turn-on"/);
  const abroad = renderToStaticMarkup(<FaceSettingsView {...settingsProps({ state: { state: 'READY', read: read({ choices: [{ cityLimits: null, profile: 'EU_GDPR', status: 'NOT_LAUNCHED', acknowledgements: [] }] }) } })}/>);
  expect(abroad).toContain('United States only');
  const noAddress = renderToStaticMarkup(<FaceSettingsView {...settingsProps({ state: { state: 'READY', read: read({ choices: [], noticeStatus: 'LOCATION_REQUIRED' }) } })}/>);
  expect(noAddress).toContain('href="/staff/settings/location"');
});

it('when on, the page shows the draft form and each student row, and the paper form names who signs', () => {
  const r = read({ on: true, students: [studentRow(10), studentRow(11, { adult: true, givenName: 'Adult11' })] });
  const html = renderToStaticMarkup(<FaceSettingsView {...settingsProps({ state: { state: 'READY', read: r }, formLanguage: 'ko', paper: { studentProfileId: id(11), formId: 11, signerName: '', witnessed: false } })}/>);
  expect(html).toContain('Form ko'); expect(html).toContain(faceText('en', 'draft'));
  expect(html).toContain('Paper consent for Adult11 Synthetic'); expect(html).toContain('The student (18 or older)');
  expect(html).toContain(faceText('en', 'witness'));
  expect(html.match(/data-testid="face-student"/g)).toHaveLength(2);
  const es = renderToStaticMarkup(<FaceSettingsView {...settingsProps({ language: 'es', state: { state: 'READY', read: r }, confirm: { kind: 'TURN_OFF' } })}/>);
  expect(es).toContain('¿Desactivar el registro facial?');
  const ko = renderToStaticMarkup(<FaceSettingsView {...settingsProps({ language: 'ko', state: { state: 'DENIED' } })}/>);
  expect(ko).toContain('이 학교의 얼굴 체크인 설정 권한이 없습니다.');
});

const scanProps = (o: Partial<FaceScanViewProps> = {}): FaceScanViewProps => ({ language: 'en', sessions: { state: 'READY', sessions: [] }, sessionId: id(40), status: 'PRESENT',
  camera: 'OFF', proposal: null, outcome: null, busy: false, ...o });

it('a proposal records nothing until staff say Yes; the decision reads plainly', () => {
  const match = { matchId: id(60), sessionId: id(40), outcome: 'PROPOSED' as const, student: { studentProfileId: id(10), givenName: 'Kid10', familyName: 'Synthetic' }, proposedAt: at, replayed: false };
  const html = renderToStaticMarkup(<FaceScanView {...scanProps({ proposal: { match, preview: 'data:image/jpeg;base64,AAAA' } })}/>);
  expect(html).toContain('Is this Kid10 Synthetic?'); expect(html).toContain('data-testid="face-yes"'); expect(html).toContain('data-testid="face-no"');
  expect(html).toContain(faceText('en', 'pictureNote')); expect(html).toContain(faceText('en', 'staffOnly'));
  expect(decisionText('en', { outcome: 'CONFIRMED', checkIn: { outcome: 'RECORDED', attendance: { status: 'LATE' } } }, 'Kid10 Synthetic')).toEqual({ tone: 'ok', text: 'Kid10 Synthetic checked in (Late).' });
  expect(decisionText('es', { outcome: 'REJECTED', checkIn: null }, 'x').text).toBe(faceText('es', 'REJECTED'));
  expect(decisionText('ko', { outcome: 'EXPIRED', checkIn: null }, 'x')).toEqual({ tone: 'blocked', text: faceText('ko', 'EXPIRED') });
  expect(renderToStaticMarkup(<FaceScanView {...scanProps({ sessions: { state: 'DENIED' } })}/>)).toContain(faceText('en', 'scanDenied'));
});

it('a test photo file is sent as it is, and only a supported image within the size limit', async () => {
  const png = new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: 'image/png' });
  expect(await fileToPicture(png)).toEqual({ mediaType: 'image/png', data: btoa(String.fromCharCode(137, 80, 78, 71, 1, 2, 3)) });
  expect(await fileToPicture(new Blob(['abcdef'], { type: 'image/gif' }))).toBeNull();
  expect(await fileToPicture(new Blob([new Uint8Array(400_001)], { type: 'image/jpeg' }))).toBeNull();
});

const familyProps = (o: Partial<FamilyViewProps> = {}): FamilyViewProps => ({ language: 'en', state: { state: 'READY', read: family() }, formLanguage: 'en', draft: null, confirmWithdraw: null,
  outcome: null, busy: false, ...o });

it('the parent page shows the draft form, signs only after reading and typing a name, and explains when there is nothing to sign', () => {
  const html = renderToStaticMarkup(<FamilyFaceCheckInView {...familyProps({ formLanguage: 'es' })}/>);
  expect(html).toContain('Form es'); expect(html).toContain('Sign for Kid10 Synthetic'); expect(html).toContain(faceText('en', 'draft'));
  const drafting = renderToStaticMarkup(<FamilyFaceCheckInView {...familyProps({ draft: { studentProfileId: id(10), read: false, signerName: 'Pat Synthetic' } })}/>);
  expect(drafting).toContain(faceText('en', 'iHaveRead'));
  expect(drafting).toMatch(/<button[^>]*disabled=""[^>]*>Sign for Kid10 Synthetic/);
  const ok = renderToStaticMarkup(<FamilyFaceCheckInView {...familyProps({ draft: { studentProfileId: id(10), read: true, signerName: 'Pat Synthetic' } })}/>);
  expect(ok).not.toMatch(/<button[^>]*disabled=""[^>]*>Sign for Kid10 Synthetic/);
  expect(renderToStaticMarkup(<FamilyFaceCheckInView {...familyProps({ state: { state: 'READY', read: family({ on: false }) } })}/>)).toContain(faceText('en', 'famOff'));
  const viewer = renderToStaticMarkup(<FamilyFaceCheckInView {...familyProps({ language: 'ko', state: { state: 'READY', read: family({ canSign: false }) } })}/>);
  expect(viewer).toContain(faceText('ko', 'famViewer')); expect(viewer).not.toContain('대신 서명');
});

it('a parent can withdraw a current consent and sign again after a renewal or withdrawal', () => {
  const r = family({ children: [
    { studentProfileId: id(10), givenName: 'A', familyName: 'S', consent: consent('GIVEN', 'PARENT_PORTAL'), enrolled: true },
    { studentProfileId: id(11), givenName: 'B', familyName: 'S', consent: consent('RENEW', 'PARENT_PORTAL'), enrolled: false },
    { studentProfileId: id(12), givenName: 'C', familyName: 'S', consent: consent('WITHDRAWN', 'PARENT_PORTAL'), enrolled: false }] });
  expect(r.children.map(c => childActions(r, c))).toEqual([{ sign: false, withdraw: true }, { sign: true, withdraw: true }, { sign: true, withdraw: false }]);
  const html = renderToStaticMarkup(<FamilyFaceCheckInView {...familyProps({ state: { state: 'READY', read: r }, confirmWithdraw: id(10) })}/>);
  expect(html).toContain('Withdraw face check-in consent for A S?'); expect(html).toContain(faceText('en', 'renewNote')); expect(html).toContain(faceText('en', 'setUp'));
});

it('the menu links the scan screen under Attendance and the settings under Settings, and both pages exist', () => {
  const hrefs = SCHOOL_SHELL_NAV.flatMap(i => i.routes.map(r => r.href));
  expect(hrefs).toContain('/staff/attendance/face'); expect(hrefs).toContain('/staff/settings/face-check-in');
  for (const page of ['staff/attendance/face', 'staff/settings/face-check-in', 'parent/face-check-in']) expect(existsSync(new URL(`../src/app/${page}/page.tsx`, import.meta.url))).toBe(true);
});
