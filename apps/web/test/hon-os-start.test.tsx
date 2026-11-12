import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SIGNUP_CONFIRMATION, SIGNUP_HUMAN_COMMAND, TRIAL_CONFIRMATION, TRIAL_HUMAN_COMMAND, validateSignupInput, validateTrialStartInput } from '@hon/contracts';
import { HonOsStart } from '../src/components/hon-os-start/workbench';
import { startRequest } from '../src/components/hon-os-start/http';
import { START_COPY, instant } from '../src/components/hon-os-start/copy';

const hooks = vi.hoisted(() => ({ values: [] as any[], cursor: 0, effects: [] as (() => void)[], language: 'en', locale: 'en-US' }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: hooks.language }, formattingLocale: hooks.locale }) }));
vi.mock('react', async () => {
  const a = await vi.importActual<typeof import('react')>('react');
  return { ...a,
    useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [hooks.values[i], (v: unknown) => hooks.values[i] = v]; },
    useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = { current: initial }; return hooks.values[i]; },
    useEffect: (effect: () => void | (() => void)) => { const i = hooks.cursor++; if (!(i in hooks.values)) { hooks.values[i] = {}; hooks.effects.push(() => { hooks.values[i].cleanup = effect(); }); } } };
});
type El = ReactElement<Record<string, any>>;
function nodes(v: unknown): El[] { return Array.isArray(v) ? v.flatMap(nodes) : React.isValidElement(v) ? [v as El, ...(typeof (v as El).type === 'function' ? nodes(((v as El).type as (p: unknown) => unknown)((v as El).props)) : nodes((v as El).props.children))] : []; }
function text(v: unknown): string { return nodes(v).length ? nodes(v).map(e => typeof e.props.children === 'string' || typeof e.props.children === 'number' ? String(e.props.children) : Array.isArray(e.props.children) ? e.props.children.filter((c: unknown) => typeof c === 'string' || typeof c === 'number').join('') : '').join(' ') : ''; }
const subject = 'oidc:fixture:new-owner';
function render() { hooks.cursor = 0; const t = HonOsStart({ sessionSubject: subject }) as El; hooks.effects.splice(0).forEach(f => f()); return t; }
const find = (label: string) => nodes(render()).find(e => e.type === 'button' && text(e).trim() === label);
const click = (label: string) => { const b = find(label); if (!b) throw new Error('no button ' + label + ' in: ' + text(render())); b.props.onClick(); };
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fail = (status: number, code: string) => new Response(JSON.stringify({ code }), { status, headers: { 'Content-Type': 'application/json' } });
const me = (s = subject) => ok({ externalSubject: s });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const terms = { termsVersionId: uuid(9), version: 1, status: 'TEST_ONLY_DRAFT', title: 'HON OS test sign-up terms', documentDigest: 'a'.repeat(64) };
const registration = { registrationId: uuid(1), organizationId: uuid(2), schoolId: uuid(3), schoolName: 'Synthetic Dojo', timezone: 'America/New_York', registeredAt: '2026-11-12T10:00:00.000Z', lifecycle: 'REGISTERED', accessGranted: false, billingActivated: false, aiCreditsGranted: false };
const signupOpen = { signupStatus: 'TEST_MODE', terms, eligibility: 'ELIGIBLE', registration: null };
const signupDone = { signupStatus: 'TEST_MODE', terms, eligibility: 'ALREADY_REGISTERED', registration };
const offer = { campaignId: uuid(4), name: 'Founding schools trial', durationDays: 14, automaticCharge: false, paymentMethodRequired: false, aiIncluded: true, aiCredits: { credits: 100, dailyCap: 20, perRequestCap: 10, expiryDays: 7 } };
const trialRow = { enrollmentId: uuid(5), organizationId: uuid(2), schoolId: uuid(3), campaignId: uuid(4), durationDays: 14, startsAt: '2026-11-12T10:00:00.000Z', endsAt: '2026-11-26T10:00:00.000Z', status: 'TRIAL_ACTIVE',
  automaticCharge: false, paymentMethodRequired: false, aiIncluded: true, aiCredits: { credits: 100, dailyCap: 20, perRequestCap: 10, expiresAt: '2026-11-19T10:00:00.000Z', used: 0 }, creativeCreditsIncluded: false, creativeCredits: null };
