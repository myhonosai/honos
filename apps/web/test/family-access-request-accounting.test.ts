import { afterEach, expect, it, vi } from 'vitest';
import { createFamilyReadAccounting } from '../scripts/family-access-request-accounting.mjs';
import { loadMyLanguage } from '../src/components/localization/http';
const origin = 'http://127.0.0.1:3000', scope = { organizationId: '00000000-0000-4000-8000-000000000001', schoolId: '00000000-0000-4000-8000-000000000002' };
const familyPath = `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/families`;
const invitationPath = `/api/v1/school/schools/${scope.schoolId}/family-access-invitations`;
afterEach(() => vi.restoreAllMocks());

it('accounts for the actual LocaleProvider transport GET without treating it as family authority or a family read', async () => {
  const reads = createFamilyReadAccounting(origin, scope);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    reads.observe(init!.method!, String(url));
    return Response.json({ code: 'UNAVAILABLE' }, { status: 503 });
  });
  await expect(loadMyLanguage()).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
  reads.observe('GET', origin + '/api/identity/me');
  expect(reads.snapshot()).toEqual({ familyGets: [], languageGets: 1, identityGets: 1, shellIdentityGets: 0, shellGets: 0, unexpectedGets: [] });
  expect(() => reads.assertDomainReads(0, 'inert prefill')).not.toThrow();
});
it('sets aside only the school shell\'s own exact GETs, never a family read', () => {
  const reads = createFamilyReadAccounting(origin, scope);
  for (const path of ['/api/v1/staff/current-reporting-school', '/api/v1/staff/reporting-schools',
    `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/reports/operations`,
    `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/interface-theme`]) reads.observe('GET', origin + path);
  reads.observe('POST', origin + `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/interface-theme`);
  expect(reads.snapshot()).toMatchObject({ familyGets: [], shellGets: 4, unexpectedGets: [] });
  expect(() => reads.assertDomainReads(0, 'shell')).not.toThrow();
  reads.observe('GET', origin + '/api/v1/staff/reporting-schools?schoolId=' + scope.schoolId);
  expect(() => reads.assertDomainReads(0, 'shell query')).toThrow(/Unexpected API GET/);
});
it('attributes one identity read to each school shell entry and counts any further identity read as the page\'s own', () => {
  const reads = createFamilyReadAccounting(origin, scope);
  reads.observe('GET', origin + '/api/identity/me');
  reads.observe('GET', origin + '/api/v1/staff/current-reporting-school');
  expect(reads.snapshot()).toMatchObject({ identityGets: 0, shellIdentityGets: 1, shellGets: 1 });
  reads.observe('GET', origin + '/api/identity/me');
  expect(reads.snapshot()).toMatchObject({ identityGets: 1, shellIdentityGets: 1 });
});
it.each([familyPath, invitationPath])('still rejects an automatic family-domain GET before explicit verification: %s', path => {
  const reads = createFamilyReadAccounting(origin, scope);
  reads.observe('GET', origin + '/api/v1/me/language-preference');
  reads.observe('GET', origin + path);
  expect(() => reads.assertDomainReads(0, 'inert prefill')).toThrow(/Family\/invitation GET count changed.*inert prefill/);
});
it.each([
  '/api/v1/me/language',
  '/api/v1/me/language-preference-extra',
  '/api/v1/me/language-preference?schoolId=' + scope.schoolId,
  '/api/identity/me?schoolId=' + scope.schoolId,
  invitationPath.replace(scope.schoolId, scope.organizationId),
  '/api/v1/schools/' + scope.schoolId + '/language-default',
  '/api/v1/unexpected',
])('rejects an unexpected GET instead of allowing broad shared/domain route prefixes: %s', path => {
  const reads = createFamilyReadAccounting(origin, scope);
  reads.observe('GET', origin + path);
  expect(() => reads.assertDomainReads(0, 'known-reference restore')).toThrow(/Unexpected API GET.*known-reference restore/);
});
it('allows only unchanged domain counts through known-reference identity verification and fails a new domain read with its stage', () => {
  const reads = createFamilyReadAccounting(origin, scope);
  reads.observe('GET', origin + familyPath); reads.observe('GET', origin + invitationPath);
  reads.assertAllowedGets('explicit denied record read');
  const baseline = reads.snapshot().familyGets.length;
  reads.observe('GET', origin + '/api/identity/me'); reads.observe('GET', origin + '/api/v1/me/language-preference');
  expect(() => reads.assertDomainReads(baseline, 'exact revoke retry')).not.toThrow();
  reads.observe('GET', origin + invitationPath);
  expect(() => reads.assertDomainReads(baseline, 'concealed end restore')).toThrow(/Family\/invitation GET count changed.*concealed end restore/);
});
it('rejects another origin and query-bearing family reads without leaking query values in diagnostics', () => {
  const reads = createFamilyReadAccounting(origin, scope);
  reads.observe('GET', 'http://127.0.0.1:3001' + invitationPath);
  reads.observe('GET', origin + familyPath + '?private=DO_NOT_LOG');
  expect(reads.snapshot().unexpectedGets).toHaveLength(2);
  expect(() => reads.assertAllowedGets('restore')).toThrow(/"sameOrigin":false/);
  expect(JSON.stringify(reads.snapshot())).not.toContain('DO_NOT_LOG');
});
