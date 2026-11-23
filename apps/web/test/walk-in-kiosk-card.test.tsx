import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { BinaryBitmap, DecodeHintType, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from '@zxing/library';
import type { WalkInCardOutcome, WalkInOverview, WalkInTerminal } from '@hon/contracts';
import { WALK_IN_COPY } from '../src/components/walk-in-kiosk/copy';
import { qrModules, STRIPE_JS, walkInStripeTestKey, walkInTabletSurfaces } from '../src/components/walk-in-kiosk/card';
import { walkInErrorFor, walkInTabletApi } from '../src/components/walk-in-kiosk/http';
import { WalkInStaffView } from '../src/components/walk-in-kiosk/staff';
import {
  choosePay, emptyDraft, payNext, WalkInPaidView, WalkInVisitorView, type Pay, type VisitorViewProps,
} from '../src/components/walk-in-kiosk/visitor';

const token = 'A'.repeat(43), visitKey = 'k'.repeat(36);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const signal = () => new AbortController().signal;

const terminal: WalkInTerminal = {
  schoolName: 'Synthetic Dojo', branding: { logoUrl: null, accentColor: null }, endsAt: '2099-01-01T00:00:00.000Z', settingsVersion: 3,
  waiver: { en: 'I accept the risks of training.' }, emergencyRequired: false,
  offers: [{ key: 'day-pass', kind: 'DAY_PASS', name: { en: 'Day pass' }, description: { en: '' }, priceMinor: 2500, currency: 'USD', classes: null }],
  thankYou: { en: 'See you on the mat.' }, cardSurfaces: ['EMBEDDED', 'HOSTED'],
};
const recorded = { result: 'RECORDED' as const, firstName: 'Sam', paymentState: 'PAY_AT_DESK' as const, priceMinor: 2500, thankYou: null };
const props = (patch: Partial<VisitorViewProps> = {}): VisitorViewProps => ({
  read: terminal, mode: 'modern', language: 'en', step: 'PAY', draft: emptyDraft(), today: '2026-11-19', tried: false, sending: false,
  outcome: recorded, countdown: 20, pay: choosePay(['EMBEDDED', 'HOSTED']), paid: null, testKey: 'pk_test_' + 'a'.repeat(24), ...patch,
});
const both = choosePay(['EMBEDDED', 'HOSTED']);
const ready = (surface: 'EMBEDDED' | 'HOSTED'): WalkInCardOutcome => surface === 'EMBEDDED'
  ? { result: 'READY', surface, clientSecret: 'cs_test_abc_secret_def', url: null, accountRef: 'acct_123', expiresAt: '2026-11-19T10:20:00.000Z' }
  : { result: 'READY', surface, clientSecret: null, url: 'https://checkout.stripe.com/c/pay/cs_test_abc', accountRef: null, expiresAt: '2026-11-19T10:20:00.000Z' };

describe('test mode only', () => {
  it('uses only a Stripe test publishable key; a live key or anything else turns the tablet form off', () => {
    expect(walkInStripeTestKey('pk_test_' + 'a'.repeat(24))).toBe('pk_test_' + 'a'.repeat(24));
    for (const bad of ['pk_live_' + 'a'.repeat(24), 'sk_test_' + 'a'.repeat(24), 'pk_test_short', '', undefined, 'pk_test_' + 'a'.repeat(24) + '<']) expect(walkInStripeTestKey(bad)).toBeNull();
    expect(walkInTabletSurfaces(['EMBEDDED', 'HOSTED'], null)).toEqual(['HOSTED']);
    expect(walkInTabletSurfaces(['EMBEDDED', 'HOSTED'], 'pk_test_x')).toEqual(['EMBEDDED', 'HOSTED']);
    expect(walkInTabletSurfaces([], 'pk_test_x')).toEqual([]);
  });
  it('loads Stripe.js only from Stripe, at the API version the server uses', () => {
    expect(STRIPE_JS).toBe('https://js.stripe.com/basil/stripe.js');
    expect(readFileSync(new URL('../../api/src/school-payments/school-payment-sandbox-adapters.ts', import.meta.url), 'utf8')).toContain("'Stripe-Version': '2025-03-31.basil'");
  });
});

describe('phone QR', () => {
  it('encodes exactly the payment page address (decoded back)', () => {
    const url = 'https://checkout.stripe.com/c/pay/cs_test_a1B2c3D4e5F6g7H8#fidkdWxOYHwnPyd1blpxYHZxWjA0';
    const { size, path } = qrModules(url);
    const scale = 4, w = size * scale, pixels = new Uint8ClampedArray(w * w).fill(255);
    for (const m of path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
      for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) pixels[(Number(m[2]) * scale + dy) * w + Number(m[1]) * scale + dx] = 0;
    }
    const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels, w, w)));
    expect(new QRCodeReader().decode(bitmap, new Map([[DecodeHintType.PURE_BARCODE, true]])).getText()).toBe(url);
  });
});

