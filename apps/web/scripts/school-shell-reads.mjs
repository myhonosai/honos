/**
 * Browser-harness helper. The school app shell (U1) reads the current school, the named
 * school choices, the exact-school verification report and the personal view preference
 * on every /staff page. These are GETs the shell makes for itself; a page harness that
 * accounts for its own domain reads can recognise and set them aside. Never authority.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const SHELL_READS = [
  /^\/(?:api\/)?v1\/staff\/current-reporting-school$/,
  /^\/(?:api\/)?v1\/staff\/reporting-schools$/,
  new RegExp(`^/(?:api/)?v1/organizations/${UUID}/schools/${UUID}/reports/operations$`, 'i'),
  new RegExp(`^/(?:api/)?v1/organizations/${UUID}/schools/${UUID}/interface-theme$`, 'i'),
];

export function isSchoolShellRead(method, pathname) {
  return method === 'GET' && SHELL_READS.some(pattern => pattern.test(pathname));
}
