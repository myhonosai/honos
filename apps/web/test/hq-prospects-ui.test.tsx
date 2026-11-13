import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HQ_PROSPECT_COMMANDS, isHqProspectText, type HqProspect } from '@hon/contracts';
import { prospectsApi } from '../src/components/hq-prospects/http';
import { prospectRefusalKey, prospectText } from '../src/components/hq-prospects/copy';
import { ProspectDetailView, ProspectListView, consentChoicesFor, consentInputFrom, createInputFrom, updateInputFrom, type ProspectDetailViewProps,
  type ProspectListViewProps } from '../src/components/hq-prospects/view';
import { HQ_GROWTH, hqPageLabel } from '../src/components/hq-modern/catalog';

const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-12T10:00:00.000Z';
const person = { principalId: id(9), displayName: 'Synthetic Marketer' };
const empty = { EMAIL: { SERVICE: null, MARKETING: null }, SMS: { SERVICE: null, MARKETING: null } };
const prospect = (patch: Partial<HqProspect> = {}): HqProspect => ({ prospectId: id(1), fullName: 'Synthetic Prospect', schoolName: 'Synthetic Karate',
  email: 'p@example.test', phone: '+15550100101', source: 'HQ_ENTERED', campaign: null, status: 'ACTIVE', consent: empty, createdBy: person,
  createdAt: T, updatedAt: T, version: 3, ...patch });
const list = (prospects = [prospect()]) => ({ prospects, limit: 25, nextCursor: null, viewer: person, asOf: T });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];
const signal = () => new AbortController().signal;
const draft = { fullName: ' Synthetic Prospect ', schoolName: '', email: ' P@Example.TEST ', phone: '(555) 010-0101', source: 'HQ_ENTERED' };

it('builds closed requests: lower-cased email, E.164 phone, one address required, HQ sources only', () => {
  expect(createInputFrom(draft)).toEqual({ fullName: 'Synthetic Prospect', schoolName: null, email: 'p@example.test', phone: '+15550100101', campaignId: null, source: 'HQ_ENTERED' });
  expect(createInputFrom({ ...draft, email: '', phone: '' })).toBeNull();
  expect(createInputFrom({ ...draft, phone: '555-0101' })).toBeNull();
  expect(createInputFrom({ ...draft, email: 'not-an-email' })).toBeNull();
  expect(createInputFrom({ ...draft, source: 'PUBLIC_SIGN_UP' })).toBeNull();
  expect(createInputFrom({ ...draft, fullName: 'Name\u0085' })).toBeNull();
  expect(isHqProspectText('Name\u00A0', 1, 10)).toBe(true);
  expect(isHqProspectText('Name ', 1, 10)).toBe(false);
  expect(updateInputFrom(prospect(), null, 'ARCHIVED')).toMatchObject({ status: 'ARCHIVED', expectedVersion: 3, email: 'p@example.test' });
});

it('never offers to send an opt-in HQ may not record, and needs a note and an address', () => {
  const p = prospect();
  expect(consentInputFrom(p, { channel: 'EMAIL', purpose: 'SERVICE', status: 'OPTED_IN', note: 'Asked by email.' }))
    .toEqual({ channel: 'EMAIL', purpose: 'SERVICE', status: 'OPTED_IN', note: 'Asked by email.', expectedVersion: 3 });
  for (const [channel, purpose] of [['EMAIL', 'MARKETING'], ['SMS', 'SERVICE'], ['SMS', 'MARKETING']] as const) {
    expect(consentInputFrom(p, { channel, purpose, status: 'OPTED_IN', note: 'Asked by email.' })).toBeNull();
    expect(consentInputFrom(p, { channel, purpose, status: 'OPTED_OUT', note: 'Asked to stop.' })).not.toBeNull();
  }
  expect(consentInputFrom(p, { channel: 'EMAIL', purpose: 'SERVICE', status: 'OPTED_OUT', note: 'x' })).toBeNull();
  expect(consentInputFrom(prospect({ phone: null }), { channel: 'SMS', purpose: 'MARKETING', status: 'OPTED_OUT', note: 'Asked to stop.' })).toBeNull();
  expect(consentInputFrom(prospect({ status: 'ARCHIVED' }), { channel: 'EMAIL', purpose: 'SERVICE', status: 'OPTED_IN', note: 'Asked by email.' })).toBeNull();
  const optedOut = prospect({ consent: { ...empty, SMS: { SERVICE: null, MARKETING: { status: 'OPTED_OUT', source: 'RECIPIENT', capturedAt: T } } } });
  expect(consentInputFrom(optedOut, { channel: 'SMS', purpose: 'MARKETING', status: 'OPTED_OUT', note: 'Asked to stop.' })).toBeNull();
  expect(consentChoicesFor(prospect({ status: 'ARCHIVED' })).every((c) => c.status === 'OPTED_OUT')).toBe(true);
});

