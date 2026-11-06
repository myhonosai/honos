import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountStatusController } from '../src/components/account-status/controller';
import { AccountStatusError, type AccountStatusApi } from '../src/components/account-status/http';
import { id, scope, rawAccount, rawStanding, rawWallet } from './account-status-fixtures';
let api: AccountStatusApi, c: AccountStatusController;
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
beforeEach(() => {
  api = { identity: vi.fn().mockResolvedValue(undefined), account: vi.fn().mockResolvedValue(rawAccount(true)), standing: vi.fn().mockResolvedValue(rawStanding()),
    wallet: vi.fn().mockResolvedValue({ ...rawWallet(), programStatus: 'INACTIVE' }) };
  c = new AccountStatusController('original-owner', api);
});
afterEach(() => c.dispose());
it('stays idle until an explicit read and supports an exact school-only suspended billing read', async () => {
  expect(c.snapshot()).toMatchObject({ phase: 'IDLE', scope: null, account: { data: null }, wallet: { data: null } }); expect(api.identity).not.toHaveBeenCalled();
  await c.loadBilling({ schoolId: scope.schoolId }, c.snapshot().revision);
  expect(c.snapshot()).toMatchObject({ phase: 'OPEN', scope: { schoolId: scope.schoolId }, account: { phase: 'READY', data: { organizationId: scope.organizationId } }, standing: { phase: 'READY' }, wallet: { phase: 'IDLE' } });
  expect(api.account).toHaveBeenCalledWith({ schoolId: scope.schoolId }, expect.any(AbortSignal)); expect(api.identity).toHaveBeenCalledTimes(4); expect(api.wallet).not.toHaveBeenCalled();
});
it('retains billing standing when the separately requested creative wallet returns 403', async () => {
  await c.loadBilling(scope, c.snapshot().revision); vi.mocked(api.wallet).mockRejectedValue(new AccountStatusError('DENIED'));
  await c.loadWallet(scope, c.snapshot().revision);
  expect(c.snapshot()).toMatchObject({ phase: 'OPEN', account: { phase: 'READY' }, standing: { phase: 'READY' }, wallet: { phase: 'DENIED', data: null } }); expect(api.identity).toHaveBeenCalledTimes(6);
});
it.each(['DENIED', 'UNAVAILABLE'] as const)('a standing %s settles independently of an authorized account', async kind => {
  vi.mocked(api.standing).mockRejectedValue(new AccountStatusError(kind)); await c.loadBilling(scope, c.snapshot().revision);
  expect(c.snapshot()).toMatchObject({ account: { phase: 'READY' }, standing: { phase: kind, data: null } });
});
it('does not use payment, reporting, wallet eligibility or a displayed organization as read authority', async () => {
  await c.loadWallet({ schoolId: scope.schoolId }, c.snapshot().revision);
  expect(api.account).not.toHaveBeenCalled(); expect(api.standing).not.toHaveBeenCalled(); expect(c.snapshot().wallet.phase).toBe('READY'); expect(c.snapshot().account.data).toBeNull();
});
it('an identity switch during a denied wallet read conceals previously verified billing facts', async () => {
  await c.loadBilling(scope, c.snapshot().revision);
  vi.mocked(api.wallet).mockRejectedValue(new AccountStatusError('DENIED'));
  vi.mocked(api.identity).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new AccountStatusError('IDENTITY'));
  await c.loadWallet(scope, c.snapshot().revision);
  expect(c.snapshot()).toMatchObject({ phase: 'IDENTITY', scope: null, account: { data: null }, standing: { data: null }, wallet: { data: null } });
});
it('an unavailable post-read identity check hides all prior facts rather than preserving a successful card', async () => {
  await c.loadBilling(scope, c.snapshot().revision);
  vi.mocked(api.identity).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new AccountStatusError('UNAVAILABLE'));
  await c.loadWallet(scope, c.snapshot().revision); expect(c.snapshot()).toMatchObject({ phase: 'UNAVAILABLE', account: { data: null }, standing: { data: null }, wallet: { data: null } });
});
it('contradictory authoritative organizations from the same school clear both billing cards', async () => {
  vi.mocked(api.standing).mockResolvedValue({ ...rawStanding(), organizationId: id(99) });
  await c.loadBilling({ schoolId: scope.schoolId }, c.snapshot().revision);
  expect(c.snapshot()).toMatchObject({ account: { phase: 'UNAVAILABLE', data: null }, standing: { phase: 'UNAVAILABLE', data: null } });
});
it.each(['SESSION', 'IDENTITY'] as const)('%s remains terminal across privacy events and cannot restore this mount', async kind => {
  vi.mocked(api.identity).mockRejectedValueOnce(new AccountStatusError(kind)); await c.loadWallet(scope, c.snapshot().revision);
  const calls = vi.mocked(api.identity).mock.calls.length; c.conceal(); c.dispose(); c.activate();
  await c.restore(c.snapshot().revision); await c.loadBilling(scope, c.snapshot().revision);
  expect(c.snapshot().phase).toBe(kind); expect(api.identity).toHaveBeenCalledTimes(calls); expect(api.account).not.toHaveBeenCalled();
});
it('concealment aborts all pending reads, clears every card and rejects late success', async () => {
  let finish!: (value: ReturnType<typeof rawAccount>) => void; vi.mocked(api.account).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const read = c.loadBilling(scope, c.snapshot().revision); await tick(); const signal = vi.mocked(api.account).mock.calls[0]![1]; c.conceal();
  expect(signal.aborted).toBe(true); finish(rawAccount()); await read;
  expect(c.snapshot()).toMatchObject({ phase: 'CONCEALED', scope: null, account: { data: null }, standing: { data: null }, wallet: { data: null } });
});
it('explicit privacy restoration checks only identity and never refetches billing or wallet automatically', async () => {
  await c.loadBilling(scope, c.snapshot().revision); c.conceal(); const accountCalls = vi.mocked(api.account).mock.calls.length;
  await c.restore(c.snapshot().revision); expect(c.snapshot()).toMatchObject({ phase: 'IDLE', scope: null, account: { data: null }, standing: { data: null }, wallet: { data: null } });
  expect(api.account).toHaveBeenCalledTimes(accountCalls); expect(api.wallet).not.toHaveBeenCalled(); expect(api.identity).toHaveBeenCalledTimes(5);
});
it('selector edits retire old reads and handlers before any different-school read', async () => {
  let finish!: (value: ReturnType<typeof rawAccount>) => void; vi.mocked(api.account).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const revision = c.snapshot().revision, read = c.loadBilling(scope, revision); await tick(); expect(c.changeScope(c.snapshot().revision)).toBe(true);
  await c.loadWallet(scope, revision); expect(api.wallet).not.toHaveBeenCalled(); finish(rawAccount()); await read; expect(c.snapshot().account.data).toBeNull();
  const other = { organizationId: id(3), schoolId: id(4) }; vi.mocked(api.account).mockResolvedValue({ ...rawAccount(), ...other }); vi.mocked(api.standing).mockResolvedValue({ ...rawStanding(), ...other });
  await c.loadBilling(other, c.snapshot().revision); expect(c.snapshot().account.data?.schoolId).toBe(other.schoolId);
});
it('invalid school or optional organization selectors never dispatch identity or domain reads', async () => {
  for (const input of [{ schoolId: 'bad' }, { schoolId: scope.schoolId, organizationId: 'bad' }]) await c.loadBilling(input, c.snapshot().revision);
  expect(c.snapshot().inputError).toBe(true); expect(api.identity).not.toHaveBeenCalled(); expect(api.account).not.toHaveBeenCalled();
});