describe('what a card answer means', () => {
  it('only PAID is paid; NOT_DUE means nothing to pay; CLOSED closes the tablet', () => {
    for (const asked of ['start', 'status', 'cancel'] as const) {
      expect(payNext(both, { result: 'PAID' }, asked, asked === 'start' ? 'HOSTED' : undefined)).toEqual({ done: 'CARD' });
      expect(payNext(both, { result: 'NOT_DUE' }, asked)).toEqual({ done: 'NOT_DUE' });
      expect(payNext(both, { result: 'CLOSED' }, asked)).toEqual({ closed: true });
    }
  });
  it('a start shows the form or the QR, and only for the surface asked for', () => {
    expect(payNext(both, ready('EMBEDDED'), 'start', 'EMBEDDED')).toMatchObject({ pay: { view: 'FORM', clientSecret: 'cs_test_abc_secret_def', accountRef: 'acct_123', url: null } });
    expect(payNext(both, ready('HOSTED'), 'start', 'HOSTED')).toMatchObject({ pay: { view: 'QR', url: 'https://checkout.stripe.com/c/pay/cs_test_abc', clientSecret: null } });
    expect(payNext(both, ready('HOSTED'), 'start', 'EMBEDDED')).toEqual({ pay: choosePay(both.surfaces, 'UNAVAILABLE') });
    expect(payNext(both, ready('HOSTED'), 'status')).toEqual({ pay: choosePay(both.surfaces, 'UNAVAILABLE') });
  });
  it('a surface the school cannot take is dropped; with none left the desk is the way', () => {
    expect(payNext(both, { result: 'NOT_AVAILABLE' }, 'start', 'EMBEDDED')).toEqual({ pay: choosePay(['HOSTED'], 'UNAVAILABLE') });
    expect(payNext(choosePay(['HOSTED']), { result: 'NOT_AVAILABLE' }, 'start', 'HOSTED')).toEqual({ done: 'DESK' });
    expect(payNext(both, { result: 'NOT_FOUND' }, 'start', 'HOSTED')).toEqual({ done: 'DESK' });
  });
  it('a status check keeps waiting while open, clearing or unknown, and returns to the choices when it ended unpaid', () => {
    const qr: Pay = { ...both, view: 'QR', url: 'https://checkout.stripe.com/c/pay/x' };
    expect(payNext(qr, { result: 'OPEN' }, 'status')).toEqual({ pay: { ...qr, processing: false } });
    expect(payNext(qr, { result: 'PROCESSING' }, 'status')).toEqual({ pay: { ...qr, processing: true } });
    for (const r of ['UNAVAILABLE', 'RATE_LIMITED', 'INVALID'] as const) expect(payNext(qr, { result: r }, 'status')).toEqual({ pay: qr });
    expect(payNext(qr, { result: 'EXPIRED' }, 'status')).toEqual({ pay: choosePay(both.surfaces, 'EXPIRED') });
    expect(payNext(qr, { result: 'FAILED' }, 'status')).toEqual({ pay: choosePay(both.surfaces, 'FAILED') });
    expect(payNext(qr, { result: 'CANCELED' }, 'status')).toEqual({ pay: choosePay(both.surfaces) });
    expect(payNext(both, { result: 'UNAVAILABLE' }, 'start', 'HOSTED')).toEqual({ pay: choosePay(both.surfaces, 'UNAVAILABLE') });
  });
  it('choosing the desk ends at the desk unless the visitor had already paid or it is still clearing', () => {
    for (const r of ['CANCELED', 'NONE', 'FAILED', 'EXPIRED', 'OPEN', 'UNAVAILABLE', 'RATE_LIMITED'] as const) expect(payNext(both, { result: r }, 'cancel')).toEqual({ done: 'DESK' });
    expect(payNext(both, { result: 'PROCESSING' }, 'cancel')).toMatchObject({ pay: { view: 'CHECKING', processing: true } });
  });
});

