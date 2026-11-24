import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReferralError, keepForRetry, publicReferralApi, referralErrorFor, schoolReferralsApi, REFERRAL_COMMANDS } from '../src/components/family-referrals/http';
import { SchoolReferralsView, draftOf, referralProblem } from '../src/components/family-referrals/staff-referrals';
import { PublicReferralView, resultText } from '../src/components/family-referrals/public-referral';
import { id } from './account-status-fixtures';

// 0604 family referrals: staff Marketing > Referrals and the friend's /refer/<code> page.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const scope = { organizationId: id(1), schoolId: id(2) }, form = id(10), referral = id(20), lead = id(21), key = id(77);
const BASE = `/api/v1/organizations/${id(1)}/schools/${id(2)}/marketing/referrals`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ReferralError; } throw new Error('expected a failure'); };
const program = { version: 2, status: 'ON', formId: form, referrerReward: 'One free month', friendOffer: 'Free trial week', rules: 'After the first paid month.', shareMessage: 'Come train!', updatedAt: '2026-11-20T18:00:00Z' };
const item = { referralId: referral, version: 1, familyName: 'Kim Family', friendName: 'Alex Lee', leadId: lead, leadStatus: 'WON', selfReferral: false, existingContact: true,
  rewardStatus: 'PENDING', rewardNote: '', rewardDecidedAt: null, createdAt: '2026-11-20T18:00:00Z' };
const read = { program, forms: [{ formId: form, title: 'Trial class', status: 'PUBLISHED' }], counts: { referred: 1, joined: 1, rewarded: 0, awaitingDecision: 1 }, referrals: [item], canManage: true };

