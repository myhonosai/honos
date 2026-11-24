import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { ParentApp } from '../src/ParentApp';
import { createParentApi, type ParentApi } from '../src/api/client';
import { createSampleApi } from '../src/sample/sample-api';
import { verifyParentCheckoutPages, type FamilyCheckoutPage } from '@hon/contracts/family-checkout';
import { checkoutInput, checkoutReady, checkoutTotal, emptyCheckoutDraft } from '../src/more/CheckoutArea';
import { NOW } from './fixtures';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'dismiss' })) }));

const signedOut = { token: async () => null, clear: async () => {}, subscribe: () => () => {} };
const now = () => new Date(NOW);
let n = 0;
const newKey = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const liveApi = createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => null, fetchImpl: jest.fn() });
const U = (k: number) => `00000000-0000-4000-8000-${String(k).padStart(12, '0')}`;
const PAGE: FamilyCheckoutPage = {
  checkoutId: U(101), version: 3, group: 'events', title: 'Summer camp', description: null, currency: 'USD', maxParticipants: 2, blocks: [],
  options: [{ key: 'week', label: 'Full week', description: null, priceMinor: 5000, additionalParticipantMinor: 3000, mostPopular: false, placesLeft: 5 }],
  addOns: [{ key: 'patch', label: 'Patch', amountMinor: 500, required: true }, { key: 'shirt', label: 'Shirt', amountMinor: 1500, required: false }],
  questions: [{ key: 'size', label: 'Shirt size', kind: 'CHOICE', required: true, options: ['S', 'M'] }],
  waiver: 'Camp rules', thankYou: 'See you at camp!',
};
const view = (patch = {}) => verifyParentCheckoutPages({ schoolName: 'Dojo', canBuy: true, canPay: true, testMode: true, pages: [PAGE],
  children: [{ studentProfileId: U(1), displayName: 'Mina Park' }, { studentProfileId: U(2), displayName: 'Joon Park' }], orders: [], ...patch });
const ORDER = { orderId: U(900), checkoutId: U(101), title: 'Summer camp - Full week', optionKey: 'week', participantCount: 1, amountMinor: 5500, currency: 'USD', createdAt: '2026-11-19T10:00:00.000Z' };

