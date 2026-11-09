import assert from 'node:assert/strict';
import { isAbsolute, normalize } from 'node:path';

/** Run before importing database/auth clients or issuing a session. No local opt-in. */
export function requireOwnerWorkflowRun(env, sourceSha) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Requires the disposable hosted runner.');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted', 'Requires the disposable hosted runner.');
  assert.equal(env.HON_OWNER_WORKFLOW_TEST, '1', 'Explicit native workflow test opt-in required.');
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(env.HON_OWNER_WORKFLOW_SHA, sourceSha, 'Checkout must equal the requested evidence head.');
  for (const name of ['HON_AUTH_MODE', 'HON_DEV_SUBJECT', 'HON_SESSION_AUDIENCE', 'HON_SESSION_JWT_SECRET', 'HON_PUBLIC_ORIGIN', 'HON_API_BASE_URL']) {
    assert(env[name] === undefined, 'Inherited auth/origin configuration is refused.');
  }
  const paths = {};
  for (const name of ['TOOLS', 'CHROME', 'RESULTS']) {
    const value = env[`HON_OWNER_WORKFLOW_${name}`];
    assert(typeof value === 'string' && isAbsolute(value) && normalize(value) === value && value !== '/', 'Absolute normalized tool/artifact paths required.');
    paths[name.toLowerCase()] = value;
  }
  assert.notEqual(paths.results, paths.tools, 'Artifacts and installed tools must be separate.');
  return Object.freeze({ ...paths, sourceSha });
}

/** Observe the unmodified browser/proxy transport; never retain a session or arbitrary header value. */
export function nativeTransportObservation(method, rawUrl, headers, expectedOrigin) {
  const url = new URL(rawUrl, expectedOrigin);
  const values = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method, path: url.pathname, originPresent: typeof values.origin === 'string', originMatches: values.origin === expectedOrigin,
    fetchSite: ['same-origin', 'same-site', 'cross-site', 'none'].includes(values['sec-fetch-site']) ? values['sec-fetch-site'] : null,
    fetchMode: ['same-origin', 'cors', 'navigate', 'no-cors'].includes(values['sec-fetch-mode']) ? values['sec-fetch-mode'] : null,
    forwardedHeaderNames: Object.keys(values).filter(name => name === 'forwarded' || name.startsWith('x-forwarded-')).sort(),
  };
}

export class NativeWorkflowTransportFailure extends Error {
  constructor(stage, method, path, status) {
    super(`Native browser transport refused at ${stage}: ${method} ${path} returned ${status}. No headers or responses were repaired.`);
    this.name = 'NativeWorkflowTransportFailure';
    this.finding = { stage, method, path, status };
  }
}
