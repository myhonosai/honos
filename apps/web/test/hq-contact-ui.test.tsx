import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HQ_CONTACT_COMMANDS, normalizeHqContactPhone, type HqContact } from '@hon/contracts';
import { CommsError } from '../src/components/hq-communications/http';
import { hqContactApi } from '../src/components/hq-contact/http';
import { hqContactRefusalKey, hqContactText } from '../src/components/hq-contact/copy';
import { HqContactView, codeToShow, type HqContactViewProps } from '../src/components/hq-contact/hq-contact';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';

const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const T = '2026-11-12T10:00:00.000Z', LATER = '2026-11-12T10:15:00.000Z';
const HQ = { ready: true as const, a2pState: 'REGISTERED_SERVICE' as const, number: '+15555550199' };
const contact = (patch: Partial<HqContact> = {}): HqContact => ({ status: 'REMOVED', phone: null, codeExpiresAt: null, codeExpired: false, wrongCodes: 0,
  codesLeftToday: 5, confirmedAt: null, textingOn: false, stoppedByReply: false, version: 0, hqNumber: HQ, ...patch });
const pending = (patch: Partial<HqContact> = {}) => contact({ status: 'PENDING', phone: '+15555550123', codeExpiresAt: LATER, version: 2, codesLeftToday: 4, ...patch });
const confirmed = (patch: Partial<HqContact> = {}) => contact({ status: 'CONFIRMED', phone: '+15555550123', confirmedAt: T, textingOn: true, version: 3, ...patch });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];
const signal = () => new AbortController().signal;
const props = (patch: Partial<HqContactViewProps> = {}): HqContactViewProps => ({ language: 'en', formattingLocale: 'en-US',
  state: { state: 'READY', contact: contact() }, code: null, outcome: null, locked: false, canRetry: false, localInvalid: false,
  onStart: () => {}, onTexting: () => {}, onRemove: () => {}, onTryAgain: () => {}, onRefresh: () => {}, ...patch });
const html = (patch: Partial<HqContactViewProps> = {}) => renderToStaticMarkup(<HqContactView {...props(patch)}/>);

it('normalizes a US/Canada number to E.164 and refuses anything that is not a phone number', () => {
  expect(normalizeHqContactPhone('(555) 555-0123')).toBe('+15555550123');
  expect(normalizeHqContactPhone('1 555 555 0123')).toBe('+15555550123');
  expect(normalizeHqContactPhone('+44 20 7946 0958')).toBe('+442079460958');
  for (const bad of ['555-0123', '', 'call me', '+0123456789', '15555550123x']) expect(normalizeHqContactPhone(bad)).toBeNull();
});

