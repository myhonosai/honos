// Fixed test identities for the private owner test environment.
//
// These are sign-in identities ONLY. Signing in proves which test person is at the keyboard; it
// grants nothing. HQ and school authority come exclusively from HON's own IAM tables:
//   - hq-owner receives the HON_HQ_OWNER grant from the repository's existing bootstrap script;
//   - school owners become OWNER only by accepting an HQ-issued invitation through the real UI;
//   - the unprovisioned visitor is never granted anything and demonstrates denial.
// Subjects are stable so that IAM bindings survive restarts. Emails use the reserved .invalid TLD
// so nothing can ever be delivered to a real mailbox.
export const TEST_IDENTITIES = Object.freeze([
  Object.freeze({ key: 'hq-owner', sub: 'hon-testenv-hq-owner', name: 'HQ Owner (test)', email: 'hq-owner@hon-testenv.invalid', role: 'HON OS HQ platform owner. Bootstrapped with the HON_HQ_OWNER grant.' }),
  Object.freeze({ key: 'school-owner-a', sub: 'hon-testenv-school-owner-a', name: 'School A Owner (test)', email: 'school-a-owner@hon-testenv.invalid', role: 'Martial arts school owner. Gains access only after accepting an HQ invitation for this email.' }),
  Object.freeze({ key: 'school-owner-b', sub: 'hon-testenv-school-owner-b', name: 'School B Owner (test)', email: 'school-b-owner@hon-testenv.invalid', role: 'Second school owner, for checking that schools cannot see each other.' }),
  Object.freeze({ key: 'unprovisioned', sub: 'hon-testenv-unprovisioned', name: 'Unprovisioned visitor (test)', email: 'visitor@hon-testenv.invalid', role: 'Signed in but never granted anything. Every HQ and school page should deny access.' }),
]);

export function identityByKey(key) {
  return TEST_IDENTITIES.find((identity) => identity.key === key);
}

// Same derivation as packages/auth/src/oidc.ts verifyIdToken().
export function honExternalSubject(issuer, sub) {
  return `oidc:${encodeURIComponent(issuer)}:${encodeURIComponent(sub)}`;
}
