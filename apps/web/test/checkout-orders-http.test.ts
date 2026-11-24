import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckoutOrdersAccessError, loadCheckoutOrders, loadPublicCheckoutOrders, money } from '../src/components/checkout-orders/http';

// 0598 checkout orders web client: one fixed same-origin read, verified answer, no command header.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const scope = { organizationId: A, schoolId: B };
const order = { orderId: C, checkoutId: A, title: 'Camp - Week', optionKey: 'week', familyName: 'Park Family',
  participants: [{ name: 'Mina Park', answers: { size: 'M', photo: true } }], addOnKeys: ['patch'], waiverAccepted: true,
  amountMinor: 5500, currency: 'USD', status: 'PAID', createdAt: '2026-11-19T10:00:00.000Z', settledAt: '2026-11-19T10:05:00.000Z' };
afterEach(() => vi.restoreAllMocks());

describe('checkout orders http', () => {
  it('reads the school orders as a plain same-origin GET', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { data: { orders: [order] } }));
    expect((await loadCheckoutOrders(scope)).orders[0]!.participants[0]!.answers.photo).toBe(true);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`/api/v1/organizations/${A}/schools/${B}/payments/checkout-pages/orders`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store' });
    expect((init as RequestInit).headers).not.toHaveProperty('X-HON-Human-Command');
  });
  it('refuses an unverified answer, a bad scope and a forbidden read', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: { orders: [{ ...order, paymentId: C }] } }))
      .mockResolvedValueOnce(json(403, { code: 'SCHOOL_CHECKOUT_FORBIDDEN' }));
    await expect(loadCheckoutOrders(scope)).rejects.toThrow();
    await expect(loadCheckoutOrders(scope)).rejects.toBeInstanceOf(CheckoutOrdersAccessError);
    await expect(loadCheckoutOrders({ organizationId: 'x', schoolId: B })).rejects.toThrow();
  });
  it('reads link sign-ups (0627) from their own path with the typed contact, and refuses extra fields', async () => {
    const link = { orderId: C, checkoutId: A, title: 'Camp - Week', optionKey: 'week', buyer: { name: 'Jo Kim', email: 'jo@example.com', mobile: null },
      participants: [{ name: 'Ana Kim', answers: { belt: 'White' } }], addOnKeys: [], waiverAccepted: false, amountMinor: 5000, currency: 'USD', status: 'OPEN',
      createdAt: '2026-11-21T10:00:00.000Z', settledAt: null };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: { orders: [link] } }))
      .mockResolvedValueOnce(json(200, { data: { orders: [{ ...link, keyHash: 'x' }] } })).mockResolvedValueOnce(json(403, { code: 'SCHOOL_CHECKOUT_FORBIDDEN' }));
    expect((await loadPublicCheckoutOrders(scope)).orders[0]!.buyer.email).toBe('jo@example.com');
    expect(fetcher.mock.calls[0]![0]).toBe(`/api/v1/organizations/${A}/schools/${B}/payments/checkout-pages/public-orders`);
    await expect(loadPublicCheckoutOrders(scope)).rejects.toThrow();
    await expect(loadPublicCheckoutOrders(scope)).rejects.toBeInstanceOf(CheckoutOrdersAccessError);
  });
  it('formats money', () => { expect(money(5500, 'USD')).toMatch(/55\.00/); });
});
