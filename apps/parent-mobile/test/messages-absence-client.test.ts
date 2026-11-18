import { createParentApi } from '../src/api/client';
import { CHILD_A, jsonResponse } from './fixtures';

const KEY = '00000000-0000-4000-8000-000000000001';
const THREAD = '66666666-6666-4666-8666-666666666666';
const MSG = '77777777-7777-4777-8777-777777777777';
function api(fetchImpl: jest.Mock) {
  return createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => 'tok', fetchImpl, timeoutMs: 1000 });
}
const message = (o: Record<string, unknown> = {}) => ({ messageId: MSG, from: 'FAMILY', mine: true, body: 'Hello school', sentAt: '2026-11-17T15:00:00.000Z', ...o });

describe('school messages client', () => {
  it('reads the family conversation with no selectors', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { data: { canWrite: true, schoolName: 'Test School', threadId: THREAD, messages: [message()] } }));
    const result = await api(fetchImpl).schoolMessages();
    expect(result.ok && result.data.messages[0]!.body).toBe('Hello school');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.example.test/v1/parent/messages/school');
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
  });

  it('sends only the body, as a native human command with an Idempotency-Key', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(201, { data: { threadId: THREAD, version: 2, message: message() }, meta: { replayed: false } }));
    const result = await api(fetchImpl).sendSchoolMessage('Hello school', KEY);
    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/parent/messages/school');
    expect(JSON.parse(init.body)).toEqual({ body: 'Hello school' });
    expect(init.headers['x-hon-human-command']).toBe('parent.family_messages.send');
    expect(init.headers['Idempotency-Key']).toBe(KEY);
    expect(init.headers.Origin).toBeUndefined();
  });

  it('a receipt for a different body is not trusted as sent', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(201, { data: { threadId: THREAD, version: 2, message: message({ body: 'Other' }) }, meta: { replayed: false } }));
    expect(await api(fetchImpl).sendSchoolMessage('Hello school', KEY)).toEqual({ ok: false, state: 'unknown' });
  });

  it('a rate limit is a definite refusal with its code', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(429, { code: 'FAMILY_MESSAGES_RATE_LIMITED' }));
    expect(await api(fetchImpl).sendSchoolMessage('Hello school', KEY)).toEqual({ ok: false, state: 'refused', code: 'FAMILY_MESSAGES_RATE_LIMITED' });
  });
});

describe('planned absence client', () => {
  it('reads the child choices from the context read', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { data: { children: [{ studentProfileId: CHILD_A, displayName: 'Test Child A' }] }, meta: {} }));
    const result = await api(fetchImpl).absenceContext();
    expect(result.ok && result.data.children[0]!.studentProfileId).toBe(CHILD_A);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.example.test/v1/parent/planned-absences/context');
  });

  it('submits exactly the child, window and optional reason under the absence command', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(201, { data: { status: 'SUBMITTED', submittedAt: '2026-11-17T15:00:00.000Z' }, meta: { replayed: false } }));
    const input = { studentProfileId: CHILD_A, startsAt: '2026-11-18T08:00:00.000Z', endsAt: '2026-11-19T08:00:00.000Z' };
    expect((await api(fetchImpl).reportAbsence(input, KEY)).ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/parent/planned-absences');
    expect(JSON.parse(init.body)).toEqual(input);
    expect(init.headers['x-hon-human-command']).toBe('parent-planned-absence');
    await api(fetchImpl).reportAbsence({ ...input, reason: 'Trip' }, KEY);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ ...input, reason: 'Trip' });
  });
});
