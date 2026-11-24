import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelParentClass, ParentClassBookingRefusal } from '../src/components/parent-class-booking-http';

// 0329 parent booking web client: a definite refusal drops the key; an unknown outcome keeps it.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const A = '11111111-1111-4111-8111-111111111111';
afterEach(() => vi.restoreAllMocks());

describe('parent class booking http', () => {
  it('treats a send still in progress as an unknown outcome, not a refusal', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(409, { code: 'IDEMPOTENCY_IN_PROGRESS' })).mockResolvedValueOnce(json(409, { code: 'PARENT_CLASS_BOOKING_NOT_CANCELLABLE' }));
    const pending = await cancelParentClass(A, 2, 'k').catch(e => e);
    expect(pending).toBeInstanceOf(Error); expect(pending).not.toBeInstanceOf(ParentClassBookingRefusal);
    await expect(cancelParentClass(A, 2, 'k')).rejects.toBeInstanceOf(ParentClassBookingRefusal);
  });
});
