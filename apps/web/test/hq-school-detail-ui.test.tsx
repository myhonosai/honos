import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validateHqSchoolDetail, type HqSchoolDetail } from '@hon/contracts';
import { SchoolDetailError, schoolDetailApi, schoolDetailId } from '../src/components/hq-school-detail/http';
import { HqSchoolDetailView, type SchoolDetailState } from '../src/components/hq-school-detail/view';
import { schoolDetailText } from '../src/components/hq-school-detail/copy';
import { hqPageLabel } from '../src/components/hq-modern/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';

const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-01T00:00:00.000Z', END = '2026-12-01T00:00:00.000Z';
const zero = { pending: 0, expired: 0, accepted: 0, revoked: 0, ended: 0 };
function raw(owner = true, patch: Partial<Record<string, unknown>> = {}) {
  return { school: { schoolId: id(1), schoolDisplayName: 'Synthetic Academy', slug: 'synthetic-academy', timezone: 'America/Chicago', schoolStatus: 'ACTIVE', createdAt: T },
    organization: { organizationId: id(2), organizationDisplayName: 'Synthetic Dojo', organizationStatus: 'ACTIVE', createdAt: T,
      schools: [{ schoolId: id(1), schoolDisplayName: 'Synthetic Academy', schoolStatus: 'ACTIVE' }], schoolCount: 1,
      entitlement: { tier: 'COMPLETE', status: 'SUSPENDED', effectiveFrom: T, effectiveUntil: null, version: 1, inEffect: false },
      accessState: 'PROVISIONED', accessStatus: 'NO_ACCESS', currentException: null, subscription: null, openCheckout: false,
      ownerOnboarding: { status: 'PENDING', invitedAt: T, expiresAt: END, acceptedAt: null },
      exceptionGrant: { eligible: true, blockers: [], expectedEntitlementVersion: 1 } },
    exceptionPolicyReady: true,
    ownership: { ownerCount: 2, primaryOwnerGrantId: null, primaryNeeded: true, hqSeatCount: 1 },
    invitations: { owner: { ...zero, pending: 3 }, staff: { ...zero, expired: 4 }, family: { ...zero, ended: 5 } },
    people: { staffWithAccess: 7, familyMembersWithAccess: 8, activeStudents: 9 },
    viewer: { canGrantAndRevokeExceptions: owner, canManageOwnership: owner }, asOf: END, ...patch };
}
const detail = (r = raw()): HqSchoolDetail => validateHqSchoolDetail(r);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const render = (state: SchoolDetailState, extra: Partial<{ concealed: boolean; language: string }> = {}) => renderToStaticMarkup(
  <HqSchoolDetailView language={extra.language ?? 'en'} formattingLocale="en-US" concealed={extra.concealed ?? false} state={state} busy={false} onRefresh={() => {}} onReveal={() => {}}/>);

