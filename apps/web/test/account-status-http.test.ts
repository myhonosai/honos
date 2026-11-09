import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { accountStatusApi } from '../src/components/account-status/http';
import { parseAccountSelectors } from '../src/components/account-status/selectors';
import { id, scope, rawAccount, rawStanding, rawWallet, reply } from './account-status-fixtures';
const signal = () => new AbortController().signal;
let invalidated: ReturnType<typeof vi.fn>;
beforeEach(() => { invalidated = vi.fn(); const w = new EventTarget(); w.addEventListener('hon:session-invalidated', invalidated); vi.stubGlobal('window', w); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('uses only fixed GET paths with native same-origin options, actual closed validators and a minimal retained projection', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(rawAccount(true)));
  const account = await accountStatusApi.account({ schoolId: scope.schoolId }, signal()); expect(account.entitlement?.status).toBe('SUSPENDED'); expect(account.organizationId).toBe(scope.organizationId);
  for (const key of ['allowance', 'refunds', 'subscriptions', 'subscriptionHistory', 'cardDataStored']) expect(account).not.toHaveProperty(key);
  f.mockResolvedValue(reply(rawStanding())); await accountStatusApi.standing(scope, signal());
  f.mockResolvedValue(reply(rawWallet())); const wallet = await accountStatusApi.wallet(scope, signal());
  for (const key of ['packages', 'purchases', 'rates', 'lots', 'history', 'monthlyIncludedCredits']) expect(wallet).not.toHaveProperty(key);
  expect(wallet).not.toHaveProperty('organizationId'); expect(wallet.balance.availableCredits).toBe(0);
  expect(f.mock.calls.map(([path]) => path)).toEqual([`/api/v1/schools/${scope.schoolId}/hon-billing`, `/api/v1/schools/${scope.schoolId}/hon-billing/access-standing`, `/api/v1/schools/${scope.schoolId}/creative-credits`]);
  for (const [, options] of f.mock.calls) expect(options).toEqual({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal) });
});
it('binds both billing responses to the exact school and checks an optional organization without requiring it', async () => {
  const f = vi.spyOn(globalThis, 'fetch');
  for (const [method, raw] of [['account', rawAccount()], ['standing', rawStanding()]] as const) {
    f.mockResolvedValue(reply(raw)); await expect(accountStatusApi[method]({ schoolId: scope.schoolId }, signal())).resolves.toHaveProperty('organizationId', scope.organizationId);
    await expect(accountStatusApi[method]({ ...scope, organizationId: id(99) }, signal())).rejects.toThrow();
    f.mockResolvedValue(reply({ ...raw, schoolId: id(99) })); await expect(accountStatusApi[method](scope, signal())).rejects.toThrow();
    f.mockResolvedValue(reply({ ...raw, organizationId: id(99) })); await expect(accountStatusApi[method](scope, signal())).rejects.toThrow();
  }
  f.mockResolvedValue(reply({ ...rawWallet(), schoolId: id(99) })); await expect(accountStatusApi.wallet(scope, signal())).rejects.toThrow();
});
it('validates entire canonical responses before projecting unused commercial fields away', async () => {
  const f = vi.spyOn(globalThis, 'fetch');
  for (const bad of [{ ...rawAccount(), refunds: [{ privateNote: 'not allowed' }] }, { ...rawAccount(), entitlement: { ...rawAccount().entitlement, inEffect: true, status: 'SUSPENDED' } }]) {
    f.mockResolvedValue(reply(bad)); await expect(accountStatusApi.account(scope, signal())).rejects.toThrow();
  }
  for (const bad of [{ ...rawWallet(), agentConversationsDeductCredits: true }, { ...rawWallet(), paymentsActive: true }, { ...rawWallet(), providerExpense: {} }, { ...rawWallet(), balance: { ...rawWallet().balance, availableCredits: 12000 } }]) {
    f.mockResolvedValue(reply(bad)); await expect(accountStatusApi.wallet(scope, signal())).rejects.toThrow();
  }
  f.mockResolvedValue(Response.json({ data: rawAccount(), meta: {} }, { headers: { 'Cache-Control': 'no-store' } })); await expect(accountStatusApi.account(scope, signal())).rejects.toThrow();
});
it.each([401, 403, 404, 422, 429, 503])('HTTP %i remains unavailable/denied rather than an empty or zero-valued card', async status => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({}, status)); await expect(accountStatusApi.wallet(scope, signal())).rejects.toThrow(); expect(invalidated).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
});
it('aborts before dispatch and ignores a retired late 401 before broadcasting into a replacement session', async () => {
  const abort = new AbortController(); let finish!: (response: Response) => void;
  const f = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const read = accountStatusApi.wallet(scope, abort.signal); abort.abort(); finish(reply({}, 401)); await expect(read).rejects.toThrow(); expect(invalidated).not.toHaveBeenCalled();
  await expect(accountStatusApi.account(scope, abort.signal)).rejects.toThrow(); expect(f).toHaveBeenCalledOnce();
});
it('rejects oversized/malformed streams, redirects, missing no-store and mismatched response URLs', async () => {
  const f = vi.spyOn(globalThis, 'fetch'); const redirected = reply(rawAccount()); Object.defineProperty(redirected, 'redirected', { value: true });
  const wrongUrl = reply(rawAccount()); Object.defineProperty(wrongUrl, 'url', { value: 'https://foreign.invalid/api' });
  for (const response of [redirected, wrongUrl, Response.json({ data: rawAccount() }), new Response('{bad', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }), new Response(' '.repeat(524289), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })]) {
    f.mockResolvedValue(response); await expect(accountStatusApi.account(scope, signal())).rejects.toThrow();
  }
});
it('accepts inert school-only navigation or a checked pair while rejecting duplicate, extra and organization-only selectors', () => {
  const f = vi.spyOn(globalThis, 'fetch'); expect(parseAccountSelectors({ schoolId: scope.schoolId })).toEqual({ initialSchoolId: scope.schoolId });
  expect(parseAccountSelectors(scope)).toEqual({ initialSchoolId: scope.schoolId, initialOrganizationId: scope.organizationId });
  for (const query of [null, [], {}, { organizationId: scope.organizationId }, { schoolId: [scope.schoolId] }, { ...scope, organizationId: [scope.organizationId] }, { ...scope, token: 'x' }, { schoolId: 'school' }, { ...scope, organizationId: ' ' }]) expect(parseAccountSelectors(query)).toEqual({});
  expect(f).not.toHaveBeenCalled();
});
