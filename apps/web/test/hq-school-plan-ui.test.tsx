import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validateHqSchoolPlanView, type HqSchoolPlanView } from '@hon/contracts';
import { PlanError, planCommandError, planSchoolId, schoolPlanApi } from '../src/components/hq-school-plan/http';
import { centsFromDollars, planProblem, PlanCardView, reviewChoice, type PlanCardViewProps, type PlanForm } from '../src/components/hq-school-plan/plan-card';
import { schoolPlanText } from '../src/components/hq-school-plan/copy';

const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-01T00:00:00.000Z';
const who = { principalId: id(9), displayName: 'HQ Owner' };
const offer = (patch: Record<string, unknown> = {}) => ({ offerId: id(5), offerCode: 'CORE_MONTHLY', offerKind: 'REGULAR_MONTHLY', billingInterval: 'MONTHLY',
  founder: false, displayName: 'Core monthly', priceMinor: 14900, currency: 'USD', offerSetVersion: 3, ...patch });
const custom = (revision: number, patch: Record<string, unknown> = {}) => ({ revision, action: 'ASSIGN', source: 'CUSTOM', offerId: null, offerKind: null,
  offerSetVersion: null, planName: 'Friends price', billingInterval: 'MONTHLY', priceMinor: 9900, currency: 'USD', founder: false, freeUntil: null,
  note: null, schoolId: id(1), recordedBy: who, recordedAt: T, ...patch });
const removed = (revision: number) => ({ revision, action: 'REMOVE', source: null, offerId: null, offerKind: null, offerSetVersion: null, planName: null,
  billingInterval: null, priceMinor: null, currency: null, founder: null, freeUntil: null, note: null, schoolId: id(1), recordedBy: who, recordedAt: T });
function raw(patch: Record<string, unknown> = {}) {
  return { schoolId: id(1), organizationId: id(2), schoolName: 'Synthetic Academy', schoolStatus: 'ACTIVE', organizationStatus: 'ACTIVE', revision: 0,
    current: null, history: [], onNow: 'TRIAL', offers: [offer()], viewer: { ...who, canManage: true }, effect: 'RECORD_ONLY', charging: 'OFF', asOf: T, ...patch };
}
const view = (r = raw()): HqSchoolPlanView => validateHqSchoolPlanView(r);
const receipt = (operation: 'ASSIGN' | 'REMOVE', assignment: unknown) => ({ operation, schoolId: id(1), organizationId: id(2), assignment, effect: 'RECORD_ONLY', charging: 'OFF', replayed: false });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const t = (key: Parameters<typeof schoolPlanText>[1], vars?: Record<string, string>) => schoolPlanText('en', key, vars);
const f = { money: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }), day: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }) };
const blank: PlanForm = { name: '', price: '', interval: 'MONTHLY', freeUntil: '', note: '' };
const noop = () => {};
function render(patch: Partial<PlanCardViewProps> = {}) {
  return renderToStaticMarkup(<PlanCardView language="en" formattingLocale="en-US" load={{ state: 'READY', view: view() }} step={{ step: 'VIEW' }} pick={null}
    form={blank} problem={null} done={null} busy={false} onRetry={noop} onStart={noop} onStartRemove={noop} onPick={noop} onForm={noop} onReview={noop}
    onSave={noop} onRemove={noop} onBack={noop} onCancel={noop} {...patch}/>);
}