describe('tablet card calls', () => {
  it('name the visit only by its submit key, send no cookie and no payment id', async () => {
    const f = vi.fn(async () => json(ready('HOSTED'))); vi.stubGlobal('fetch', f);
    expect(await walkInTabletApi.card('start', token, visitKey, signal(), 'HOSTED')).toEqual(ready('HOSTED'));
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/walk-in-kiosk/card-payment/start');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', mode: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(JSON.parse(String(init.body))).toEqual({ device: token, visit: visitKey, surface: 'HOSTED' });
    f.mockImplementation(async () => json({ result: 'OPEN' }));
    expect(await walkInTabletApi.card('status', token, visitKey, signal())).toEqual({ result: 'OPEN' });
    expect(JSON.parse(String((f.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ device: token, visit: visitKey });
    expect((f.mock.calls[1] as unknown as [string])[0]).toBe('/api/v1/walk-in-kiosk/card-payment/status');
    await walkInTabletApi.card('cancel', token, visitKey, signal());
    expect((f.mock.calls[2] as unknown as [string])[0]).toBe('/api/v1/walk-in-kiosk/card-payment/cancel');
  });
  it('refuse bad input without sending, and treat anything odd as unavailable', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    expect(await walkInTabletApi.card('start', 'bad', visitKey, signal(), 'HOSTED')).toEqual({ result: 'INVALID' });
    expect(await walkInTabletApi.card('start', token, 'short', signal(), 'HOSTED')).toEqual({ result: 'INVALID' });
    expect(await walkInTabletApi.card('start', token, visitKey, signal())).toEqual({ result: 'INVALID' });
    expect(await walkInTabletApi.card('status', token, visitKey, signal(), 'HOSTED')).toEqual({ result: 'INVALID' });
    expect(await walkInTabletApi.card('start', token, visitKey, signal(), 'OTHER' as never)).toEqual({ result: 'INVALID' });
    expect(f).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn(async () => json({ result: 'PAID', paymentId: '66666666-6666-4666-8666-666666666666' })));
    expect(await walkInTabletApi.card('status', token, visitKey, signal())).toEqual({ result: 'UNAVAILABLE' });
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...ready('HOSTED'), url: 'http://evil.example/x' })));
    expect(await walkInTabletApi.card('start', token, visitKey, signal(), 'HOSTED')).toEqual({ result: 'UNAVAILABLE' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await walkInTabletApi.card('cancel', token, visitKey, signal())).toEqual({ result: 'UNAVAILABLE' });
  });
});