it('reads only the person\'s own settings: no id in the path, read guard headers, and a drifted answer is UNKNOWN', async () => {
  const f = stub(json({ data: { contact: contact(), asOf: T } }), json({ data: { contact: { ...contact(), smsServiceSid: 'MG' }, asOf: T } }));
  await expect(hqContactApi.read(signal(), yes)).resolves.toMatchObject({ contact: { status: 'REMOVED' } });
  const [path, init] = call(f);
  expect(path).toBe('/api/v1/me/hq-contact');
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  await expect(hqContactApi.read(signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
});

it('starts a number with the command marker and key, and takes the code only from a first answer', async () => {
  const f = stub(json({ data: { operation: 'PHONE_START', contact: pending(), code: '042917', replayed: false } }),
    json({ data: { operation: 'PHONE_START', contact: pending(), code: '042917', replayed: true } }));
  const key = '11111111-1111-4111-8111-111111111111';
  const r = await hqContactApi.startPhone({ phone: '+15555550123', expectedVersion: 1 }, key, signal(), yes);
  expect(r.code).toBe('042917');
  const [path, init] = call(f);
  expect(path).toBe('/api/v1/me/hq-contact/phone');
  expect(init.method).toBe('POST');
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': HQ_CONTACT_COMMANDS.startPhone, 'Idempotency-Key': key, 'Content-Type': 'application/json' });
  expect(JSON.parse(String(init.body))).toEqual({ phone: '+15555550123', expectedVersion: 1 });
  // A replay must never carry the code again; one that does is not trusted.
  await expect(hqContactApi.startPhone({ phone: '+15555550123', expectedVersion: 1 }, key, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  await expect(hqContactApi.startPhone({ phone: '5555550123', expectedVersion: 1 }, key, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(f).toHaveBeenCalledTimes(2);
});

it('maps only the known refusals to REFUSED; a 422 with any other code stays UNKNOWN', async () => {
  stub(json({ code: 'HQ_PHONE_IN_USE' }, 422), json({ code: 'SOMETHING_ELSE' }, 422), json({ code: 'SAAS_VERSION_CONFLICT' }, 409));
  const key = '22222222-2222-4222-8222-222222222222';
  await expect(hqContactApi.startPhone({ phone: '+15555550123', expectedVersion: 0 }, key, signal(), yes)).rejects.toMatchObject({ kind: 'REFUSED', code: 'HQ_PHONE_IN_USE' });
  await expect(hqContactApi.setTexting({ enabled: true, expectedVersion: 3 }, key, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  await expect(hqContactApi.removePhone(3, key, signal(), yes)).rejects.toMatchObject({ kind: 'CHANGED' });
  await expect(hqContactApi.removePhone(0, key, signal(), yes)).rejects.toBeInstanceOf(CommsError);
  expect(hqContactRefusalKey('HQ_PHONE_CODE_LIMIT')).toBe('r_HQ_PHONE_CODE_LIMIT');
  expect(hqContactRefusalKey('NEW_CODE')).toBe('r_OTHER');
});

it('shows a code only while that very code is pending; a wrong try does not hide it, a new code or expiry does', () => {
  const code = { code: '042917', phone: '+15555550123', expiresAt: LATER };
  expect(codeToShow(pending(), code)).toBe('042917');
  expect(codeToShow(pending({ version: 3, wrongCodes: 1 }), code)).toBe('042917');
  expect(codeToShow(pending({ codeExpiresAt: '2026-11-12T10:20:00.000Z' }), code)).toBeNull();
  expect(codeToShow(pending({ phone: '+15555550124' }), code)).toBeNull();
  expect(codeToShow(pending({ codeExpired: true }), code)).toBeNull();
  expect(codeToShow(confirmed(), code)).toBeNull();
  expect(codeToShow(pending(), null)).toBeNull();
});

it('walks the steps: not set up, add a number, text the code to the HQ number, confirmed with the switch', () => {
  const notReady = html({ state: { state: 'READY', contact: contact({ hqNumber: null }) } });
  expect(notReady).toContain('data-contact-step="not-ready"');
  expect(notReady).not.toContain('data-contact-form');

  const add = html();
  expect(add).toContain('data-contact-form="phone"');
  expect(add).toContain('Reply STOP to stop, HELP for help.');

  const code = html({ state: { state: 'READY', contact: pending() }, code: { code: '042917', phone: '+15555550123', expiresAt: LATER } });
  expect(code).toContain('data-contact-code="shown"');
  expect(code).toContain('042917');
  expect(code).toContain('+15555550199');
  expect(code).not.toContain('MG');

  const lost = html({ state: { state: 'READY', contact: pending({ wrongCodes: 2 }) } });
  expect(lost).toContain('data-contact-code="none"');
  expect(lost).not.toContain('042917');
  expect(lost).toContain('Wrong codes received: 2 of 5.');

  const spent = html({ state: { state: 'READY', contact: pending({ codesLeftToday: 0 }) } });
  expect(spent).toMatch(/<button type="button"[^>]*disabled=""[^>]*>Get a new code<\/button>/);

  const on = html({ state: { state: 'READY', contact: confirmed() } });
  expect(on).toContain('data-contact-texting="on"');
  expect(on).toContain('Turn HQ texts off');
  const off = html({ state: { state: 'READY', contact: confirmed({ textingOn: false }) } });
  expect(off).toContain('Turn HQ texts on');
  expect(off).toContain('Msg &amp; data rates may apply');
  const stopped = html({ state: { state: 'READY', contact: confirmed({ textingOn: false, stoppedByReply: true }) } });
  expect(stopped).toContain('data-contact-step="stopped-by-reply"');
  expect(stopped).toContain('text START from that phone to +15555550199');
  expect(stopped).not.toContain('Turn HQ texts on');
  // HQ texting switched off while a number was pending: the person can still take the number back.
  const orphan = html({ state: { state: 'READY', contact: pending({ hqNumber: null }) } });
  expect(orphan).toContain('data-contact-step="not-ready"');
  expect(orphan).toContain('Remove my number');
});

it('says plainly what happened, and offers Try again only when the outcome is unknown and the request was kept', () => {
  expect(html({ localInvalid: true })).toContain('Enter a mobile number with its area code');
  expect(html({ outcome: { kind: 'REFUSED', code: 'HQ_PHONE_IN_USE' } })).toContain('confirmed for someone else');
  const unknown = html({ outcome: { kind: 'UNKNOWN' }, canRetry: true });
  expect(unknown).toContain('data-contact-outcome="unknown"');
  expect(unknown).toContain('>Try again<');
  expect(html({ outcome: { kind: 'UNKNOWN' }, canRetry: false })).not.toContain('>Try again<');
  expect(html({ state: { state: 'DENIED' } })).toContain('cannot use texts from HON');
  expect(html({ state: { state: 'UNAVAILABLE' } })).toContain('could not be read');
});

it('has the same keys in every language, a settings nav entry and a manifest route', () => {
  for (const language of ['ko', 'es']) expect(hqContactText(language, 'title')).not.toBe(hqContactText('en', 'title'));
  const settings = SCHOOL_SHELL_NAV.find((g) => g.key === 'settings');
  expect(settings?.routes.some((r) => r.href === '/settings/texts-from-hon')).toBe(true);
  const manifest = JSON.parse(readFileSync(new URL('../public/manus-routes.json', import.meta.url), 'utf8')) as { routes?: { path: string }[] } | { path: string }[];
  const routes = Array.isArray(manifest) ? manifest : manifest.routes ?? [];
  expect(routes.some((r) => r.path === '/settings/texts-from-hon')).toBe(true);
});
