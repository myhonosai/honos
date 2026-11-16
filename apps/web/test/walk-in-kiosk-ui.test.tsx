import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import type { WalkInOverview, WalkInSettingsRead, WalkInTerminal } from '@hon/contracts';
import { WALK_IN_COPY, walkInCopy, walkInPrice } from '../src/components/walk-in-kiosk/copy';
import { handOffWalkInTablet, takeWalkInTablet } from '../src/components/walk-in-kiosk/handoff';
import { walkInApi, walkInErrorFor, walkInTabletApi, WALKIN_COMMANDS, WalkInError } from '../src/components/walk-in-kiosk/http';
import { addPadPoint, padPoint, signedStrokes, strokePath } from '../src/components/walk-in-kiosk/signature-pad';
import { leadHref, nextOfferKey, priceMinor, settingsBody, settingsDraft, WalkInStaffView } from '../src/components/walk-in-kiosk/staff';
import { detailsOk, emptyDraft, normalizeMobile, visitBody, waiverOk, WalkInVisitorView, type VisitDraft, type VisitorViewProps } from '../src/components/walk-in-kiosk/visitor';

const org = '11111111-1111-4111-8111-111111111111', school = '22222222-2222-4222-8222-222222222222';
const pipe = '33333333-3333-4333-8333-333333333333', stage = '44444444-4444-4444-8444-444444444444';
const lead = '55555555-5555-4555-8555-555555555555', visitId = '66666666-6666-4666-8666-666666666666', device = '77777777-7777-4777-8777-777777777777';
const token = 'A'.repeat(43);
const scope = { organizationId: org, schoolId: school };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const terminal: WalkInTerminal = {
  schoolName: 'Synthetic Dojo', branding: { logoUrl: null, accentColor: null }, endsAt: '2099-01-01T00:00:00.000Z', settingsVersion: 3,
  waiver: { en: 'I accept the risks of training.', ko: '훈련 위험을 이해합니다.' }, emergencyRequired: false,
  offers: [{ key: 'free-trial', kind: 'TRIAL', name: { en: 'Free trial class' }, description: { en: '' }, priceMinor: 0, currency: 'USD' },
    { key: 'day-pass', kind: 'DAY_PASS', name: { en: 'Day pass', es: 'Pase de día' }, description: { en: 'One day' }, priceMinor: 2500, currency: 'USD' }],
  thankYou: { en: 'See you on the mat.' },
};
const today = '2026-11-16';
const filled = (patch: Partial<VisitDraft> = {}): VisitDraft => ({
  ...emptyDraft(), contact: { givenName: ' Sam ', familyName: 'Example', birthDate: '1990-01-01', email: '', mobile: '(555) 201-0000' },
  signerName: 'Sam Example', strokes: [[[10, 10], [20, 20]], [[5, 5]]], agreed: true, offerKey: 'day-pass', ...patch,
});
const visitorProps = (patch: Partial<VisitorViewProps> = {}): VisitorViewProps => ({
  read: terminal, mode: 'modern', language: 'en', step: 'WELCOME', draft: emptyDraft(), today, tried: false, sending: false, outcome: null, countdown: 20, ...patch,
});

describe('walk-in copy', () => {
  it('has every key in Korean and Spanish', () => {
    const keys = Object.keys(WALK_IN_COPY.en).sort();
    expect(Object.keys(WALK_IN_COPY.ko).sort()).toEqual(keys);
    expect(Object.keys(WALK_IN_COPY.es).sort()).toEqual(keys);
    for (const l of ['ko', 'es'] as const) for (const k of keys) expect((WALK_IN_COPY[l] as Record<string, string>)[k], `${l}.${k}`).toBeTruthy();
  });
  it('fills variables, falls back to English, and prints USD prices', () => {
    expect(walkInCopy('ko-KR', 'vChild', { n: 2 })).toContain('2');
    expect(walkInCopy('fr', 'vBegin')).toBe(WALK_IN_COPY.en.vBegin);
    expect(walkInPrice('en', 2500)).toBe('$25.00');
  });
});

