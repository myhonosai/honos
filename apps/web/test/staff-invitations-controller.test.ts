import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StaffInvitationController, newStaffInvitationToken } from '../src/components/staff-invitations/controller';
import { StaffAccountError, type StaffInvitationApi, type StaffCommand } from '../src/components/staff-invitations/http';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { organizationId: id(1), schoolId: id(2) }, token = 'a'.repeat(43);
const role = { id: id(3), code: 'CUSTOM_FRONT_DESK', name: 'Front desk', schoolId: scope.schoolId, permissionCodes: ['crm.lead.read'], version: 1 };
const invitation = { invitationId: id(4), schoolId: scope.schoolId, roleId: role.id, roleName: role.name, email: 'staff@example.test', expiresAt: '2026-11-06T12:00:00.000Z', status: 'PENDING' as const };
let c: StaffInvitationController, api: StaffInvitationApi, event: ReturnType<typeof vi.fn>;
const tick = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
beforeEach(() => {
  api = { identity: vi.fn().mockResolvedValue(undefined), list: vi.fn().mockResolvedValue([invitation]), role: vi.fn().mockResolvedValue(role), command: vi.fn().mockResolvedValue(invitation) };
  c = new StaffInvitationController('staff-manager', false, api); const w = new EventTarget(); event = vi.fn(); w.addEventListener('hon:session-invalidated', event); vi.stubGlobal('window', w);
});
afterEach(() => { c.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function ready() { await c.verify(scope); await c.loadRole(role.id, c.snapshot().revision); }
function invite(revision = c.snapshot().revision, confirmed = true) { return c.invite({ email: invitation.email, token, ttlHours: 24 }, revision, confirmed); }
it('explicitly checks identity before and after the real school-list boundary, without sending any command', async () => {
  await c.verify(scope); expect(c.snapshot()).toMatchObject({ phase: 'READY', items: [invitation], role: null });
  expect(api.identity).toHaveBeenCalledTimes(2); expect(api.list).toHaveBeenCalledWith(scope, expect.any(AbortSignal)); expect(api.command).not.toHaveBeenCalled();
});
it('does not invent role discovery or accept malformed school selectors', async () => {
  await c.verify({ ...scope, schoolId: 'forged' }); expect(api.list).not.toHaveBeenCalled(); expect(c.snapshot().errorCode).toBe('ACCOUNT_INPUT_INVALID');
  await c.verify(scope); await invite(); expect(api.command).not.toHaveBeenCalled(); expect(api.role).not.toHaveBeenCalled();
});
it.each([undefined, { organizationId: scope.organizationId, schoolId: '' }, { organizationId: '', schoolId: 'partial' }])('explicitly restores incomplete concealed selectors through identity alone: %j', async input => {
  c.conceal(); expect(api.identity).not.toHaveBeenCalled(); await c.verify(input);
  expect(c.snapshot()).toMatchObject({ phase: 'IDLE', items: [], role: null, receipt: null, outcome: 'NONE', pending: false, errorCode: null });
  expect(api.identity).toHaveBeenCalledExactlyOnceWith('staff-manager', expect.any(AbortSignal));
  expect(api.list).not.toHaveBeenCalled(); expect(api.role).not.toHaveBeenCalled(); expect(api.command).not.toHaveBeenCalled();
});
it('identity-only restoration clears earlier private records and cannot authorize a role or command', async () => {
  await ready(); c.conceal(); vi.clearAllMocks(); await c.verify({ organizationId: '', schoolId: '' });
  expect(c.snapshot()).toMatchObject({ phase: 'IDLE', items: [], role: null, receipt: null, outcome: 'NONE', pending: false });
  await c.loadRole(role.id, c.snapshot().revision); await invite(); expect(api.identity).toHaveBeenCalledOnce(); expect(api.list).not.toHaveBeenCalled(); expect(api.role).not.toHaveBeenCalled(); expect(api.command).not.toHaveBeenCalled();
});
it.each([[401, 'SIGN_IN_REQUIRED', 'SESSION'], [403, 'ACCOUNT_IDENTITY_CHANGED', 'IDENTITY'], [403, 'ACCOUNT_FORBIDDEN', 'DENIED'], [503, 'ACCOUNT_UNAVAILABLE', 'UNAVAILABLE']] as const)('incomplete-selector restoration fails closed on identity %s %s', async (status, code, phase) => {
  c.conceal(); vi.mocked(api.identity).mockRejectedValueOnce(new StaffAccountError(status, code)); await c.verify();
  expect(c.snapshot()).toMatchObject({ phase, items: [], role: null, receipt: null, pending: false, errorCode: code });
  expect(api.list).not.toHaveBeenCalled(); expect(api.role).not.toHaveBeenCalled(); expect(api.command).not.toHaveBeenCalled(); expect(event).not.toHaveBeenCalled();
});
it('retired identity-only restoration cannot reopen concealed selector entry', async () => {
  c.conceal(); let finish!: () => void; vi.mocked(api.identity).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const task = c.verify(); await tick(); expect(c.snapshot().phase).toBe('READING'); const signal = vi.mocked(api.identity).mock.calls[0]![1];
  c.conceal(); finish(); await task; expect(signal.aborted).toBe(true); expect(c.snapshot().phase).toBe('CONCEALED'); expect(api.list).not.toHaveBeenCalled();
});
it('incomplete selectors cannot release or move an UNKNOWN command capsule', async () => {
  await ready(); vi.mocked(api.command).mockRejectedValueOnce(Error('lost')); await invite(); const original = vi.mocked(api.command).mock.calls[0]![0]; c.conceal(); vi.clearAllMocks();
  await c.verify(); await c.verify({ organizationId: id(8), schoolId: id(9) }); await c.retry(c.snapshot().revision);
  expect(c.snapshot()).toMatchObject({ phase: 'CONCEALED', pending: true, outcome: 'UNKNOWN', items: [], role: null, receipt: null });
  expect(api.identity).not.toHaveBeenCalled(); expect(api.list).not.toHaveBeenCalled(); expect(api.command).not.toHaveBeenCalled();
  await c.verify(scope); await c.retry(c.snapshot().revision); expect(vi.mocked(api.command).mock.calls[0]![0]).toBe(original); expect(c.snapshot().outcome).toBe('SUCCESS');
});
it('a known role is read through its exact organization/school before it can be selected', async () => {
  await ready(); expect(api.role).toHaveBeenCalledWith(scope, role.id, expect.any(AbortSignal)); expect(c.snapshot().role).toEqual(role);
  expect(api.command).not.toHaveBeenCalled();
});
it('requires current explicit confirmation and sends only the closed invitation contract', async () => {
  await ready(); await invite(undefined, false); expect(api.command).not.toHaveBeenCalled(); await invite();
  const command = vi.mocked(api.command).mock.calls[0]![0]; expect(command.path).toBe('/api/v1/school/staff-invitations');
  expect(JSON.parse(command.body)).toEqual({ schoolId: scope.schoolId, roleId: role.id, email: invitation.email, ttlHours: 24, token });
  expect(command.key).toMatch(/^[a-f0-9-]{36}$/); expect(c.snapshot().outcome).toBe('SUCCESS');
});
it('synchronously blocks double clicks and retained submissions after successful settlement before another render', async () => {
  await ready(); const revision = c.snapshot().revision, uuid = vi.spyOn(crypto, 'randomUUID');
  const first = invite(revision); await invite(revision); await first; await invite(revision); expect(api.command).toHaveBeenCalledOnce(); expect(uuid).toHaveBeenCalledOnce();
});
it('a definitive conflict also retires old callbacks and cannot allocate a replacement key', async () => {
  await ready(); vi.mocked(api.command).mockRejectedValue(new StaffAccountError(409, 'ACCOUNT_CONFLICT')); const revision = c.snapshot().revision, uuid = vi.spyOn(crypto, 'randomUUID');
  await invite(revision); await invite(revision); expect(c.snapshot().outcome).toBe('REJECTED'); expect(api.command).toHaveBeenCalledOnce(); expect(uuid).toHaveBeenCalledOnce();
});
it.each([[503, 'ACCOUNT_BUSY'], [429, 'ACCOUNT_RATE_LIMITED']] as const)('%s %s is a refused attempt with deliberate exact-key retry, never automatic submission', async (status, code) => {
  await ready(); vi.mocked(api.command).mockRejectedValueOnce(new StaffAccountError(status, code)).mockResolvedValueOnce(invitation);
  await invite(); expect(c.snapshot().outcome).toBe('REJECTED'); const original = vi.mocked(api.command).mock.calls[0]![0]; expect(api.command).toHaveBeenCalledOnce();
  await c.retry(c.snapshot().revision); expect(vi.mocked(api.command).mock.calls[1]![0]).toBe(original); expect(c.snapshot().outcome).toBe('SUCCESS');
});
it('UNKNOWN retains the exact original URL/body/key and requires explicit fresh authorization then retry', async () => {
  await ready(); vi.mocked(api.command).mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(invitation);
  await invite(); const original = vi.mocked(api.command).mock.calls[0]![0]; c.conceal(); expect(c.snapshot().receipt).toBeNull();
  await c.retry(c.snapshot().revision); expect(api.command).toHaveBeenCalledOnce(); await c.verify(scope); expect(api.command).toHaveBeenCalledOnce();
  await c.retry(c.snapshot().revision); expect(api.command).toHaveBeenCalledTimes(2); expect(vi.mocked(api.command).mock.calls[1]![0]).toBe(original); expect(c.snapshot().outcome).toBe('SUCCESS');
});
it('settles behind the privacy shield without requiring reload or automatically replaying', async () => {
  await ready(); let finish!: (v: typeof invitation) => void; vi.mocked(api.command).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  const task = invite(); await tick(); c.conceal(); finish(invitation); await task;
  expect(c.snapshot()).toMatchObject({ phase: 'CONCEALED', commandBusy: false, receipt: null }); await c.verify(scope);
  expect(c.snapshot().receipt).toEqual(invitation); expect(api.command).toHaveBeenCalledOnce();
});
it.each([[403, 'ACCOUNT_IDENTITY_CHANGED', 'IDENTITY'], [401, 'SIGN_IN_REQUIRED', 'SESSION'], [403, 'ACCOUNT_FORBIDDEN', 'CONCEALED']] as const)('post-command %s %s cannot expose a receipt or token; same-actor reauthorization permits only exact retry', async (status, code, phase) => {
  await ready(); let finish!: (v: typeof invitation) => void; vi.mocked(api.command).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  const task = invite(); await tick(); const original = vi.mocked(api.command).mock.calls[0]![0];
  vi.mocked(api.identity).mockRejectedValueOnce(new StaffAccountError(status, code)); finish(invitation); await task;
  expect(c.snapshot()).toMatchObject({ phase, receipt: null, outcome: 'UNKNOWN', pending: true, commandBusy: false }); expect(c.handoff(c.snapshot().revision)).toBeNull();
  expect(event).toHaveBeenCalledTimes(status === 401 ? 1 : 0); expect(api.command).toHaveBeenCalledOnce();
  await c.verify(scope); expect(c.snapshot().receipt).toBeNull(); expect(c.snapshot().outcome).toBe('UNKNOWN'); expect(api.command).toHaveBeenCalledOnce();
  await c.retry(c.snapshot().revision); expect(vi.mocked(api.command).mock.calls[1]![0]).toBe(original); expect(c.snapshot().receipt).toEqual(invitation);
});
it('an ignored-abort late post-command identity response cannot restore concealed data or lose the original request', async () => {
  await ready(); let finish!: () => void;
  vi.mocked(api.identity).mockResolvedValueOnce(undefined).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  const task = invite(); await tick(); const original = vi.mocked(api.command).mock.calls[0]![0]; c.conceal(); finish(); await task;
  expect(c.snapshot()).toMatchObject({ phase: 'CONCEALED', receipt: null, outcome: 'UNKNOWN', pending: true, commandBusy: false });
  await c.verify(scope); await c.retry(c.snapshot().revision); expect(vi.mocked(api.command).mock.calls[1]![0]).toBe(original);
});
it('an unmounted command never starts a post-command identity read or reveals a late result', async () => {
  await ready(); let finish!: (v: typeof invitation) => void; vi.mocked(api.command).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  const task = invite(); await tick(); const reads = vi.mocked(api.identity).mock.calls.length; c.dispose(); finish(invitation); await task;
  expect(api.identity).toHaveBeenCalledTimes(reads); expect(c.snapshot().receipt).toBeNull();
});
it('the preparatory identity read is aborted on unmount before any command can be dispatched', async () => {
  await ready(); let finish!: () => void; vi.mocked(api.identity).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  const task = invite(); await tick(); const signal = vi.mocked(api.identity).mock.calls.at(-1)![1]; c.dispose();
  expect(signal.aborted).toBe(true); finish(); await task; expect(api.command).not.toHaveBeenCalled(); expect(c.snapshot().receipt).toBeNull();
});
it('cannot discard while a command is unsettled; deliberate abandonment afterwards clears only local recovery', async () => {
  await ready(); let reject!: (e: Error) => void; vi.mocked(api.command).mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
  const task = invite(); await tick(); expect(c.abandon(c.snapshot().revision, true)).toBe(false); reject(Error('lost')); await task;
  expect(c.abandon(c.snapshot().revision, false)).toBe(false); expect(c.abandon(c.snapshot().revision, true)).toBe(true);
  expect(c.snapshot()).toMatchObject({ phase: 'IDLE', pending: false, role: null, receipt: null }); expect(api.command).toHaveBeenCalledOnce();
});
it('preserves unknown recovery across session invalidation and allows only explicit same-identity reauthorization', async () => {
  await ready(); vi.mocked(api.command).mockRejectedValueOnce(Error('lost')).mockRejectedValueOnce(new StaffAccountError(401, 'SIGN_IN_REQUIRED')).mockResolvedValueOnce(invitation);
  await invite(); const original = vi.mocked(api.command).mock.calls[0]![0]; await c.retry(c.snapshot().revision);
  expect(event).toHaveBeenCalledOnce(); expect(c.snapshot()).toMatchObject({ phase: 'SESSION', pending: true, receipt: null }); c.conceal(); expect(c.snapshot().phase).toBe('SESSION');
  await c.verify(scope); expect(api.command).toHaveBeenCalledTimes(2); await c.retry(c.snapshot().revision);
  expect(vi.mocked(api.command).mock.calls[2]![0]).toBe(original); expect(c.snapshot().outcome).toBe('SUCCESS');
});
it('403 stays local; no privacy contents return until a successful fresh authorized read', async () => {
  await ready(); vi.mocked(api.command).mockRejectedValue(new StaffAccountError(403, 'ACCOUNT_FORBIDDEN')); await invite();
  expect(event).not.toHaveBeenCalled(); expect(c.snapshot().receipt).toBeNull(); vi.mocked(api.list).mockRejectedValue(new StaffAccountError(403, 'ACCOUNT_FORBIDDEN'));
  await c.verify(scope); expect(c.snapshot()).toMatchObject({ phase: 'DENIED', items: [], receipt: null });
});
it('an old pending read cannot restore data after session invalidation even when its transport ignores abort', async () => {
  let finish!: (v: typeof invitation[]) => void; vi.mocked(api.list).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  const task = c.verify(scope); await tick(); const signal = vi.mocked(api.list).mock.calls[0]![1]; c.conceal('SESSION'); finish([invitation]); await task;
  expect(signal.aborted).toBe(true); expect(c.snapshot()).toMatchObject({ phase: 'SESSION', items: [], role: null, receipt: null });
});
it('an identity mismatch forbids restoring or retrying another actor’s unknown request', async () => {
  await ready(); vi.mocked(api.command).mockRejectedValue(Error('lost')); await invite(); c.conceal();
  vi.mocked(api.identity).mockRejectedValue(new StaffAccountError(403, 'ACCOUNT_IDENTITY_CHANGED')); await c.verify(scope); await c.retry(c.snapshot().revision);
  expect(c.snapshot().phase).toBe('IDENTITY'); expect(api.command).toHaveBeenCalledOnce();
});
it('school-context invalidation cannot transfer an original request to another school', async () => {
  await ready(); vi.mocked(api.command).mockRejectedValue(Error('lost')); await invite(); c.conceal('IDENTITY');
  await c.verify({ organizationId: id(8), schoolId: id(9) }); await c.retry(c.snapshot().revision); expect(api.command).toHaveBeenCalledOnce(); expect(c.snapshot().items).toEqual([]);
});
it('scope edits synchronously retire loaded role, invitations and retained confirmations', async () => {
  await ready(); const old = c.snapshot().revision; expect(c.changeScope(old)).toBe(true); await invite(old);
  expect(c.snapshot()).toMatchObject({ phase: 'IDLE', role: null, items: [] }); expect(api.command).not.toHaveBeenCalled();
});
it('changing the known role selector cannot reuse a previously loaded role or confirmation', async () => {
  await ready(); const old = c.snapshot().revision; c.retirePreparation(old, true); await invite(old); await invite(); expect(api.command).not.toHaveBeenCalled();
});
it('only current pending invitations can be explicitly revoked; accepted/expired records do not gain actions', async () => {
  await c.verify(scope); await c.revoke(id(90), c.snapshot().revision, true); await c.revoke(invitation.invitationId, c.snapshot().revision, false); expect(api.command).not.toHaveBeenCalled();
  vi.mocked(api.command).mockResolvedValue({ ...invitation, status: 'REVOKED' }); await c.revoke(invitation.invitationId, c.snapshot().revision, true);
  expect(JSON.parse(vi.mocked(api.command).mock.calls[0]![0].body)).toEqual({ schoolId: scope.schoolId, invitationId: invitation.invitationId });
});
it('acceptance is explicit, session-bound and cannot contain client role or organization authority', async () => {
  c.dispose(); c = new StaffInvitationController('new-staff', true, api); await c.verify(); expect(api.list).not.toHaveBeenCalled();
  vi.mocked(api.command).mockResolvedValue({ invitationId: invitation.invitationId, schoolId: scope.schoolId, roleId: role.id, accountStatus: 'STAFF_ROLE_BOUND', accessGranted: false, billingActivated: false, aiCreditsGranted: false });
  await c.accept(invitation.invitationId, token, c.snapshot().revision, false); expect(api.command).not.toHaveBeenCalled();
  await c.accept(invitation.invitationId, token, c.snapshot().revision, true);
  expect(JSON.parse(vi.mocked(api.command).mock.calls[0]![0].body)).toEqual({ invitationId: invitation.invitationId, token, confirmation: 'ACCEPT_SCHOOL_STAFF_INVITATION' });
});
it('mixed staff/parent review refusal is never converted into success or an automatic retry', async () => {
  c.dispose(); c = new StaffInvitationController('new-staff', true, api); await c.verify(); vi.mocked(api.command).mockRejectedValue(new StaffAccountError(409, 'ACCOUNT_REVIEW_REQUIRED'));
  await c.accept(invitation.invitationId, token, c.snapshot().revision, true); expect(c.snapshot()).toMatchObject({ outcome: 'REJECTED', receipt: null, errorCode: 'ACCOUNT_REVIEW_REQUIRED' });
  await c.retry(c.snapshot().revision); expect(api.command).toHaveBeenCalledOnce();
});
it('UNKNOWN followed by ACCOUNT_REVIEW_REQUIRED latches review without losing the original unresolved request or allowing a third POST', async () => {
  c.dispose(); c = new StaffInvitationController('new-staff', true, api); await c.verify();
  vi.mocked(api.command).mockRejectedValueOnce(Error('lost')).mockRejectedValueOnce(new StaffAccountError(409, 'ACCOUNT_REVIEW_REQUIRED'));
  await c.accept(invitation.invitationId, token, c.snapshot().revision, true); const original = vi.mocked(api.command).mock.calls[0]![0];
  await c.retry(c.snapshot().revision); expect(vi.mocked(api.command).mock.calls[1]![0]).toBe(original);
  expect(c.snapshot()).toMatchObject({ outcome: 'UNKNOWN', errorCode: 'ACCOUNT_REVIEW_REQUIRED', pending: true });
  await c.retry(c.snapshot().revision); c.conceal(); await c.verify(); await c.retry(c.snapshot().revision); expect(api.command).toHaveBeenCalledTimes(2);
  expect(c.snapshot()).toMatchObject({ outcome: 'UNKNOWN', errorCode: 'ACCOUNT_REVIEW_REQUIRED', receipt: null, pending: true });
  expect(c.abandon(c.snapshot().revision, true)).toBe(true); expect(c.snapshot().pending).toBe(false);
  await c.verify(); await c.accept(invitation.invitationId, token, c.snapshot().revision, true);
  await c.accept(id(88), 'b'.repeat(43), c.snapshot().revision, true);
  expect(c.hasAcceptanceReviewHold()).toBe(true); expect(api.command).toHaveBeenCalledTimes(2);
  expect(c.snapshot().errorCode).toBe('ACCOUNT_REVIEW_REQUIRED');
});
it('a command response after unmount cannot broadcast a 401 or restore private data', async () => {
  await ready(); let reject!: (e: Error) => void; vi.mocked(api.command).mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
  const task = invite(); await tick(); c.dispose(); reject(new StaffAccountError(401, 'SIGN_IN_REQUIRED')); await task; expect(event).not.toHaveBeenCalled(); expect(c.snapshot().receipt).toBeNull();
});
it('generates a 256-bit base64url token with the exact closed contract length', () => {
  const a = newStaffInvitationToken(), b = newStaffInvitationToken(); expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(b).not.toBe(a);
});
