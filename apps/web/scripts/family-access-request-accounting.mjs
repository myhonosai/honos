/** Browser-harness accounting only. Shared shell reads never establish family authority. */
import assert from 'node:assert/strict';
import { isSchoolShellRead } from './school-shell-reads.mjs';

export function createFamilyReadAccounting(origin, { organizationId, schoolId }) {
  const familyPaths = new Set([
    `/api/v1/organizations/${organizationId}/schools/${schoolId}/families`,
    `/api/v1/school/schools/${schoolId}/family-access-invitations`,
  ]);
  const familyGets = [], unexpectedGets = [];
  // The school shell's entry is strictly sequential: identity, then its entry read (the
  // current school, or the exact-school verification for a URL prefill), then identity
  // again right after the verification. Only identity reads in exactly those positions are
  // the shell's; every other identity read is the page's own.
  const SHELL_VERIFY = /^\/api\/v1\/organizations\/[^/]+\/schools\/[^/]+\/reports\/operations$/;
  let languageGets = 0, rawIdentityGets = 0, shellGets = 0, shellIdentityGets = 0, identityAwaitingEntry = false, shellAwaitingIdentity = false, afterCurrentSchool = false;
  function observe(method, url) {
    if (method !== 'GET') return;
    const target = new URL(url, origin);
    if (!target.pathname.startsWith('/api/')) return;
    const exact = target.origin === origin && !target.search && !target.hash;
    if (exact && isSchoolShellRead(method, target.pathname)) {
      shellGets++;
      const entry = target.pathname === '/api/v1/staff/current-reporting-school', verify = SHELL_VERIFY.test(target.pathname);
      if ((entry || verify) && identityAwaitingEntry) { shellIdentityGets++; identityAwaitingEntry = false; }
      // Without a current school the shell lists the choices next and then closes with identity.
      if (verify || (afterCurrentSchool && target.pathname === '/api/v1/staff/reporting-schools')) shellAwaitingIdentity = true;
      afterCurrentSchool = entry; return;
    }
    if (exact && target.pathname === '/api/v1/me/language-preference') { languageGets++; return; }
    afterCurrentSchool = false;
    if (exact && target.pathname === '/api/identity/me') {
      rawIdentityGets++;
      if (shellAwaitingIdentity) { shellIdentityGets++; shellAwaitingIdentity = false; } else identityAwaitingEntry = true;
    }
    else if (exact && familyPaths.has(target.pathname)) familyGets.push(target.pathname);
    else unexpectedGets.push({ path: target.pathname, sameOrigin: target.origin === origin, hasQuery: Boolean(target.search), hasFragment: Boolean(target.hash) });
  }
  function snapshot() {
    return { familyGets: [...familyGets], languageGets, identityGets: rawIdentityGets - shellIdentityGets, shellIdentityGets, shellGets, unexpectedGets: unexpectedGets.map(value => ({ ...value })) }; }
  function diagnostics(stage) { return `${stage}: ${JSON.stringify(snapshot())}`; }
  function assertAllowedGets(stage) { assert.equal(unexpectedGets.length, 0, `Unexpected API GET. ${diagnostics(stage)}`); }
  function assertDomainReads(expected, stage) {
    assertAllowedGets(stage);
    assert.equal(familyGets.length, expected, `Family/invitation GET count changed. ${diagnostics(stage)}`);
  }
  return { observe, snapshot, assertAllowedGets, assertDomainReads };
}