describe('visitor form helpers', () => {
  it('normalizes typed phones to +E.164 and leaves anything else for the server to refuse', () => {
    expect(normalizeMobile('(555) 201-0000')).toBe('+15552010000');
    expect(normalizeMobile('1 555 201 0000')).toBe('+15552010000');
    expect(normalizeMobile('+82 10 1234 5678')).toBe('+821012345678');
    expect(normalizeMobile('  ')).toBe('');
    expect(normalizeMobile('123')).toBe('123');
  });
  it('builds the visit body: trims names, signs only real strokes, adult-only has no children', () => {
    const body = visitBody(filled(), terminal, 'en', today);
    expect(body.contact).toMatchObject({ givenName: 'Sam', mobile: '+15552010000', isParticipant: true, birthDate: '1990-01-01' });
    expect(body.children).toEqual([]); expect(body.relationship).toBeNull();
    expect(body.waiver.strokes).toEqual([[[10, 10], [20, 20]]]);
    expect(body.settingsVersion).toBe(3); expect(body.website).toBe('');
  });
  it('kids only: the adult is not a participant and needs no birth date', () => {
    const body = visitBody(filled({ who: 'KIDS', contact: { ...filled().contact, birthDate: '' }, children: [{ givenName: 'Kid', familyName: 'Example', birthDate: '2018-05-05' }] }), terminal, 'en', today);
    expect(body.contact.isParticipant).toBe(false); expect(body.contact.birthDate).toBeNull();
    expect(body.children).toHaveLength(1); expect(body.relationship).toBe('PARENT');
  });
  it('refuses incomplete details and an unsigned waiver', () => {
    expect(detailsOk(filled(), terminal, 'en', today)).toBe(true);
    expect(detailsOk(filled({ contact: { ...filled().contact, mobile: '', email: '' } }), terminal, 'en', today)).toBe(false);
    expect(detailsOk(filled({ contact: { ...filled().contact, givenName: '<b>' } }), terminal, 'en', today)).toBe(false);
    expect(waiverOk(filled())).toBe(true);
    expect(waiverOk(filled({ strokes: [[[5, 5]]] }))).toBe(false);
    expect(waiverOk(filled({ agreed: false }))).toBe(false);
    expect(() => visitBody(filled({ offerKey: 'nope' }), terminal, 'en', today)).toThrow();
  });
});

describe('signature pad', () => {
  it('maps to whole 0-1000 coordinates and keeps the stroke and point limits', () => {
    expect(padPoint(150, 50, 300, 100)).toEqual([500, 500]);
    expect(padPoint(-5, 999, 300, 100)).toEqual([0, 1000]);
    let s = addPadPoint([], [1, 1], true);
    s = addPadPoint(s, [1, 1], false); s = addPadPoint(s, [2, 2], false);
    expect(s).toEqual([[[1, 1], [2, 2]]]);
    let many: [number, number][][] = [];
    for (let i = 0; i < 60; i++) many = addPadPoint(many, [i, i], true);
    expect(many).toHaveLength(40);
    let long = addPadPoint([], [0, 0], true);
    for (let i = 1; i < 2100; i++) long = addPadPoint(long, [i % 1000, i % 7], false);
    expect(long.reduce((n, x) => n + x.length, 0)).toBe(2000);
    expect(signedStrokes([[[1, 1]], [[1, 1], [2, 2]]])).toHaveLength(1);
    expect(strokePath([[[1, 2], [3, 4]]])).toBe('M1 2 L3 4');
  });
});

describe('visitor screen', () => {
  it('shows no form without a tablet hand-off, and a closed tablet says so', () => {
    expect(renderToStaticMarkup(<WalkInVisitorView {...visitorProps({ read: 'NOT_STARTED' })}/>)).toContain(WALK_IN_COPY.en.vNotStarted);
    const closed = renderToStaticMarkup(<WalkInVisitorView {...visitorProps({ read: 'CLOSED' })}/>);
    expect(closed).toContain(WALK_IN_COPY.en.vClosed); expect(closed).not.toContain('<input');
  });
  it.each(['modern', 'classic', 'big-button'] as const)('renders the %s theme in all three languages', mode => {
    for (const language of ['en', 'ko', 'es'] as const) {
      const html = renderToStaticMarkup(<WalkInVisitorView {...visitorProps({ mode, language })}/>);
      expect(html).toContain(WALK_IN_COPY[language].vWelcome); expect(html).toContain(`lang="${language}"`);
    }
  });
  it('the waiver falls back to English and says so; the offer step lists prices', () => {
    const es = renderToStaticMarkup(<WalkInVisitorView {...visitorProps({ language: 'es', step: 'WAIVER', draft: filled() })}/>);
    expect(es).toContain('I accept the risks'); expect(es).toContain(WALK_IN_COPY.es.vWaiverFallback);
    const ko = renderToStaticMarkup(<WalkInVisitorView {...visitorProps({ language: 'ko', step: 'WAIVER', draft: filled() })}/>);
    expect(ko).toContain('훈련 위험'); expect(ko).not.toContain(WALK_IN_COPY.ko.vWaiverFallback);
    const offer = renderToStaticMarkup(<WalkInVisitorView {...visitorProps({ language: 'es', step: 'OFFER', draft: filled() })}/>);
    expect(offer).toContain('Pase de día'); expect(offer).toContain('$25.00'); expect(offer).toContain(WALK_IN_COPY.es.vFree);
  });
  it('done shows only this visitor: first name, the desk price, the thank-you', () => {
    const html = renderToStaticMarkup(<WalkInVisitorView {...visitorProps({ step: 'DONE', draft: filled(),
      outcome: { result: 'RECORDED', firstName: 'Sam', paymentState: 'PAY_AT_DESK', priceMinor: 2500, thankYou: 'See you on the mat.' } })}/>);
    expect(html).toContain('Sam'); expect(html).toContain('$25.00'); expect(html).toContain('See you on the mat.');
    expect(html).not.toContain('Example'); expect(html).not.toContain('555');
  });
});

