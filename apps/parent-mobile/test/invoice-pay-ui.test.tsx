import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { ParentApp } from '../src/ParentApp';
import { createParentApi, type ParentApi } from '../src/api/client';
import { createSampleApi } from '../src/sample/sample-api';
import { verifyParentInvoicePayments } from '@hon/contracts/parent-invoice-pay';
import { NOW } from './fixtures';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'dismiss' })) }));

const INV = '66666666-6666-4666-8666-666666666666';
const signedOut = { token: async () => null, clear: async () => {}, subscribe: () => () => {} };
const now = () => new Date(NOW);
let n = 0;
const newKey = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const liveApi = createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => null, fetchImpl: jest.fn() });
const URL = 'https://checkout.stripe.test/pay/cs_1';

function payable(over: Record<string, unknown> = {}) {
  return verifyParentInvoicePayments({ canPay: true, testMode: true, invoices: [{ invoiceId: INV, childName: 'Mia Sample', currency: 'USD', totalMinor: 14900,
    balanceMinor: 14900, dueAt: '2026-11-22T08:00:00.000Z', payState: 'NONE', payable: true, ...over }] });
}

async function openBilling(api: ParentApi) {
  await render(<ParentApp api={liveApi} session={signedOut} now={now} newKey={newKey} sampleApi={() => api} />);
  await fireEvent.press(await screen.findByRole('button', { name: 'Try with a sample family' }));
  await screen.findByRole('button', { name: 'Open Mia Sample journey' });
  await fireEvent.press(screen.getByRole('tab', { name: 'More' }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Open Membership & billing' }));
}

beforeEach(() => { (WebBrowser.openBrowserAsync as jest.Mock).mockClear(); });

describe('pay an invoice on the school processor page', () => {
  it('the sample family offers no payment', async () => {
    await openBilling(createSampleApi(now));
    await screen.findAllByText('$149.00');
    expect(screen.queryByText('Pay an invoice')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull();
  });

  it('opens the hosted page, then shows HON\'s recorded answer and re-reads billing', async () => {
    const start = jest.fn(async () => ({ ok: true as const, replayed: false, data: { state: 'OPEN' as const, url: URL, expiresAt: '2026-11-17T15:30:00.000Z', amountMinor: 14900, currency: 'USD' } }));
    const confirm = jest.fn(async () => ({ ok: true as const, replayed: false, data: { state: 'SUCCEEDED' as const } }));
    let reads = 0;
    const base = createSampleApi(now);
    const api = { ...base, invoicePayments: async () => ({ ok: true as const, data: reads++ === 0 ? payable() : payable({ payState: 'SUCCEEDED', payable: false, balanceMinor: 0 }) }),
      startInvoicePayment: start, confirmInvoicePayment: confirm } as ParentApi;
    await openBilling(api);
    expect(await screen.findByText('Test mode: no real money moves')).toBeTruthy();
    await fireEvent.press(await screen.findByRole('button', { name: 'Pay $149.00 for Mia Sample' }));
    expect(await screen.findByText('Paid. Thank you! Your school has the payment.')).toBeTruthy();
    expect(start).toHaveBeenCalledWith(INV, expect.any(String));
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(URL);
    expect(confirm).toHaveBeenCalledWith(INV, expect.any(String));
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull();
  });

  it('a closed page with no payment says not paid; nothing is claimed from the page closing', async () => {
    const api = { ...createSampleApi(now), invoicePayments: async () => ({ ok: true as const, data: payable() }),
      startInvoicePayment: async () => ({ ok: true as const, replayed: false, data: { state: 'OPEN' as const, url: URL, expiresAt: '2026-11-17T15:30:00.000Z', amountMinor: 14900, currency: 'USD' } }),
      confirmInvoicePayment: async () => ({ ok: true as const, replayed: false, data: { state: 'OPEN' as const } }) } as ParentApi;
    await openBilling(api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Pay $149.00 for Mia Sample' }));
    expect(await screen.findByText('Not paid yet. You can open the payment page again.')).toBeTruthy();
    expect(screen.queryByText(/Paid\. Thank you/)).toBeNull();
  });

  it('a lost start answer is retried with the same key; a refusal shows the school message and opens no page', async () => {
    const keys: string[] = [];
    let call = 0;
    const api = { ...createSampleApi(now), invoicePayments: async () => ({ ok: true as const, data: payable() }),
      startInvoicePayment: async (_id: string, key: string) => { keys.push(key); return call++ === 0
        ? { ok: false as const, state: 'unknown' as const } : { ok: false as const, state: 'refused' as const, code: 'PARENT_INVOICE_PAY_IN_PROGRESS' }; } } as ParentApi;
    await openBilling(api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Pay $149.00 for Mia Sample' }));
    expect(await screen.findByText(/won't be charged twice/)).toBeTruthy();
    await fireEvent.press(await screen.findByRole('button', { name: 'Pay $149.00 for Mia Sample' }));
    expect(await screen.findByText('A payment for this invoice is already in progress.')).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
  });

  it('an unavailable pay list says so and leaves billing readable', async () => {
    await openBilling({ ...createSampleApi(now), invoicePayments: async () => ({ ok: false as const, state: 'unavailable' as const }) } as ParentApi);
    expect(await screen.findByText('Paying in the app is unavailable right now.')).toBeTruthy();
    expect((await screen.findAllByText('$149.00')).length).toBe(2);
  });
});