it('reads with a plain same-origin GET and refuses anything but the exact answer', async () => {
  const f = stub(json({ data: read, meta: { requestId: id(5) } }));
  expect((await schoolReferralsApi.read(scope, signal(), () => true)).referrals).toHaveLength(1);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(BASE);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  stub(json({ data: { ...read, referrals: [{ ...item, friendPhone: '+15550000000' }] }, meta: { requestId: id(5) } }));
  expect((await fails(schoolReferralsApi.read(scope, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ code: 'SCHOOL_REFERRAL_FORBIDDEN' }, 403));
  expect((await fails(schoolReferralsApi.read(scope, signal(), () => true))).kind).toBe('DENIED');
  await expect(schoolReferralsApi.read({ organizationId: '../x', schoolId: id(2) }, signal(), () => true)).rejects.toMatchObject({ kind: 'INVALID' });
});

it('saves the program and a reward with their own command marker and key', async () => {
  const save = schoolReferralsApi.prepareProgram({ expectedVersion: 2, status: 'ON', formId: form, referrerReward: 'One free month', friendOffer: '', rules: '', shareMessage: '' }, key);
  let f = stub(json({ data: program, meta: { requestId: id(5), replayed: false } }));
  expect((await schoolReferralsApi.saveProgram(scope, save, signal(), () => true)).program.version).toBe(2);
  let [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`${BASE}/program`);
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': REFERRAL_COMMANDS.program, 'Idempotency-Key': key });
  const reward = schoolReferralsApi.prepareReward(referral, { expectedVersion: 1, decision: 'GIVEN', note: 'December' }, key);
  f = stub(json({ data: { ...item, version: 2, rewardStatus: 'GIVEN', rewardNote: 'December', rewardDecidedAt: '2026-11-20T19:00:00Z' }, meta: { requestId: id(5), replayed: true } }));
  expect((await schoolReferralsApi.saveReward(scope, reward, signal(), () => true)).replayed).toBe(true);
  [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`${BASE}/${referral}/reward`);
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': REFERRAL_COMMANDS.reward });
  stub(json({ data: { ...item, referralId: id(99), version: 2, rewardStatus: 'GIVEN', rewardDecidedAt: '2026-11-20T19:00:00Z' }, meta: { requestId: id(5), replayed: false } }));
  expect((await fails(schoolReferralsApi.saveReward(scope, reward, signal(), () => true))).kind).toBe('UNKNOWN');
  expect(() => schoolReferralsApi.prepareProgram({ expectedVersion: 2, status: 'ON', formId: null, referrerReward: 'x', friendOffer: '', rules: '', shareMessage: '' }, key)).toThrow(ReferralError);
  expect(() => schoolReferralsApi.prepareReward(referral, { expectedVersion: 1, decision: 'PENDING', note: 'waiting' }, key)).toThrow(ReferralError);
});

it('maps refusals to plain words; only an unconfirmed outcome keeps Try again', () => {
  expect(referralErrorFor(409, 'VERSION_CONFLICT').kind).toBe('VERSION');
  expect(referralErrorFor(422, 'REFERRAL_FORM_UNAVAILABLE').kind).toBe('FORM');
  expect(referralErrorFor(422, 'REFERRAL_NOT_FOUND').kind).toBe('NOT_FOUND');
  expect(referralErrorFor(503, 'SCHOOL_REFERRAL_UNAVAILABLE').kind).toBe('UNKNOWN');
  expect(keepForRetry(new ReferralError('UNKNOWN'))).toBe(true); expect(keepForRetry(new ReferralError('VERSION'))).toBe(false);
  expect(referralProblem(new ReferralError('FORM'))).toMatch(/live/);
});

it('shows the program, counts, flags and reward buttons, and says nothing is paid', () => {
  const html = renderToStaticMarkup(<SchoolReferralsView data={read as never} draft={draftOf(read as never)} busy={false} error="" notice="" canRetry={false} notes={{}} />);
  expect(html).toContain('Family referrals'); expect(html).toContain('Nothing is paid, credited or added to an invoice');
  expect(html).toContain('Kim Family'); expect(html).toContain('Alex Lee'); expect(html).toContain('data-flag="EXISTING_CONTACT"');
  expect(html).toContain('Reward given'); expect(html).toContain('Not eligible'); expect(html).toContain('One free month');
  const reader = renderToStaticMarkup(<SchoolReferralsView data={{ ...read, canManage: false } as never} draft={draftOf(read as never)} busy={false} error="" notice="" canRetry={false} notes={{}} />);
  expect(reader).not.toContain('>Reward given</button>'); expect(reader).toContain('Only people who manage referrals can change it');
});

it('public page: no credentials, closed answers, same text for every unavailable reason', async () => {
  const pub = { schoolName: 'Dojo', friendOffer: 'Free trial week', form: { title: 'Trial class', description: 'Tell us about you', optionalFields: ['ageBand'] } };
  let f = stub(json({ data: pub }));
  const got = await publicReferralApi.read('0123456789abcdef', signal());
  expect(got).toEqual(pub);
  expect((f.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ credentials: 'omit' });
  expect(await publicReferralApi.read('../../x', signal())).toBe('GONE');
  stub(json({ result: 'invalid' }, 404)); expect(await publicReferralApi.read('0123456789abcdef', signal())).toBe('GONE');
  f = stub(json({ result: 'accepted' }, 202));
  expect(await publicReferralApi.submit('0123456789abcdef', { name: 'Alex', email: 'a@example.test', mobile: '', interest: '', source: 'Family referral', website: '', acknowledged: true }, key, signal())).toBe('accepted');
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/public/referrals/0123456789abcdef/submissions');
  expect(init).toMatchObject({ method: 'POST', credentials: 'omit' }); expect(init.headers).toMatchObject({ 'Idempotency-Key': key });
  expect(Object.keys(init.headers as object).some(k => /^x-hon/i.test(k))).toBe(false);
  expect(await publicReferralApi.submit('0123456789abcdef', { name: 'Alex', website: 'spam', acknowledged: true }, key, signal())).toBe('invalid');
  const page = renderToStaticMarkup(<PublicReferralView read={got} values={{}} acknowledged={false} busy={false} status="" done={false} />);
  expect(page).toContain('Dojo'); expect(page).toContain('Free trial week'); expect(page).toContain('Age group');
  // IC1 (0634): the friend's page submits the school's lead form, so it shows the same email wording and an unticked Text me box.
  expect(page).toContain('may email you about your enquiry'); expect(page).toContain('Reply STOP to opt out');
  expect(page).not.toContain('not consent to marketing'); expect(page).not.toMatch(/name="text-opt-in"[^>]*checked/);
  expect(renderToStaticMarkup(<PublicReferralView read={got} values={{}} acknowledged={false} textOptIn busy={false} status="" done={false} />)).toMatch(/name="text-opt-in"[^>]*checked/);
  for (const r of ['GONE', 'UNAVAILABLE'] as const) expect(renderToStaticMarkup(<PublicReferralView read={r} values={{}} acknowledged={false} busy={false} status="" done={false} />)).toContain('available right now');
  expect(resultText('accepted')).toMatch(/Thanks/);
});

it('review fixes: a failed read still offers Refresh; a missing current form stays visible; a pending change blocks another', () => {
  const empty = renderToStaticMarkup(<SchoolReferralsView data={null} draft={draftOf(null)} busy={false} error="x" notice="" canRetry={false} notes={{}} />);
  expect(empty).toContain('>Refresh</button>'); expect(empty).not.toContain('Loading referrals');
  const gone = { ...read, forms: [] };
  expect(renderToStaticMarkup(<SchoolReferralsView data={gone as never} draft={draftOf(gone as never)} busy={false} error="" notice="" canRetry={false} notes={{}} />)).toContain('no longer available');
  expect(keepForRetry(new ReferralError('PENDING'))).toBe(true);
  expect(referralProblem(new ReferralError('PENDING'))).toMatch(/Try again first/);
});