it('reads one school by a validated id with a plain same-origin GET and no query', async () => {
  const f = stub(json({ data: raw() }));
  const v = await schoolDetailApi.read(id(1).toUpperCase(), new AbortController().signal, yes);
  expect(v.school.schoolId).toBe(id(1));
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/hq/saas/schools/${id(1)}`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
  expect(init.body).toBeUndefined();
  expect(Object.keys(init.headers as object)).toEqual(['Accept']);
  for (const bad of ['', 'nope', '../x', `${id(1)}?a=1`]) {
    expect(schoolDetailId(bad)).toBeNull();
    await expect(schoolDetailApi.read(bad, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  }
  expect(f).toHaveBeenCalledTimes(1);
});

it('maps refusals exactly and never shows a drifted or mismatched answer', async () => {
  const cases: [Response, string][] = [[json({ code: 'SAAS_FORBIDDEN' }, 403), 'DENIED'], [json({ code: 'SAAS_UNAVAILABLE' }, 404), 'GONE'],
    [json({ code: 'INVALID_SAAS_INPUT' }, 400), 'INVALID'], [json({ code: 'SAAS_UNAVAILABLE' }, 503), 'UNKNOWN'],
    [json({ data: { ...raw(), people: { ...raw().people, emails: [] } } }), 'UNKNOWN'],
    [json({ data: raw(), extra: 1 }), 'UNKNOWN'],
    [json({ data: { ...raw(), school: { ...raw().school, schoolId: id(3) }, organization: { ...raw().organization, schools: [{ schoolId: id(3), schoolDisplayName: 'Other', schoolStatus: 'ACTIVE' }] } } }), 'UNKNOWN'],
    [new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }), 'UNKNOWN']];
  for (const [answer, kind] of cases) {
    stub(answer);
    await expect(schoolDetailApi.read(id(1), new AbortController().signal, yes)).rejects.toMatchObject({ kind });
  }
  // 401 ends the session only for a read the caller still stands behind.
  const ended = vi.fn(); (window as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, ended);
  stub(json({}, 401)); await expect(schoolDetailApi.read(id(1), new AbortController().signal, () => false)).rejects.toBeInstanceOf(SchoolDetailError);
  expect(ended).not.toHaveBeenCalled();
  stub(json({}, 401)); await expect(schoolDetailApi.read(id(1), new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'SESSION' });
  expect(ended).toHaveBeenCalledTimes(1);
});

it('shows the school, access, owners with HQ seats apart, invitation and people counts, and links onward', () => {
  const html = render({ state: 'READY', view: detail() });
  for (const text of ['Synthetic Academy', 'synthetic-academy', 'America/Chicago', 'Synthetic Dojo', 'No access', 'COMPLETE · not in effect', 'Invitation pending',
    '1 HQ seat(s), not counted as school owners', 'This school needs a primary owner', 'Staff with access', '>7<', '>8<', '>9<', '>3<', '>4<', '>5<'])
    expect(html, text).toContain(text);
  for (const href of ['/hq/schools', '/hq/schools/access', '/hq/schools/owners', '/hq/school-owner-invitations']) expect(html).toContain(`href="${href}"`);
  expect(html).not.toContain(schoolDetailText('en', 'viewerOperator'));
  // An operator reads the same facts but is told who decides.
  expect(render({ state: 'READY', view: detail(raw(false)) })).toContain(schoolDetailText('en', 'viewerOperator'));
  // Policy not approved: the reason is shown with the blocker.
  const unready = raw(true, { exceptionPolicyReady: false });
  (unready.organization as { exceptionGrant: unknown }).exceptionGrant = { eligible: false, blockers: ['EXCEPTION_POLICY_REQUIRED'], expectedEntitlementVersion: 1 };
  const u = render({ state: 'READY', view: detail(unready) });
  expect(u).toContain(schoolDetailText('en', 'policyMissing')); expect(u).toContain('the exception policy is not approved');
  // Korean and Spanish labels exist for every key.
  expect(render({ state: 'READY', view: detail() }, { language: 'ko' })).toContain('도장 소유자');
  expect(render({ state: 'READY', view: detail() }, { language: 'es' })).toContain('Dueños de la escuela');
});

it('shows nothing private while loading, refused, gone or concealed', () => {
  for (const [state, key] of [['LOADING', 'loading'], ['DENIED', 'denied'], ['GONE', 'gone'], ['INVALID', 'invalid'], ['UNAVAILABLE', 'unavailable']] as const) {
    const html = render({ state } as SchoolDetailState);
    expect(html).toContain(schoolDetailText('en', key)); expect(html).not.toContain('Synthetic');
  }
  const hidden = render({ state: 'READY', view: detail() }, { concealed: true });
  expect(hidden).toContain(schoolDetailText('en', 'concealed')); expect(hidden).not.toContain('Synthetic');
});

it('route, label, manifest and directory link are wired; the client has no storage or command path', () => {
  const route = readFileSync('src/app/hq/schools/[schoolId]/page.tsx', 'utf8');
  expect(route).toContain("'force-dynamic'"); expect(route).toContain('index: false'); expect(route).not.toMatch(/fetch\(|process\.env/);
  expect(hqPageLabel(`/hq/schools/${id(1)}`)).toBe('School detail');
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((r: { path: string }) => r.path === '/hq/schools/:schoolId')).toHaveLength(1);
  expect(readFileSync('src/components/hq-school-directory.tsx', 'utf8')).toContain('href={`/hq/schools/${encodeURIComponent(school.schoolId)}`}');
  for (const file of ['http.ts', 'view.tsx', 'hq-school-detail.tsx']) {
    const source = readFileSync(`src/components/hq-school-detail/${file}`, 'utf8');
    expect(source).not.toMatch(/localStorage|sessionStorage|dangerouslySetInnerHTML|method: 'POST'|Idempotency-Key/);
  }
});