describe('tablet hand-off', () => {
  it('takes a well-formed token once, in memory only', async () => {
    expect(() => handOffWalkInTablet({ token: 'short', mode: 'modern', language: 'en' })).toThrow();
    handOffWalkInTablet({ token, mode: 'classic', language: 'ko' });
    expect(takeWalkInTablet()?.token).toBe(token);
    expect(takeWalkInTablet()?.token).toBe(token); // same task
    await Promise.resolve();
    expect(takeWalkInTablet()).toBeNull();
  });
});

describe('walk-in http', () => {
  it('tablet calls send no cookie and keep the token in the body', async () => {
    const f = vi.fn(async () => json({ data: { ...terminal, offers: terminal.offers } })); vi.stubGlobal('fetch', f);
    const read = await walkInTabletApi.terminal(token, new AbortController().signal);
    expect(typeof read === 'object' && read.schoolName).toBe('Synthetic Dojo');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/walk-in-kiosk/terminal'); expect(url).not.toContain(token);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', mode: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(JSON.parse(String(init.body))).toEqual({ device: token });
    expect(init.headers).not.toHaveProperty('X-HON-Human-Command');
  });
  it('tablet answers: 404 is closed, anything odd is unavailable, a malformed token never leaves', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'X' }, 404)));
    expect(await walkInTabletApi.terminal(token, new AbortController().signal)).toBe('CLOSED');
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: {}, extra: 1 })));
    expect(await walkInTabletApi.terminal(token, new AbortController().signal)).toBe('UNAVAILABLE');
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    expect(await walkInTabletApi.terminal('bad', new AbortController().signal)).toBe('CLOSED');
    expect(await walkInTabletApi.submit(token, {} as never, 'short', new AbortController().signal)).toEqual({ result: 'INVALID' });
    expect(f).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await walkInTabletApi.submit(token, {} as never, 'k'.repeat(36), new AbortController().signal)).toEqual({ result: 'UNAVAILABLE' });
  });
  it('staff commands carry the exact command name and an idempotency key', async () => {
    const f = vi.fn(async () => json({ data: { device: { deviceId: device, label: 'Front desk', startedAt: '2026-11-16T08:00:00.000Z', endsAt: '2026-11-16T16:00:00.000Z', endedAt: null, live: true, version: 1, startedBy: 'Owner' }, token }, meta: {} }));
    vi.stubGlobal('fetch', f);
    const key = globalThis.crypto.randomUUID();
    const started = await walkInApi.start(scope, { label: 'Front desk', hours: 8 }, key, new AbortController().signal, () => true);
    expect(started.token).toBe(token);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/v1/organizations/${org}/schools/${school}/walk-in-kiosk/devices`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'Idempotency-Key': key, 'X-HON-Human-Command': WALKIN_COMMANDS.start } });
    await expect(walkInApi.start(scope, { label: 'x', hours: 8 }, 'not-a-uuid', new AbortController().signal, () => true)).rejects.toMatchObject({ kind: 'INVALID' });
    await expect(walkInApi.overview({ organizationId: 'bad', schoolId: school }, new AbortController().signal, () => true)).rejects.toBeInstanceOf(WalkInError);
  });
  it('maps refusals to closed kinds and nothing else', () => {
    expect(walkInErrorFor(403, null).kind).toBe('DENIED');
    expect(walkInErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
    expect(walkInErrorFor(409, 'WALKIN_KIOSK_OFF').kind).toBe('REFUSED');
    expect(walkInErrorFor(409, 'SOMETHING').kind).toBe('UNKNOWN');
    expect(walkInErrorFor(500, null).kind).toBe('UNKNOWN');
  });
});

const settingsRead: WalkInSettingsRead = { settings: null, pipelines: [{ pipelineId: pipe, name: 'Walk-ins', stages: [{ stageId: stage, name: 'New' }] }] };
const overview: WalkInOverview = {
  canManage: true, configured: true, enabled: true,
  devices: [{ deviceId: device, label: 'Front desk', startedAt: '2026-11-16T08:00:00.000Z', endsAt: '2026-11-16T16:00:00.000Z', endedAt: null, live: true, version: 1, startedBy: 'Owner' }],
  visits: [{ visitId, leadId: lead, version: 1, createdAt: '2026-11-16T09:00:00.000Z', language: 'en', contact: { givenName: 'Sam', familyName: 'Example', email: null, mobile: '+15552010000' },
    participants: [{ givenName: 'Sam', familyName: 'Example', birthDate: '1990-01-01', isContact: true, isMinor: false }],
    offer: { key: 'day-pass', kind: 'DAY_PASS', name: 'Day pass', priceMinor: 2500 }, paymentState: 'PAY_AT_DESK', paidMethod: null, paidAt: null,
    marketingOptIn: false, heardFrom: '', waiverSignedAt: '2026-11-16T09:00:00.000Z' } as unknown as WalkInOverview['visits'][number]],
};

describe('staff page', () => {
  it('turns typed dollars into cents and refuses anything else', () => {
    expect(priceMinor('25')).toBe(2500); expect(priceMinor('$25.5')).toBe(2550); expect(priceMinor('0')).toBe(0);
    expect(priceMinor('25.555')).toBeNaN(); expect(priceMinor('-1')).toBeNaN(); expect(priceMinor('abc')).toBeNaN();
  });
  it('a new school starts with a free trial and a day pass, and the body validates', () => {
    const d = settingsDraft(settingsRead);
    expect(d.offers.map(o => o.kind)).toEqual(['TRIAL', 'DAY_PASS']);
    expect(() => settingsBody(d, null)).toThrow(); // a waiver is required
    const body = settingsBody({ ...d, waiver: { en: 'Line one\r\nLine two', ko: '', es: '' } }, null);
    expect(body.waiver).toEqual({ en: 'Line one\nLine two' }); expect(body.offers[1]?.priceMinor).toBe(2500); expect(body.expectedVersion).toBe(0);
    expect(nextOfferKey(d.offers)).toBe('offer-1');
  });
  it('opens the lead in the school CRM journey', () => {
    expect(leadHref(scope, lead)).toBe(`/staff/crm/journey?organizationId=${org}&schoolId=${school}&leadId=${lead}`);
  });
  it('lists tablets and walk-ins with desk payment, and shows settings to owners only', () => {
    const base = { language: 'en', waiting: false, hasSchool: true, overview: { state: 'READY' as const, read: overview }, settings: { state: 'READY' as const, read: settingsRead },
      draft: settingsDraft(settingsRead), detail: null, outcome: null, busy: false, label: 'Front desk', hours: 8, scope };
    const html = renderToStaticMarkup(<WalkInStaffView {...base}/>);
    for (const k of ['startTitle', 'tabletsTitle', 'visitsTitle', 'settingsTitle', 'endTablet', 'openLead', 'viewWaiver'] as const) expect(html).toContain(WALK_IN_COPY.en[k]);
    expect(html).toContain('$25.00'); expect(html).toContain(`leadId=${lead}`);
    const staff = renderToStaticMarkup(<WalkInStaffView {...base} overview={{ state: 'READY', read: { ...overview, canManage: false } }}/>);
    expect(staff).not.toContain(WALK_IN_COPY.en.settingsTitle);
    const ko = renderToStaticMarkup(<WalkInStaffView {...base} language="ko"/>);
    expect(ko).toContain(WALK_IN_COPY.ko.startTitle);
    expect(renderToStaticMarkup(<WalkInStaffView {...base} overview={{ state: 'DENIED' }}/>)).toContain(WALK_IN_COPY.en.denied);
  });
});

describe('routes', () => {
  it('the tablet route is public, unindexed and sends no referrer; the staff route sits behind the staff layout', () => {
    const kiosk = readFileSync(new URL('../src/app/kiosk/walk-in/page.tsx', import.meta.url), 'utf8');
    expect(kiosk).toContain("referrer: 'no-referrer'"); expect(kiosk).toContain('index: false');
    expect(readFileSync(new URL('../src/app/staff/walk-in/page.tsx', import.meta.url), 'utf8')).toContain('WalkInKioskPage');
    expect(readFileSync(new URL('../src/app/staff/layout.tsx', import.meta.url), 'utf8')).toContain('requireVerifiedWebSession');
  });
});
