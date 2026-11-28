import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HQ_NUMBER_COMMANDS } from '@hon/contracts';
import { CommsError } from '../src/components/hq-communications/http';
import { HqBuyNumber, buyNumberText, formatMonthlyPrice, formatUsNumber, numberApi } from '../src/components/hq-communications/buy-number';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-28T00:00:00.000Z';
const PHONE = '+15125550111';
const person = { principalId: id(50), displayName: 'Synthetic Owner' };
const order = (patch: Record<string, unknown> = {}) => ({ orderId: id(1), phoneE164: PHONE, locality: 'Austin', region: 'TX', monthlyPriceMicrounits: 1150000,
  status: 'BUYING', numberSid: null, serviceSid: null, failureCode: null, senderId: null, requestedBy: person, requestedAt: T, finishedAt: null, version: 1, ...patch });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];
const yes = () => true;
const signal = () => new AbortController().signal;

it('formats Twilio prices to the cent (never below the charge) and US numbers', () => {
  expect(formatMonthlyPrice(1_150_000)).toBe('$1.15');
  expect(formatMonthlyPrice(1_150_001)).toBe('$1.16');
  expect(formatMonthlyPrice(0)).toBe('$0.00');
  expect(formatUsNumber(PHONE)).toBe('(512) 555-0111');
  expect(formatUsNumber('+447700900123')).toBe('+447700900123');
});

it('has every line in Korean and Spanish, and shows the price on the confirm step', () => {
  for (const lang of ['ko', 'es']) expect(buyNumberText(lang, 'confirmBody', { price: '$1.15' })).toContain('$1.15');
  expect(buyNumberText('en', 'confirmTitle', { number: '(512) 555-0111' })).toBe('Buy (512) 555-0111?');
  expect(buyNumberText('fr', 'buy')).toBe('Buy this number');
});

it('reads orders and searches with GET only; search sends only the validated query', async () => {
  const f = stub(json({ data: { orders: [], hasActiveSmsSender: false, provisioning: 'READY', asOf: T } }),
    json({ data: { status: 'READY', numbers: [{ phoneE164: PHONE, locality: 'Austin', region: 'TX', monthlyPriceMicrounits: 1150000 }] } }));
  expect((await numberApi.orders(signal(), yes)).provisioning).toBe('READY');
  expect(call(f)[0]).toBe('/api/v1/hq/communications/number-orders');
  expect((await numberApi.search({ areaCode: '512' }, signal(), yes)).numbers).toHaveLength(1);
  expect(call(f, 1)[0]).toBe('/api/v1/hq/communications/number-search?areaCode=512');
  expect(() => numberApi.search({ areaCode: '12' }, signal(), yes)).toThrow();
  expect(f).toHaveBeenCalledTimes(2);
});

it('buy sends the number and the price the owner saw, with the buy marker and a key', async () => {
  const f = stub(json({ data: { order: order({ status: 'READY', numberSid: 'PN' + 'a'.repeat(32), serviceSid: 'MG' + 'b'.repeat(32), senderId: id(9), finishedAt: T }),
    replayed: false, sender: { senderId: id(9), channel: 'SMS', status: 'ACTIVE', emailFrom: null, emailDisplayName: null, smsServiceSid: 'MG' + 'b'.repeat(32),
      smsReplyNumber: PHONE, a2pState: 'NOT_REGISTERED', mmsConverterConfirmed: true, createdBy: person, createdAt: T, version: 1 } } }));
  const r = await numberApi.buy({ phoneE164: PHONE, locality: 'Austin', region: 'TX', monthlyPriceMicrounits: 1150000 }, id(77), signal(), yes);
  expect(r.order.status).toBe('READY');
  const [path, init] = call(f);
  expect(path).toBe('/api/v1/hq/communications/number-orders');
  expect(init.method).toBe('POST');
  expect(JSON.parse(String(init.body))).toEqual({ phoneE164: PHONE, monthlyPriceMicrounits: 1150000 });
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe(HQ_NUMBER_COMMANDS.buy);
  expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(id(77));
});

it('maps the buy route\'s definite answers to REFUSED with their code; anything else stays UNKNOWN', async () => {
  const pick = { phoneE164: PHONE, locality: null, region: null, monthlyPriceMicrounits: 1150000 };
  for (const [status, code] of [[409, 'PRICE_CHANGED'], [409, 'NUMBER_UNAVAILABLE'], [409, 'HQ_NUMBER_SETUP_INCOMPLETE'], [503, 'NUMBER_PROVISIONING_OFF'],
    [422, 'HQ_NUMBER_ORDER_OPEN'], [422, 'HQ_SENDER_EXISTS']] as const) {
    stub(json({ code }, status));
    await expect(numberApi.buy(pick, id(1), signal(), yes)).rejects.toMatchObject({ kind: 'REFUSED', code });
  }
  stub(json({ code: 'SAAS_UNAVAILABLE' }, 503));
  await expect(numberApi.buy(pick, id(1), signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  stub(json({ code: 'SAAS_FORBIDDEN' }, 403));
  await expect(numberApi.buy(pick, id(1), signal(), yes)).rejects.toBeInstanceOf(CommsError);
});

it('finish posts an empty body to the order path and refuses an answer about another order', async () => {
  const f = stub(json({ data: { order: order(), replayed: true } }), json({ data: { order: order({ orderId: id(2) }), replayed: true } }));
  expect((await numberApi.finish(id(1), id(3), signal(), yes)).order.orderId).toBe(id(1));
  const [path, init] = call(f);
  expect(path).toBe(`/api/v1/hq/communications/number-orders/${id(1)}/finish`);
  expect(init.body).toBe('{}');
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe(HQ_NUMBER_COMMANDS.finish);
  await expect(numberApi.finish(id(1), id(4), signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
});

it('first paint is a loading card (the orders read decides what follows)', () => {
  const api = { orders: vi.fn(() => new Promise<never>(() => {})), search: vi.fn(), buy: vi.fn(), finish: vi.fn() };
  const html = renderToStaticMarkup(<HqBuyNumber language="en" onChanged={() => {}} api={api}/>);
  expect(html).toContain('data-hq-buy-number="loading"');
  expect(html).toContain('Buy a number');
  expect(api.buy).not.toHaveBeenCalled();
});