const trialCreative = { ...trialRow, creativeCreditsIncluded: true, creativeCredits: { credits: 1500, available: 1500, expiresAt: '2026-11-26T10:00:00.000Z' } };
function fill() {
  const inputs = nodes(render()).filter(e => e.type === 'input');
  const values = ['Synthetic Owner', 'Synthetic Dojo', 'Synthetic Dojo LLC'];
  inputs.filter(e => e.props.type !== 'checkbox').forEach((e, i) => e.props.onChange({ target: { value: values[i] } }));
  inputs.filter(e => e.props.type === 'checkbox').forEach(e => e.props.onChange({ target: { checked: true } }));
  nodes(render()).filter(e => e.type === 'select').forEach(e => e.props.onChange({ target: { value: 'America/New_York' } }));
}
beforeEach(() => { hooks.language = 'en'; hooks.locale = 'en-US'; hooks.values = []; hooks.cursor = 0; hooks.effects = []; vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', new EventTarget()); });
afterEach(() => { for (const v of hooks.values) v?.cleanup?.(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('reads nothing until the owner asks; then only their own identity, sign-up and trial status', async () => {
  const f = vi.spyOn(globalThis, 'fetch'); render(); expect(f).not.toHaveBeenCalled();
  f.mockResolvedValueOnce(me()).mockResolvedValueOnce(ok(signupDone)).mockResolvedValueOnce(ok({ trialStatus: 'TEST_MODE', schoolId: uuid(3), available: offer, trial: null }));
  click('Check my account'); await settle();
  expect(f.mock.calls.map(c => String(c[0]))).toEqual(['/api/identity/me', '/api/v1/account/sign-up', '/api/v1/account/trial']);
  expect(f.mock.calls.slice(1).every(c => c[1]!.method === 'GET' && !('X-HON-Human-Command' in (c[1]!.headers as object)))).toBe(true);
});

it('both programs switched off: says so plainly and offers no form or command', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(ok({ signupStatus: 'CLOSED', terms: null, eligibility: 'ELIGIBLE', registration: null }));
  click('Check my account'); await settle();
  const view = render(); expect(nodes(view).some(e => e.props['data-start-closed'])).toBe(true);
  expect(nodes(view).some(e => e.type === 'input')).toBe(false); expect(find('Create my school account')).toBeUndefined();
});

it('a registered school with trials switched off keeps its account and is told to come back', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(ok(signupDone)).mockResolvedValueOnce(ok({ trialStatus: 'CLOSED', schoolId: uuid(3), available: null, trial: null }));
  click('Check my account'); await settle();
  const view = render(); expect(nodes(view).some(e => e.props['data-start-registered'])).toBe(true); expect(nodes(view).some(e => e.props['data-start-trial-closed'])).toBe(true);
  expect(find('Start free trial')).toBeUndefined();
});

it('sign-up sends only the owner\'s words, the server terms version and the confirmation, once, with its own command header and key', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(ok(signupOpen));
  click('Check my account'); await settle();
  expect(find('Create my school account')!.props.disabled).toBe(true); fill(); expect(find('Create my school account')!.props.disabled).toBe(false);
  let finish!: (r: Response) => void; f.mockImplementationOnce(() => new Promise(r => finish = r));
  click('Create my school account'); click('Create my school account'); expect(f).toHaveBeenCalledTimes(3);
  const [path, init] = f.mock.calls[2]!; const headers = init!.headers as Record<string, string>;
  expect(path).toBe('/api/v1/account/sign-up'); expect(init!.method).toBe('POST'); expect(headers['X-HON-Human-Command']).toBe(SIGNUP_HUMAN_COMMAND); expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  const body = JSON.parse(init!.body as string); expect(validateSignupInput(body)).toEqual(body); expect(body.termsVersionId).toBe(terms.termsVersionId); expect(body.confirmation).toBe(SIGNUP_CONFIRMATION);
  expect(Object.keys(body).sort()).toEqual(['confirmation', 'legalName', 'ownerName', 'schoolName', 'termsVersionId', 'timezone']);
  f.mockResolvedValueOnce(me()).mockResolvedValueOnce(ok(signupDone)).mockResolvedValueOnce(ok({ trialStatus: 'TEST_MODE', schoolId: uuid(3), available: offer, trial: null }));
  finish(ok(registration)); await settle();
  expect(text(render())).toContain('Your school account is created'); expect(nodes(render()).some(e => e.props['data-start-offer'])).toBe(true);
});

it('trial start sends only school, campaign and confirmation from the server read; the receipt leads to Founder Setup', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(ok(signupDone)).mockResolvedValueOnce(ok({ trialStatus: 'TEST_MODE', schoolId: uuid(3), available: offer, trial: null }));
  click('Check my account'); await settle();
  expect(text(render())).toContain('100 trial credits'); expect(find('Start free trial')!.props.disabled).toBe(true); fill();
  f.mockResolvedValueOnce(ok(trialCreative)).mockResolvedValueOnce(me()).mockResolvedValueOnce(ok(signupDone)).mockResolvedValueOnce(ok({ trialStatus: 'TEST_MODE', schoolId: uuid(3), available: null, trial: trialCreative }));
  click('Start free trial'); await settle();
  const [path, init] = f.mock.calls[3]!; const body = JSON.parse(init!.body as string);
  expect(path).toBe('/api/v1/account/trial'); expect((init!.headers as Record<string, string>)['X-HON-Human-Command']).toBe(TRIAL_HUMAN_COMMAND);
  expect(validateTrialStartInput(body)).toEqual({ schoolId: uuid(3), campaignId: uuid(4), confirmation: TRIAL_CONFIRMATION }); expect(Object.keys(body).sort()).toEqual(['campaignId', 'confirmation', 'schoolId']);
  const view = render(); expect(nodes(view).some(e => e.props['data-start-trial'])).toBe(true); expect(nodes(view).some(e => e.type === 'a' && e.props.href === '/staff/founder-setup')).toBe(true);
  expect(text(view)).toContain('0 of 100 trial credits');
  expect(text(view)).toContain('Creative Studio: 1500 of 1500 trial creative credits left for images, video and avatars');
  expect(text(view)).not.toContain('are not included');
});

it('a lost response keeps the exact request for an explicit retry with the same key and body; a closed refusal drops it', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(ok(signupOpen));
  click('Check my account'); await settle(); fill();
  f.mockRejectedValueOnce(new TypeError('synthetic lost response')); click('Create my school account'); await settle();
  expect(text(render())).toContain('outcome is unknown'); expect(f).toHaveBeenCalledTimes(3);
  f.mockResolvedValueOnce(fail(409, 'SIGNUP_CLOSED')); click('Retry exact request'); await settle();
  expect(f.mock.calls[3]![1]!.body).toBe(f.mock.calls[2]![1]!.body); expect(f.mock.calls[3]![1]!.headers).toEqual(f.mock.calls[2]![1]!.headers);
  expect(text(render())).toContain('Self-serve sign-up is not open yet'); expect(find('Retry exact request')).toBeUndefined(); expect(f).toHaveBeenCalledTimes(4);
});