it('reads with the declared query only and refuses a page that does not match the filter', async () => {
  const f = stub(json({ data: list() }), json({ data: list([prospect({ status: 'ARCHIVED' })]) }));
  await prospectsApi.list({ status: 'ACTIVE', cursor: null }, signal(), yes);
  const [path, init] = call(f);
  expect(path).toBe(`/api/v1/hq/prospects?${new URLSearchParams({ status: 'ACTIVE', limit: '25' })}`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  await expect(prospectsApi.list({ status: 'ACTIVE', cursor: null }, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  await expect(prospectsApi.read('not-an-id', signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
});

it('sends commands with the marker and key; known refusals are REFUSED, others UNKNOWN', async () => {
  const key = '33333333-3333-4333-8333-333333333333';
  const f = stub(json({ data: { operation: 'CONSENT', prospect: prospect({ version: 4 }), replayed: false } }),
    json({ code: 'HQ_CONSENT_NOT_ALLOWED' }, 422), json({ code: 'NEW_RULE' }, 422));
  const input = { channel: 'EMAIL' as const, purpose: 'SERVICE' as const, status: 'OPTED_IN' as const, note: 'Asked by email.', expectedVersion: 3 };
  await prospectsApi.consent(id(1), input, key, signal(), yes);
  const [path, init] = call(f);
  expect(path).toBe(`/api/v1/hq/prospects/${id(1)}/consents`);
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': HQ_PROSPECT_COMMANDS.consent, 'Idempotency-Key': key });
  await expect(prospectsApi.consent(id(1), input, key, signal(), yes)).rejects.toMatchObject({ kind: 'REFUSED', code: 'HQ_CONSENT_NOT_ALLOWED' });
  await expect(prospectsApi.consent(id(1), input, key, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  expect(prospectRefusalKey('HQ_PROSPECT_EXISTS')).toBe('r_HQ_PROSPECT_EXISTS');
  expect(prospectRefusalKey('SOMETHING')).toBe('r_OTHER');
});

const listProps = (patch: Partial<ProspectListViewProps> = {}): ProspectListViewProps => ({ language: 'en', formattingLocale: 'en-US', concealed: false,
  state: { state: 'READY', list: list(), prospects: list().prospects, loadingMore: false, moreFailed: false }, filter: 'ACTIVE', outcome: null, locked: false,
  canRetry: false, localInvalid: null, formKey: 0, onFilter: () => {}, onMore: () => {}, onRefresh: () => {}, onReveal: () => {}, onAdd: () => {}, onTryAgain: () => {}, ...patch });
const detailProps = (patch: Partial<ProspectDetailViewProps> = {}): ProspectDetailViewProps => ({ language: 'en', formattingLocale: 'en-US', concealed: false,
  state: { state: 'READY', detail: { prospect: prospect(), consentHistory: [], viewer: person, asOf: T } }, outcome: null, locked: false, canRetry: false,
  localInvalid: null, formKey: 0, onRefresh: () => {}, onReveal: () => {}, onEdit: () => {}, onStatus: () => {}, onConsent: () => {}, onTryAgain: () => {}, ...patch });

it('lists prospects with contact details, hides everything when concealed, and says nothing is sent', () => {
  const html = renderToStaticMarkup(<ProspectListView {...listProps()}/>);
  expect(html).toContain('p@example.test');
  expect(html).toContain(`href="/hq/growth/prospects/${id(1)}"`);
  expect(html).toContain('Nothing on this page sends a message.');
  const hidden = renderToStaticMarkup(<ProspectListView {...listProps({ concealed: true })}/>);
  expect(hidden).not.toContain('p@example.test');
  expect(renderToStaticMarkup(<ProspectListView {...listProps({ state: { state: 'DENIED' } })}/>)).toContain('does not include prospects');
});

it('shows the consent grid and history, marks old-address answers, and offers only addresses the prospect has', () => {
  const now = { status: 'OPTED_OUT' as const, source: 'HQ_RECORDED' as const, capturedAt: T };
  const p = prospect({ phone: null, consent: { ...empty, EMAIL: { SERVICE: null, MARKETING: now } } });
  const history = [{ channel: 'EMAIL' as const, purpose: 'MARKETING' as const, status: 'OPTED_OUT' as const, source: 'HQ_RECORDED' as const, address: 'p@example.test',
    current: true, disclosureVersion: null, note: 'Asked to stop.', recordedBy: person, capturedAt: T },
  { channel: 'EMAIL' as const, purpose: 'SERVICE' as const, status: 'OPTED_IN' as const, source: 'HQ_RECORDED' as const, address: 'old@example.test',
    current: false, disclosureVersion: null, note: 'Asked by email.', recordedBy: person, capturedAt: T }];
  const html = renderToStaticMarkup(<ProspectDetailView {...detailProps({ state: { state: 'READY', detail: { prospect: p, consentHistory: history, viewer: person, asOf: T } } })}/>);
  expect(html).toContain('data-consent="EMAIL-MARKETING" data-status="OPTED_OUT"');
  expect(html).toContain('(old address)');
  expect(html).toContain('<option value="EMAIL.SERVICE.OPTED_IN">');
  expect(html).not.toContain('value="SMS.');
  expect(html).not.toContain('value="EMAIL.MARKETING.OPTED_OUT"');
  expect(html).not.toContain('value="EMAIL.MARKETING.OPTED_IN"');
  expect(html).toContain('Marketing and texting opt-ins come only from the person.');
  const archived = renderToStaticMarkup(<ProspectDetailView {...detailProps({ state: { state: 'READY', detail: { prospect: prospect({ status: 'ARCHIVED' }), consentHistory: [], viewer: person, asOf: T } } })}/>);
  expect(archived).toContain('>Restore<');
  expect(archived).not.toContain('OPTED_IN"');
  expect(archived).not.toContain('data-prospect-form="edit"');
  expect(renderToStaticMarkup(<ProspectDetailView {...detailProps({ localInvalid: 'consentInvalid' })}/>)).toContain('Write a short note');
});

it('is in the Growth nav with a page label, a manifest route, and every language', () => {
  expect(HQ_GROWTH.some((e) => e.path === '/hq/growth/prospects')).toBe(true);
  expect(hqPageLabel(`/hq/growth/prospects/${id(1)}`)).toBe('Prospect');
  const manifest = JSON.parse(readFileSync(new URL('../public/manus-routes.json', import.meta.url), 'utf8')) as { routes?: { path: string }[] } | { path: string }[];
  const routes = Array.isArray(manifest) ? manifest : manifest.routes ?? [];
  for (const path of ['/hq/growth/prospects', '/hq/growth/prospects/:prospectId']) expect(routes.some((r) => r.path === path)).toBe(true);
  for (const language of ['ko', 'es']) expect(prospectText(language, 'title')).not.toBe(prospectText('en', 'title'));
});
