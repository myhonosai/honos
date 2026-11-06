/** Browser-harness accounting only. Shared shell reads never establish family authority. */
import assert from 'node:assert/strict';

export function createFamilyReadAccounting(origin, { organizationId, schoolId }) {
  const familyPaths = new Set([
    `/api/v1/organizations/${organizationId}/schools/${schoolId}/families`,
    `/api/v1/school/schools/${schoolId}/family-access-invitations`,
  ]);
  const familyGets = [], unexpectedGets = [];
  let languageGets = 0, identityGets = 0;
  function observe(method, url) {
    if (method !== 'GET') return;
    const target = new URL(url, origin);
    if (!target.pathname.startsWith('/api/')) return;
    const exact = target.origin === origin && !target.search && !target.hash;
    if (exact && target.pathname === '/api/v1/me/language-preference') languageGets++;
    else if (exact && target.pathname === '/api/identity/me') identityGets++;
    else if (exact && familyPaths.has(target.pathname)) familyGets.push(target.pathname);
    else unexpectedGets.push({ path: target.pathname, sameOrigin: target.origin === origin, hasQuery: Boolean(target.search), hasFragment: Boolean(target.hash) });
  }
  function snapshot() { return { familyGets: [...familyGets], languageGets, identityGets, unexpectedGets: unexpectedGets.map(value => ({ ...value })) }; }
  function diagnostics(stage) { return `${stage}: ${JSON.stringify(snapshot())}`; }
  function assertAllowedGets(stage) { assert.equal(unexpectedGets.length, 0, `Unexpected API GET. ${diagnostics(stage)}`); }
  function assertDomainReads(expected, stage) {
    assertAllowedGets(stage);
    assert.equal(familyGets.length, expected, `Family/invitation GET count changed. ${diagnostics(stage)}`);
  }
  return { observe, snapshot, assertAllowedGets, assertDomainReads };
}
