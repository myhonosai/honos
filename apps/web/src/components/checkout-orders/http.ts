import { verifySchoolCheckoutOrders, verifySchoolPublicCheckoutOrders, type SchoolCheckoutOrders, type SchoolPublicCheckoutOrders } from '@hon/contracts';

/**
 * Family checkout orders (0598): one same-origin read. The server checks the shell's school scope again with
 * school_checkout.manage. Read only: nothing here changes an order, takes a payment or messages anyone.
 */
export class CheckoutOrdersAccessError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export type CheckoutOrdersScope = Readonly<{ organizationId: string; schoolId: string }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(): never { throw new Error('The answer could not be checked. Nothing is assumed. Refresh to try again.'); }

async function readOrders(scope: CheckoutOrdersScope, path: 'orders' | 'public-orders'): Promise<unknown> {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) invalid();
  const url = `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/payments/checkout-pages/${path}`;
  const response = await fetch(url, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: { Accept: 'application/json' } });
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const value: unknown = await response.json().catch(() => invalid());
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const root = value as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401) throw new CheckoutOrdersAccessError('Your session has ended. Sign in again.', 401);
    if (response.status === 403) throw new CheckoutOrdersAccessError('Checkout orders are not available on this account right now.', 403);
    throw new Error('Checkout orders are unavailable right now. Refresh to try again.');
  }
  if (!Object.hasOwn(root, 'data')) invalid();
  return root.data;
}

export async function loadCheckoutOrders(scope: CheckoutOrdersScope): Promise<SchoolCheckoutOrders> {
  return verifySchoolCheckoutOrders(await readOrders(scope, 'orders'));
}
/** 0627: sign-ups from a page's family link by people without an account, with the contact details they typed. */
export async function loadPublicCheckoutOrders(scope: CheckoutOrdersScope): Promise<SchoolPublicCheckoutOrders> {
  return verifySchoolPublicCheckoutOrders(await readOrders(scope, 'public-orders'));
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  PAID: 'Paid', OPEN: 'Waiting for payment', UNPAID: 'Not paid', CANCELED: 'Canceled', REVIEW: 'Needs review',
};
export function money(minor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
}