it('an unexplained server error after sending is an unknown outcome kept for exact retry; a busy refusal is not', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(ok(signupOpen));
  click('Check my account'); await settle(); fill();
  f.mockResolvedValueOnce(new Response('upstream reset', { status: 500 })); click('Create my school account'); await settle();
  expect(text(render())).toContain('outcome is unknown'); expect(find('Retry exact request')).toBeDefined();
  f.mockResolvedValueOnce(fail(503, 'SIGNUP_BUSY')); click('Retry exact request'); await settle();
  expect(text(render())).toContain('Nothing was submitted'); expect(find('Retry exact request')).toBeDefined();
});

it('a different signed-in account cannot continue the page or its pending request', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me('oidc:fixture:someone-else'));
  click('Check my account'); await settle();
  expect(text(render())).toContain('different account'); expect(nodes(render()).some(e => e.type === 'input')).toBe(false); expect(f).toHaveBeenCalledTimes(1);
});

it('session invalidation hides the loaded account; server text never reaches the page', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(ok(signupDone)).mockResolvedValueOnce(ok({ trialStatus: 'CLOSED', schoolId: uuid(3), available: null, trial: null }));
  click('Check my account'); await settle(); expect(text(render())).toContain('Synthetic Dojo');
  window.dispatchEvent(new Event('hon:session-invalidated')); expect(text(render())).not.toContain('Synthetic Dojo'); expect(text(render())).toContain('Sign in to continue');
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ code: 'select * from hon.secrets' }), { status: 500 }));
  await expect(startRequest('account/sign-up', new AbortController().signal)).rejects.toMatchObject({ status: 500, code: 'ACCOUNT_UNAVAILABLE' }); expect(f).toHaveBeenCalledTimes(1);
});

