import { afterEach, expect, it, vi } from 'vitest';
import { readLeadMemberships, leadMembershipScope, leadMembershipHref, leadMembershipPath, leadWorkflowHref, LeadMembershipReadError } from '../src/components/crm-lead-memberships-http';
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const scope = { organizationId: id(1), schoolId: id(2), leadId: id(3) };
export const item = (n = 7, state = 'ACTIVE') => ({ membershipId: id(n), studentProfileId: id(n + 20), origin: 'GUARDIAN_CHILD_REGISTRATION', state, version: 2, createdAt: '2026-10-23T12:00:00.000001Z' });
export const response = (memberships: unknown[] = [item()]) => new Response(JSON.stringify({ data: { leadId: scope.leadId, memberships, truncated: false }, meta: { requestId: id(8), correlationId: id(8) } }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());
it('uses the actual shared decoder and exact lead-scoped read without command fields or another lookup', async () => {
  const f = vi.fn().mockResolvedValue(response()); vi.stubGlobal('fetch', f); const s = signal();
  expect((await readLeadMemberships(scope, s)).memberships[0]!.membershipId).toBe(id(7));
  expect(f).toHaveBeenCalledExactlyOnceWith(leadMembershipPath(scope), { method: 'GET', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: s });
});
it.each([[401,'SESSION'],[403,'DENIED'],[404,'NOT_FOUND'],[409,'CONFLICT'],[503,'UNAVAILABLE'],[400,'INVALID']] as const)('keeps HTTP %i distinct, never empty or raw backend data', async (status, kind) => {
  const w = new EventTarget(); vi.stubGlobal('window', w); const invalidated = vi.fn(); w.addEventListener('hon:session-invalidated', invalidated);
  const r = new Response('private server detail', { status }); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(r));
  await expect(readLeadMemberships(scope, signal())).rejects.toMatchObject({ kind, status }); expect(r.bodyUsed).toBe(false);
  expect(invalidated).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
});
it('recognizes empty only from a valid authorized 200 result', async () => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([]))); expect((await readLeadMemberships(scope, signal())).memberships).toEqual([]); });
it.each(['wrong-lead','extra-field','duplicate','invalid-state','wrong-order','three-digit-instant','unknown-meta','missing-no-store','wrong-content-type'])('rejects %s rather than rendering membership facts', async bad => {
  const data = await response([item(), item(9)]).json(); const headers: Record<string,string> = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };
  if (bad === 'wrong-lead') data.data.leadId=id(99);
  if (bad === 'extra-field') data.data.memberships[0].payerId=id(10);
  if (bad === 'duplicate') data.data.memberships[1]=data.data.memberships[0];
  if (bad === 'invalid-state') data.data.memberships[0].state='PAID';
  if (bad === 'wrong-order') data.data.memberships[0].createdAt='2026-10-24T12:00:00.000001Z';
  if (bad === 'three-digit-instant') data.data.memberships[0].createdAt='2026-10-23T12:00:00.001Z';
  if (bad === 'unknown-meta') data.meta.secret='no';
  if (bad === 'missing-no-store') headers['Cache-Control']='private';
  if (bad === 'wrong-content-type') headers['Content-Type']='text/html';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { headers })));
  await expect(readLeadMemberships(scope, signal())).rejects.toMatchObject({ kind:'INVALID' });
});
it('preserves separate children and mixed lifecycle observations without merging or inferring benefits', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(['ACTIVE','CANCELLED','EXPIRED','DRAFT','FROZEN','CANCELLATION_PENDING'].map((state,index)=>item(index+10,state)))));
  expect((await readLeadMemberships(scope, signal())).memberships.map(x=>x.state)).toEqual(['ACTIVE','CANCELLED','EXPIRED','DRAFT','FROZEN','CANCELLATION_PENDING']);
});
it('never retries a failed read automatically', async () => { const f=vi.fn().mockRejectedValue(new TypeError('network'));vi.stubGlobal('fetch',f);await expect(readLeadMemberships(scope,signal())).rejects.toBeInstanceOf(LeadMembershipReadError);expect(f).toHaveBeenCalledTimes(1); });
it('closed navigation contains only lead/school selectors, not membership or student records', () => {
  expect(Object.isFrozen(leadMembershipScope(scope))).toBe(true);expect(leadMembershipHref(scope)).toBe(`/staff/crm/lead-memberships?${new URLSearchParams(scope)}`);expect(leadWorkflowHref(scope)).toBe(`/staff/crm/journey?${new URLSearchParams(scope)}`);
  expect(()=>leadMembershipScope({...scope,role:'OWNER'} as typeof scope)).toThrow();expect(()=>leadMembershipScope({...scope,leadId:'../../other'})).toThrow();
});