describe('pay screens', () => {
  it('offers the tablet form, the phone and the desk, says it is test mode, and shows the price', () => {
    const html = renderToStaticMarkup(<WalkInVisitorView {...props()}/>);
    for (const k of ['vPayHere', 'vPayPhone', 'vPayDesk', 'vPayTest'] as const) expect(html).toContain(WALK_IN_COPY.en[k]);
    expect(html).toContain('$25.00');
    const phoneOnly = renderToStaticMarkup(<WalkInVisitorView {...props({ pay: choosePay(['HOSTED']) })}/>);
    expect(phoneOnly).not.toContain(WALK_IN_COPY.en.vPayHere); expect(phoneOnly).toContain(WALK_IN_COPY.en.vPayDesk);
    expect(renderToStaticMarkup(<WalkInVisitorView {...props({ pay: choosePay(['HOSTED'], 'EXPIRED') })}/>)).toContain(WALK_IN_COPY.en.vPayEXPIRED);
  });
  it('the QR screen shows the code and a way back; waiting screens say what is happening', () => {
    const qr = renderToStaticMarkup(<WalkInVisitorView {...props({ pay: { ...both, view: 'QR', url: 'https://checkout.stripe.com/c/pay/cs_test_abc' } })}/>);
    expect(qr).toContain('data-testid="walkin-qr"'); expect(qr).toContain(WALK_IN_COPY.en.vPayScan); expect(qr).toContain(WALK_IN_COPY.en.vPayOther);
    expect(qr).not.toContain('cs_test_abc'); // the address is drawn as a code, not printed
    expect(renderToStaticMarkup(<WalkInVisitorView {...props({ pay: { ...both, view: 'STARTING' } })}/>)).toContain(WALK_IN_COPY.en.vPayStarting);
    expect(renderToStaticMarkup(<WalkInVisitorView {...props({ pay: { ...both, view: 'CHECKING', processing: true } })}/>)).toContain(WALK_IN_COPY.en.vPayProcessing);
    const form = renderToStaticMarkup(<WalkInVisitorView {...props({ pay: { ...both, view: 'FORM', clientSecret: 'cs_test_abc_secret_def', accountRef: 'acct_123' } })}/>);
    expect(form).toContain('data-testid="walkin-card-form"'); expect(form).not.toContain('cs_test_abc_secret_def');
  });
  it('renders in Korean and Spanish and in all three themes', () => {
    for (const language of ['ko', 'es'] as const) expect(renderToStaticMarkup(<WalkInVisitorView {...props({ language })}/>)).toContain(WALK_IN_COPY[language].vPayPhone);
    for (const mode of ['modern', 'classic', 'big-button'] as const) expect(renderToStaticMarkup(<WalkInVisitorView {...props({ mode })}/>)).toContain('data-testid="walkin-pay"');
  });
  it('done says paid only when the server said PAID, otherwise the desk price', () => {
    const paid = renderToStaticMarkup(<WalkInVisitorView {...props({ step: 'DONE', paid: 'CARD' })}/>);
    expect(paid).toContain('Paid $25.00'); expect(paid).not.toContain(WALK_IN_COPY.en.vDoneDesk.replace('{price}', '$25.00'));
    expect(renderToStaticMarkup(<WalkInVisitorView {...props({ step: 'DONE', paid: 'DESK' })}/>)).toContain(WALK_IN_COPY.en.vDoneDesk.replace('{price}', '$25.00'));
    expect(renderToStaticMarkup(<WalkInVisitorView {...props({ step: 'DONE', paid: 'NOT_DUE' })}/>)).toContain(WALK_IN_COPY.en.vDoneFree);
  });
  it('the phone page never claims a result and reads nothing', () => {
    const html = renderToStaticMarkup(<WalkInPaidView language="es-US"/>);
    expect(html).toContain(WALK_IN_COPY.es.vPaidBody); expect(html).toContain('lang="es"');
    const route = readFileSync(new URL('../src/app/kiosk/walk-in/paid/page.tsx', import.meta.url), 'utf8');
    expect(route).toContain("referrer: 'no-referrer'"); expect(route).toContain('index: false'); expect(route).not.toMatch(/fetch\(|searchParams/);
  });
});

describe('desk payment and a card payment', () => {
  const visit = { visitId: '66666666-6666-4666-8666-666666666666', leadId: '55555555-5555-4555-8555-555555555555', version: 2, createdAt: '2026-11-19T09:00:00.000Z',
    language: 'en', contact: { givenName: 'Sam', familyName: 'Example', email: null, mobile: '+15552010000' },
    participants: [{ givenName: 'Sam', familyName: 'Example', birthDate: '1990-01-01', isContact: true, isMinor: false }],
    offer: { key: 'day-pass', kind: 'DAY_PASS', name: 'Day pass', priceMinor: 2500 }, paymentState: 'PAID_CARD', paidMethod: null, paidAt: null, cardPaidAt: '2026-11-19T09:05:00.000Z',
    marketingOptIn: false, heardFrom: '', waiverSignedAt: '2026-11-19T09:00:00.000Z' } as unknown as WalkInOverview['visits'][number];
  const base = { language: 'en', waiting: false, hasSchool: true, overview: { state: 'READY' as const, read: { canManage: false, configured: true, enabled: true, devices: [], visits: [visit] } },
    settings: null, draft: null, detail: null, busy: false, label: '', hours: 8, scope: null };
  it('a card payment still open or clearing is its own refusal', () => {
    expect(walkInErrorFor(409, 'WALKIN_CARD_PAYMENT_OPEN').kind).toBe('CARD_PENDING');
    expect(walkInErrorFor(409, 'WALKIN_CARD_PAYMENT_IN_PROGRESS').kind).toBe('CARD_PENDING');
    expect(renderToStaticMarkup(<WalkInStaffView {...base} outcome={{ kind: 'CARD_PENDING' }}/>)).toContain(WALK_IN_COPY.en.oCARD_PENDING);
  });
  it('staff are told to hand back money when the visitor had already paid by card', () => {
    const html = renderToStaticMarkup(<WalkInStaffView {...base} outcome={{ kind: 'PAID_BY_CARD' }}/>);
    expect(html).toContain(WALK_IN_COPY.en.paidByCard); expect(html).toContain('role="alert"'); expect(html).toContain(WALK_IN_COPY.en.pPAID_CARD);
    expect(readFileSync(new URL('../src/components/walk-in-kiosk/staff.tsx', import.meta.url), 'utf8')).toContain("r?.visit.paymentState === 'PAID_CARD'");
  });
});