it('a response that claims more than the contract allows is refused, not shown', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(ok(signupDone)).mockResolvedValueOnce(ok({ trialStatus: 'TEST_MODE', schoolId: uuid(3), available: { ...offer, automaticCharge: true }, trial: null }));
  click('Check my account'); await settle(); expect(find('Start free trial')).toBeUndefined(); expect(nodes(render()).some(e => e.type === 'fieldset')).toBe(false);
});

it('every language has the same fixed copy for every server code, and the page renders in Korean and Spanish', async () => {
  const keys = Object.keys(START_COPY.en.codes).sort();
  for (const lang of ['ko', 'es'] as const) {
    expect(Object.keys(START_COPY[lang].codes).sort()).toEqual(keys);
    expect(Object.keys(START_COPY[lang]).sort()).toEqual(Object.keys(START_COPY.en).sort());
  }
  hooks.language = 'ko'; hooks.locale = 'ko-KR';
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(ok({ signupStatus: 'CLOSED', terms: null, eligibility: 'ELIGIBLE', registration: null }));
  expect(text(render())).toContain('HON OS에서 도장 시작하기'); click('내 계정 확인'); await settle();
  expect(text(render())).toContain('셀프 가입은 아직 열리지 않았습니다'); expect(find('다시 확인')).toBeDefined();
  hooks.language = 'es'; hooks.locale = 'es-ES'; expect(text(render())).toContain('El registro por cuenta propia aún no está abierto'); expect(find('Comprobar de nuevo')).toBeDefined();
});

it('switching language re-renders the status line in the new language, not the old one', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(fail(429, 'ACCOUNT_RATE_LIMITED'));
  click('Check my account'); await settle(); expect(text(render())).toContain('Please wait up to a minute');
  hooks.language = 'es'; expect(text(render())).toContain('Espere hasta un minuto'); expect(text(render())).not.toContain('Please wait');
});

it('trial and credit instants show date, time and the school time zone by name', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(ok(signupDone)).mockResolvedValueOnce(ok({ trialStatus: 'TEST_MODE', schoolId: uuid(3), available: null, trial: trialRow }));
  click('Check my account'); await settle(); const t = text(render());
  // 10:00 UTC is 5:00 AM in New York (EST) on both dates.
  expect(t).toContain('November 12, 2026 at 5:00 AM EST'); expect(t).toContain('November 26, 2026 at 5:00 AM EST'); expect(t).toContain('November 19, 2026 at 5:00 AM EST');
  expect(instant('2026-11-12T10:00:00.000Z', 'en-US', 'Asia/Seoul')).toContain('7:00 PM GMT+9');
  expect(instant('2026-11-12T10:00:00.000Z', 'en-US', 'Not/AZone')).toMatch(/2026/);
});