async function openCheckout(api: ParentApi) {
  await render(<ParentApp api={liveApi} session={signedOut} now={now} newKey={newKey} sampleApi={() => api} />);
  await fireEvent.press(await screen.findByRole('button', { name: 'Try with a sample family' }));
  await screen.findByRole('button', { name: 'Open Mia Sample journey' });
  await fireEvent.press(screen.getByRole('tab', { name: 'More' }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Open Sign up & pay' }));
}
async function fillMina() {
  await fireEvent.press(await screen.findByRole('button', { name: 'Choose Full week for Summer camp' }));
  await fireEvent.press(screen.getByRole('checkbox', { name: 'Mina Park' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Shirt size for Mina Park: M' }));
  await fireEvent.press(screen.getByRole('checkbox', { name: 'I have read and accept this' }));
}

beforeEach(() => { (WebBrowser.openBrowserAsync as jest.Mock).mockClear(); });

describe('checkout pages', () => {
  it('prices like the server, needs every required answer, and sends only the page ids, children, answers and add-ons', () => {
    const o = PAGE.options[0]!;
    const d = emptyCheckoutDraft(PAGE);
    expect(d.addOns).toEqual(['patch']);
    expect(checkoutReady(PAGE, o, d)).toBe(false);
    const two = { ...d, children: [U(1), U(2)], answers: { [U(1)]: { size: 'M' }, [U(2)]: { size: 'S' } }, addOns: ['patch', 'shirt'], waiverAccepted: true };
    expect(checkoutTotal(PAGE, o, two)).toBe(5000 + 3000 + 500 + 1500);
    expect(checkoutReady(PAGE, o, two)).toBe(true);
    expect(checkoutReady(PAGE, o, { ...two, waiverAccepted: false })).toBe(false);
    expect(checkoutReady(PAGE, o, { ...two, answers: { [U(1)]: { size: 'M' } } })).toBe(false);
    expect(checkoutInput(PAGE, o, two)).toEqual({ checkoutId: U(101), expectedVersion: 3, optionKey: 'week', waiverAccepted: true, addOns: ['patch', 'shirt'],
      participants: [{ studentProfileId: U(1), answers: { size: 'M' } }, { studentProfileId: U(2), answers: { size: 'S' } }] });
  });

  it('orders, opens the school payment page and shows paid only from HON\'s answer', async () => {
    const orderCheckout = jest.fn(async () => ({ ok: true as const, replayed: false,
      data: { orderId: U(900), status: 'OPEN' as const, payState: 'OPEN' as const, amountMinor: 5500, currency: 'USD', url: 'https://checkout.stripe.test/s', expiresAt: '2026-11-19T10:30:00.000Z' } }));
    const confirmCheckoutOrder = jest.fn(async () => ({ ok: true as const, replayed: false, data: { order: { ...ORDER, status: 'PAID' as const }, payState: 'SUCCEEDED' as const } }));
    const api = { ...createSampleApi(now), sampleMode: false, checkoutPages: async () => ({ ok: true as const, data: view() }), orderCheckout, confirmCheckoutOrder } as ParentApi;
    await openCheckout(api);
    await fillMina();
    expect(screen.getByText('Total $55.00')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Continue to payment' }));
    await waitFor(() => expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://checkout.stripe.test/s'));
    expect(orderCheckout).toHaveBeenCalledWith({ checkoutId: U(101), expectedVersion: 3, optionKey: 'week', waiverAccepted: true, addOns: ['patch'],
      participants: [{ studentProfileId: U(1), answers: { size: 'M' } }] }, expect.any(String));
    expect(await screen.findByText('Paid: Summer camp - Full week. Your school has your order.')).toBeTruthy();
    expect(screen.getByText('See you at camp!')).toBeTruthy();
  });

  it('a lost answer is not shown as ordered, and Try again uses the same key', async () => {
    const orderCheckout = jest.fn(async () => ({ ok: false as const, state: 'unknown' as const }));
    await openCheckout({ ...createSampleApi(now), sampleMode: false, checkoutPages: async () => ({ ok: true as const, data: view() }), orderCheckout } as ParentApi);
    await fillMina();
    await fireEvent.press(screen.getByRole('button', { name: 'Continue to payment' }));
    expect(await screen.findByText(/Nothing is shown as ordered until HON confirms it/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(orderCheckout).toHaveBeenCalledTimes(2));
    const calls = orderCheckout.mock.calls as unknown as [unknown, string][];
    expect(calls[1]![1]).toBe(calls[0]![1]);
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
  });

  it('a refusal shows the school\'s reason; a closed page that was not paid is never shown as paid', async () => {
    const orderCheckout = jest.fn(async () => ({ ok: false as const, state: 'refused' as const, code: 'FAMILY_CHECKOUT_FULL' }));
    await openCheckout({ ...createSampleApi(now), sampleMode: false, checkoutPages: async () => ({ ok: true as const, data: view() }), orderCheckout } as ParentApi);
    await fillMina();
    await fireEvent.press(screen.getByRole('button', { name: 'Continue to payment' }));
    expect(await screen.findByText('There are not enough places left.')).toBeTruthy();
  });

  it('an open order can be paid again from Your orders', async () => {
    const startCheckoutOrder = jest.fn(async () => ({ ok: true as const, replayed: false,
      data: { orderId: U(900), status: 'OPEN' as const, payState: 'OPEN' as const, amountMinor: 5500, currency: 'USD', url: 'https://checkout.stripe.test/s', expiresAt: '2026-11-19T10:30:00.000Z' } }));
    const confirmCheckoutOrder = jest.fn(async () => ({ ok: true as const, replayed: false, data: { order: { ...ORDER, status: 'CANCELED' as const }, payState: 'EXPIRED' as const } }));
    await openCheckout({ ...createSampleApi(now), sampleMode: false, checkoutPages: async () => ({ ok: true as const, data: view({ orders: [{ ...ORDER, status: 'OPEN' }] }) }),
      startCheckoutOrder, confirmCheckoutOrder } as ParentApi);
    await fireEvent.press(await screen.findByRole('button', { name: 'Pay $55.00 for Summer camp - Full week' }));
    expect(await screen.findByText('The payment did not go through, so the order was canceled. You were not charged.')).toBeTruthy();
  });

  it('a VIEWER sees the pages but cannot choose; the sample family never orders', async () => {
    await openCheckout({ ...createSampleApi(now), checkoutPages: async () => ({ ok: true as const, data: view({ canBuy: false }) }) } as ParentApi);
    expect(await screen.findByText(/A guardian on the account can buy/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Choose Full week for Summer camp' })).toBeNull();
  });

  it('the sample family sees a sample page and no order button', async () => {
    await openCheckout(createSampleApi(now));
    await fireEvent.press(await screen.findByRole('button', { name: 'Choose Full week for Sample summer camp' }));
    expect(screen.getByText(/This is the sample family, so nothing is ordered or paid/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue to payment' })).toBeNull();
  });
});
