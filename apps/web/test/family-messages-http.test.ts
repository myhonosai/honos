import { afterEach, describe, expect, it, vi } from 'vitest';
import { FamilyMessagesAccessError, FamilyMessagesRefusal, loadFamilyMessageInbox, markFamilyMessageThreadRead, replyFamilyMessage, sendAttempt, sendParentFamilyMessage } from '../src/components/family-messages/http';

// 0330 family messages web client: fixed same-origin calls, verified answers, definite refusals vs unknown outcomes.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
afterEach(() => vi.restoreAllMocks());

describe('family messages http', () => {
  it('sends a parent message as a browser command with no selector', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(201, { data: { threadId: A, version: 2, message: { messageId: B, from: 'FAMILY', mine: true, body: 'Hi', sentAt: '2026-11-20T17:00:00.000Z' } }, meta: { replayed: false } }));
    const out = await sendParentFamilyMessage('Hi', 'key-1');
    expect(out.receipt.threadId).toBe(A);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('/api/v1/parent/messages/school');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', body: JSON.stringify({ body: 'Hi' }) });
    expect((init as RequestInit).headers).toMatchObject({ 'X-HON-Human-Command': 'parent.family_messages.send', 'Idempotency-Key': 'key-1' });
  });
  it('refuses bad text before any call and refuses unverified answers', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(201, { data: { threadId: A, version: 2, message: { messageId: B, from: 'SCHOOL', mine: true, body: 'Hi', sentAt: '2026-11-20T17:00:00.000Z' } }, meta: { replayed: false } }));
    await expect(sendParentFamilyMessage(' ', 'k')).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(sendParentFamilyMessage('Hi', 'k')).rejects.toThrow();
  });
  it('tells definite refusals from unknown outcomes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(429, { code: 'FAMILY_MESSAGES_RATE_LIMITED' })).mockResolvedValueOnce(json(503, { code: 'FAMILY_MESSAGES_UNAVAILABLE' }))
      .mockResolvedValueOnce(json(403, { code: 'FAMILY_MESSAGES_FORBIDDEN' }));
    await expect(sendParentFamilyMessage('Hi', 'k')).rejects.toBeInstanceOf(FamilyMessagesRefusal);
    const unknown = await sendParentFamilyMessage('Hi', 'k').catch(e => e);
    expect(unknown).not.toBeInstanceOf(FamilyMessagesRefusal); expect(unknown).toBeInstanceOf(Error);
    await expect(loadFamilyMessageInbox({ organizationId: A, schoolId: B })).rejects.toBeInstanceOf(FamilyMessagesAccessError);
  });
  it('marks read and replies only up to the newest message on screen', async () => {
    const C = '33333333-3333-4333-8333-333333333333';
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: { threadId: A, version: 4, unreadCount: 1 }, meta: {} }))
      .mockResolvedValueOnce(json(201, { data: { threadId: A, version: 5, message: { messageId: C, from: 'SCHOOL', mine: true, body: 'Thanks', sentAt: '2026-11-20T17:00:00.000Z' } }, meta: { replayed: false } }));
    const scope = { organizationId: A, schoolId: B };
    expect((await markFamilyMessageThreadRead(scope, A, B)).unreadCount).toBe(1);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ body: JSON.stringify({ throughMessageId: B }) });
    expect((await replyFamilyMessage(scope, A, 'Thanks', 'k', B)).receipt.version).toBe(5);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ body: JSON.stringify({ body: 'Thanks', throughMessageId: B }) });
    await expect(markFamilyMessageThreadRead(scope, A, 'nope')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps the key only for the same text', () => {
    let n = 0; const key = () => `k${++n}`;
    const first = sendAttempt('Hi', null, key);
    expect(sendAttempt('Hi', first, key)).toBe(first);
    expect(sendAttempt('Hi!', first, key).key).toBe('k2');
  });
});