it('the legal terms wording is an explicit placeholder on the sign-up form and the trial offer', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(ok(signupOpen));
  click('Check my account'); await settle();
  expect(nodes(render()).some(e => e.props['data-start-legal-pending'])).toBe(true); expect(text(render())).toContain('final legal terms are still being prepared');
  hooks.values = []; f.mockResolvedValueOnce(me()).mockResolvedValueOnce(ok(signupDone)).mockResolvedValueOnce(ok({ trialStatus: 'TEST_MODE', schoolId: uuid(3), available: offer, trial: null }));
  click('Check my account'); await settle(); expect(nodes(render()).some(e => e.props['data-start-trial-terms-pending'])).toBe(true);
});

it('abuse-protection refusals have fixed copy in every language and drop the request (nothing was written)', async () => {
  for (const code of ['SIGNUP_EMAIL_DOMAIN_NOT_ACCEPTED', 'SIGNUP_CAPACITY_REACHED', 'TRIAL_CAPACITY_REACHED'])
    for (const lang of ['en', 'ko', 'es'] as const) expect(START_COPY[lang].codes[code]).toBeTruthy();
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(ok(signupOpen));
  click('Check my account'); await settle(); fill();
  f.mockResolvedValueOnce(fail(409, 'SIGNUP_EMAIL_DOMAIN_NOT_ACCEPTED')); click('Create my school account'); await settle();
  expect(text(render())).toContain('temporary email address'); expect(find('Retry exact request')).toBeUndefined();
  f.mockResolvedValueOnce(fail(409, 'SIGNUP_CAPACITY_REACHED')); click('Create my school account'); await settle();
  expect(text(render())).toContain('limited number of new schools'); expect(find('Retry exact request')).toBeUndefined();
});

it('the trial-terms placeholder shows only while the sign-up terms are still a draft', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(ok({ ...signupDone, terms: null })).mockResolvedValueOnce(ok({ trialStatus: 'TEST_MODE', schoolId: uuid(3), available: offer, trial: null }));
  click('Check my account'); await settle();
  expect(nodes(render()).some(e => e.props['data-start-offer'])).toBe(true); expect(nodes(render()).some(e => e.props['data-start-trial-terms-pending'])).toBe(false);
});

it('the school time zone is a picker that defaults to the browser zone, never to UTC', async () => {
  const zoneOf = (z: string) => vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: z } as Intl.ResolvedDateTimeFormatOptions);
  zoneOf('America/Chicago');
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(ok(signupOpen));
  click('Check my account'); await settle();
  const picker = () => nodes(render()).find(e => e.type === 'select')!;
  expect(picker().props.value).toBe('America/Chicago'); expect(nodes(render()).some(e => e.type === 'input' && e.props.placeholder === 'America/New_York')).toBe(false);
  const options = nodes(picker()).filter(e => e.type === 'option').map(e => e.props.value);
  expect(options[0]).toBe(''); expect(options).toContain('America/Los_Angeles'); expect(options).toContain('Asia/Seoul'); expect(options.length).toBeGreaterThan(100);
  vi.restoreAllMocks(); hooks.values = []; hooks.effects = [];
  zoneOf('UTC');
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(ok(signupOpen));
  click('Check my account'); await settle();
  expect(picker().props.value).toBe('');
  const inputs = nodes(render()).filter(e => e.type === 'input');
  inputs.filter(e => e.props.type !== 'checkbox').forEach((e, i) => e.props.onChange({ target: { value: ['Synthetic Owner', 'Synthetic Dojo', 'Synthetic Dojo LLC'][i] } }));
  inputs.filter(e => e.props.type === 'checkbox').forEach(e => e.props.onChange({ target: { checked: true } }));
  expect(find('Create my school account')!.props.disabled).toBe(true);
  picker().props.onChange({ target: { value: 'America/Denver' } }); expect(find('Create my school account')!.props.disabled).toBe(false);
  f.mockResolvedValueOnce(ok(registration)).mockResolvedValueOnce(me()).mockResolvedValueOnce(ok(signupDone)).mockResolvedValueOnce(ok({ trialStatus: 'CLOSED', schoolId: uuid(3), available: null, trial: null }));
  click('Create my school account'); await settle();
  expect(JSON.parse(f.mock.calls[2]![1]!.body as string).timezone).toBe('America/Denver');
});