it('reads one school plan with a plain same-origin GET and refuses a bad id or another school', async () => {
  const fx = stub(json({ data: raw() }), json({ data: raw({ schoolId: id(3) }) }));
  const v = await schoolPlanApi.read(id(1).toUpperCase(), new AbortController().signal, yes);
  expect(v.revision).toBe(0);
  const [path, init] = fx.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/hq/schools/${id(1)}/plan`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' });
  expect(init.body).toBeUndefined();
  expect(Object.keys(init.headers as object)).toEqual(['Accept']);
  await expect(schoolPlanApi.read(id(1), new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  for (const bad of ['', 'nope', '../x']) {
    expect(planSchoolId(bad)).toBeNull();
    await expect(schoolPlanApi.read(bad, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  }
  expect(fx).toHaveBeenCalledTimes(2);
});

it('assigns and removes with the command marker, JSON body and the given Idempotency-Key, and checks the receipt', async () => {
  const fx = stub(json({ data: receipt('ASSIGN', custom(1)) }), json({ data: receipt('REMOVE', removed(2)) }), json({ data: receipt('ASSIGN', custom(5)) }));
  const key = id(77), plan = { source: 'CUSTOM' as const, name: 'Friends price', billingInterval: 'MONTHLY' as const, priceMinor: 9900, freeUntil: null };
  const a = await schoolPlanApi.assign(id(1), { expectedRevision: 0, plan, note: null }, key, new AbortController().signal, yes);
  expect(a.assignment.revision).toBe(1);
  const [path, init] = fx.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/hq/schools/${id(1)}/plan/assign`);
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error' });
  expect(init.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'hq-school-plan-assign', 'Idempotency-Key': key });
  expect(JSON.parse(init.body as string)).toEqual({ expectedRevision: 0, plan, note: null });
  await schoolPlanApi.remove(id(1), { expectedRevision: 1, note: 'closing' }, key, new AbortController().signal, yes);
  const [rpath, rinit] = fx.mock.calls[1] as unknown as [string, RequestInit];
  expect(rpath).toBe(`/api/v1/hq/schools/${id(1)}/plan/remove`);
  expect((rinit.headers as Record<string, string>)['X-HON-Human-Command']).toBe('hq-school-plan-remove');
  // A receipt for the wrong revision is not trusted.
  await expect(schoolPlanApi.assign(id(1), { expectedRevision: 0, plan, note: null }, key, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  // Bad input never leaves the browser.
  await expect(schoolPlanApi.assign(id(1), { expectedRevision: 0, plan: { ...plan, priceMinor: -1 }, note: null }, key, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(schoolPlanApi.remove('nope', { expectedRevision: 0, note: null }, key, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(fx).toHaveBeenCalledTimes(3);
});

it('maps command refusals exactly; anything else is UNKNOWN', () => {
  expect(planCommandError(403, 'SAAS_FORBIDDEN').kind).toBe('DENIED');
  expect(planCommandError(400, 'INVALID_SAAS_INPUT').kind).toBe('INVALID');
  expect(planCommandError(404, 'SAAS_UNAVAILABLE').kind).toBe('GONE');
  expect(planCommandError(409, 'SAAS_VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(planCommandError(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('KEY_REUSED');
  for (const code of ['HQ_SCHOOL_PLAN_OFFER_NOT_AVAILABLE', 'HQ_SCHOOL_PLAN_NO_CHANGE', 'HQ_SCHOOL_PLAN_NONE', 'HQ_SCHOOL_PLAN_SCHOOL_ARCHIVED',
    'HQ_SCHOOL_PLAN_FREE_END_INVALID', 'HQ_SCHOOL_PLAN_END_DATE_ONLY_WHEN_FREE']) expect(planCommandError(422, code).kind).toBe('REFUSED');
  expect(planCommandError(422, 'SOMETHING_ELSE').kind).toBe('UNKNOWN');
  expect(planCommandError(500, null).kind).toBe('UNKNOWN');
  expect(planCommandError(404, null).kind).toBe('UNKNOWN');
});

it('keeps the same key only when the outcome is unknown, and reloads after a conflict', () => {
  expect(planProblem(new PlanError('UNKNOWN'))).toEqual({ key: 'UNKNOWN', keepKey: true, reload: false });
  expect(planProblem(new Error('network'))).toEqual({ key: 'UNKNOWN', keepKey: true, reload: false });
  expect(planProblem(new PlanError('CHANGED', 'SAAS_VERSION_CONFLICT'))).toEqual({ key: 'CHANGED', keepKey: false, reload: true });
  expect(planProblem(new PlanError('REFUSED', 'HQ_SCHOOL_PLAN_NO_CHANGE'))).toEqual({ key: 'REFUSED_HQ_SCHOOL_PLAN_NO_CHANGE', keepKey: false, reload: false });
  expect(planProblem(new PlanError('DENIED'))).toEqual({ key: 'DENIED', keepKey: false, reload: false });
});

it('reads typed dollar amounts as exact cents', () => {
  expect(centsFromDollars('149')).toBe(14900);
  expect(centsFromDollars('$149.5')).toBe(14950);
  expect(centsFromDollars(' 1,250.05 ')).toBe(125005);
  expect(centsFromDollars('0')).toBe(0);
  expect(centsFromDollars('100000')).toBe(10_000_000);
  for (const bad of ['', '-1', '1.234', 'abc', '100000.01', '0149', '1e3']) expect(centsFromDollars(bad)).toBeNull();
});

it('turns the picker into the exact choice the server gets, or a reason', () => {
  const v = view(), today = '2026-11-24', limit = '2029-11-24';
  expect(reviewChoice(v, null, blank, t, f, today, limit)).toEqual({ ok: false, problem: 'pickOne' });
  expect(reviewChoice(v, { kind: 'OFFER', offerId: id(6) }, blank, t, f, today, limit)).toEqual({ ok: false, problem: 'pickOne' });
  expect(reviewChoice(v, { kind: 'OFFER', offerId: id(5) }, blank, t, f, today, limit))
    .toEqual({ ok: true, choice: { source: 'OFFER', offerId: id(5) }, label: 'Core monthly', price: '$149.00 / month' });
  const c = { kind: 'CUSTOM' as const };
  expect(reviewChoice(v, c, { ...blank, name: 'ab', price: '10' }, t, f, today, limit)).toEqual({ ok: false, problem: 'invalidName' });
  expect(reviewChoice(v, c, { ...blank, name: 'Friends', price: 'x' }, t, f, today, limit)).toEqual({ ok: false, problem: 'invalidPrice' });
  expect(reviewChoice(v, c, { ...blank, name: ' Friends ', price: '99', interval: 'ANNUAL', freeUntil: '2027-01-31' }, t, f, today, limit))
    .toEqual({ ok: true, choice: { source: 'CUSTOM', name: 'Friends', billingInterval: 'ANNUAL', priceMinor: 9900, freeUntil: null }, label: 'Friends', price: '$99.00 / year' });
  expect(reviewChoice(v, c, { ...blank, name: 'Free school', price: '0' }, t, f, today, limit))
    .toMatchObject({ ok: true, choice: { priceMinor: 0, freeUntil: null }, price: 'Free, no end date' });
  expect(reviewChoice(v, c, { ...blank, name: 'Free school', price: '0', freeUntil: '2027-01-31' }, t, f, today, limit))
    .toMatchObject({ ok: true, choice: { priceMinor: 0, freeUntil: '2027-01-31' }, price: 'Free until Jan 31, 2027' });
  for (const bad of [today, '2026-01-01', '2029-11-25'])
    expect(reviewChoice(v, c, { ...blank, name: 'Free school', price: '0', freeUntil: bad }, t, f, today, limit)).toEqual({ ok: false, problem: 'invalidDate' });
});

it('shows loading, denied and unavailable without any plan facts', () => {
  expect(render({ load: { state: 'LOADING' } })).toContain(t('loading'));
  const denied = render({ load: { state: 'DENIED' } });
  expect(denied).toContain('data-hq-school-plan="denied"');
  expect(denied).not.toContain(t('retry'));
  const down = render({ load: { state: 'UNAVAILABLE' } });
  expect(down).toContain(t('unavailable'));
  expect(down).toContain(t('retry'));
});

it('shows no plan, charging off, what the school is on today, and an Assign button for the owner', () => {
  const html = render();
  expect(html).toContain('id="plan"');
  expect(html).toContain('data-plan-current="none"');
  expect(html).toContain(t('chargingOff'));
  expect(html).toContain('Free trial');
  expect(html).toContain(t('assign'));
  expect(html).not.toContain(t('remove'));
  expect(html).not.toContain(t('readOnly'));
});

it('shows the current custom or offer plan with change and remove, and history', () => {
  const html = render({ load: { state: 'READY', view: view(raw({ revision: 1, current: custom(1), history: [custom(1)], onNow: 'MONTHLY' })) } });
  expect(html).toContain('Friends price · $99.00 / month');
  expect(html).toContain(t('sourceCUSTOM'));
  expect(html).toContain(t('change'));
  expect(html).toContain(t('remove'));
  expect(html).toContain('History (1)');
  expect(html).toContain('Nov 1, 2026: Friends price at $99.00 / month, by HQ Owner');
  const o = { ...custom(2), source: 'OFFER', offerId: id(5), offerKind: 'FOUNDER_MONTHLY', offerSetVersion: 3, planName: 'Founder monthly', priceMinor: 7900, founder: true };
  const offerHtml = render({ load: { state: 'READY', view: view(raw({ revision: 2, current: o, history: [o, removed(1)] })) } });
  expect(offerHtml).toContain('Founder monthly · $79.00 / month');
  expect(offerHtml).toContain(t('sourceOFFER'));
  expect(offerHtml).toContain(t('founder'));
  expect(offerHtml).toContain('Nov 1, 2026: plan removed, by HQ Owner');
  const free = render({ load: { state: 'READY', view: view(raw({ revision: 1, current: custom(1, { priceMinor: 0, freeUntil: '2027-01-31' }), history: [custom(1, { priceMinor: 0, freeUntil: '2027-01-31' })] })) } });
  expect(free).toContain('Free until Jan 31, 2027');
});

it('is read-only for a viewer who cannot manage', () => {
  const html = render({ load: { state: 'READY', view: view(raw({ revision: 1, current: custom(1), history: [custom(1)], viewer: { ...who, canManage: false } })) } });
  expect(html).toContain(t('readOnly'));
  expect(html).not.toContain(t('change'));
  expect(html).not.toContain(t('remove'));
});

it('picker lists published offers plus a custom price, and links to Pricing & Offers when none are published', () => {
  const html = render({ step: { step: 'PICK' }, pick: { kind: 'OFFER', offerId: id(5) } });
  expect(html).toContain('Choose a plan for Synthetic Academy');
  expect(html).toContain('Core monthly');
  expect(html).toContain('$149.00 / month');
  expect(html).toContain(t('customTile'));
  expect(html).not.toContain('id="plan-price"');
  const none = render({ load: { state: 'READY', view: view(raw({ offers: [] })) }, step: { step: 'PICK' }, pick: { kind: 'CUSTOM' }, form: { ...blank, price: '149' } });
  expect(none).toContain('data-plan-no-offers=""');
  expect(none).toContain('href="/hq/pricing-offers"');
  expect(none).toContain('id="plan-price"');
  expect(none).not.toContain('id="plan-free-until"');
  const free = render({ step: { step: 'PICK' }, pick: { kind: 'CUSTOM' }, form: { ...blank, price: '0' } });
  expect(free).toContain('id="plan-free-until"');
  expect(free).toContain(t('freeUntilHelp'));
});

it('confirm and remove steps spell out the change and lock buttons while saving', () => {
  const confirm = render({ step: { step: 'CONFIRM', choice: { source: 'OFFER', offerId: id(5) }, label: 'Core monthly', price: '$149.00 / month' }, busy: true });
  expect(confirm).toContain('Synthetic Academy will be on “Core monthly” at $149.00 / month.');
  expect(confirm).toContain(t('saving'));
  expect(confirm).toMatch(/disabled=""/);
  const remove = render({ load: { state: 'READY', view: view(raw({ revision: 1, current: custom(1), history: [custom(1)] })) }, step: { step: 'REMOVE' }, problem: t('UNKNOWN') });
  expect(remove).toContain('Remove the plan from Synthetic Academy? Its history stays.');
  expect(remove).toContain('role="alert"');
});

it('has every wording in Korean and Spanish', () => {
  for (const lang of ['ko', 'es']) {
    const html = renderToStaticMarkup(<PlanCardView language={lang} formattingLocale="en-US" load={{ state: 'READY', view: view() }} step={{ step: 'VIEW' }} pick={null}
      form={blank} problem={null} done={null} busy={false} onRetry={noop} onStart={noop} onStartRemove={noop} onPick={noop} onForm={noop} onReview={noop}
      onSave={noop} onRemove={noop} onBack={noop} onCancel={noop}/>);
    expect(html).not.toContain(t('chargingOff'));
    expect(schoolPlanText(lang, 'chargingOff')).not.toBe(t('chargingOff'));
  }
});
