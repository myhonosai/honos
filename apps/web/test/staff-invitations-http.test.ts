import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { staffInvitationApi, type StaffCommand } from '../src/components/staff-invitations/http';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { organizationId: id(1), schoolId: id(2) };
const item = { invitationId: id(3), schoolId: id(2), roleId: id(4), roleName: 'Front desk', email: 'staff@example.test', status: 'PENDING', expiresAt: '2026-11-06T12:00:00Z' };
const reply = (data: unknown, status = 200) => Response.json({ data }, { status });
const signal = () => new AbortController().signal;
let event: ReturnType<typeof vi.fn>;
beforeEach(() => { event = vi.fn(); const w = new EventTarget(); w.addEventListener('hon:session-invalidated', event); vi.stubGlobal('window', w); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('uses the canonical school-only list endpoint and closed exact-school results', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply([item])); expect(await staffInvitationApi.list(scope, signal())).toEqual([item]);
  expect(f.mock.calls[0]![0]).toBe(`/api/v1/school/schools/${scope.schoolId}/staff-invitations`);
  expect(f.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', method: 'GET' });
  f.mockResolvedValue(reply([{ ...item, schoolId: id(90) }])); await expect(staffInvitationApi.list(scope, signal())).rejects.toThrow();
});
it.each([401, 403, 404, 409, 503])('HTTP %i never becomes an empty list; only current read 401 invalidates the session', async status => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ code: 'ACCOUNT_FORBIDDEN' }, { status }));
  await expect(staffInvitationApi.list(scope, signal())).rejects.toThrow(); expect(event).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
});
it('late or already-aborted reads cannot invalidate a replacement session or dispatch', async () => {
  const abort = new AbortController(); let finish!: (v: Response) => void; const f = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(r => { finish = r; }));
  const task = staffInvitationApi.list(scope, abort.signal); abort.abort(); finish(reply([], 401)); await expect(task).rejects.toThrow(); expect(event).not.toHaveBeenCalled();
  await expect(staffInvitationApi.list(scope, abort.signal)).rejects.toThrow(); expect(f).toHaveBeenCalledOnce();
});
it('binds role lookup to the exact organization/school/id and rejects expanded or mismatched records', async () => {
  const role = { id: item.roleId, code: 'CUSTOM_DESK', name: 'Desk', schoolId: scope.schoolId, permissionCodes: ['crm.lead.read'], version: 1 };
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: role, meta: {} }));
  expect(await staffInvitationApi.role(scope, item.roleId, signal())).toEqual(role);
  expect(f.mock.calls[0]![0]).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/staff-roles/custom/${item.roleId}`);
  for (const data of [{ ...role, schoolId: id(90) }, { ...role, id: id(90) }, { ...role, owner: true }]) {
    f.mockResolvedValue(Response.json({ data, meta: {} })); await expect(staffInvitationApi.role(scope, item.roleId, signal())).rejects.toThrow();
  }
});
it('forwards the immutable original POST path/body/key and the actual human-command marker', async () => {
  const command: StaffCommand = Object.freeze({ kind: 'invite', path: '/api/v1/school/staff-invitations', body: JSON.stringify({ schoolId: scope.schoolId, roleId: item.roleId, email: item.email, ttlHours: 24, token: 'a'.repeat(43) }), key: id(8), subject: 'staff-manager', scope });
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(item)); expect(await staffInvitationApi.command(command, signal())).toEqual(item);
  expect(f.mock.calls[0]).toEqual([command.path, expect.objectContaining({ method: 'POST', body: command.body, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'school-staff-account', 'Idempotency-Key': command.key } })]);
  f.mockResolvedValue(reply({ ...item, roleId: id(90) })); await expect(staffInvitationApi.command(command, signal())).rejects.toThrow();
});
it('bounds JSON streams, refuses redirect/malformed replies and sanitizes unrecognized server errors', async () => {
  const f = vi.spyOn(globalThis, 'fetch'); const redirected = reply([item]); Object.defineProperty(redirected, 'redirected', { value: true });
  for (const r of [redirected, new Response('{broken', { headers: { 'Content-Type': 'application/json' } }), new Response(' '.repeat(131073), { headers: { 'Content-Type': 'application/json' } })]) {
    f.mockResolvedValue(r); await expect(staffInvitationApi.list(scope, signal())).rejects.toThrow();
  }
  f.mockResolvedValue(Response.json({ code: 'PRIVATE_SECRET_RAW_ERROR', detail: 'private' }, { status: 403 }));
  await expect(staffInvitationApi.list(scope, signal())).rejects.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE', status: 403 });
});
