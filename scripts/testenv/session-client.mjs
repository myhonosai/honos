// Command-line sign-in for the private test environment.
//
// Performs the SAME real login a browser does (HON /auth/login -> test identity provider ->
// HON /auth/callback, with HON's own PKCE/state/nonce/ID-token verification) and returns the
// resulting HON session cookie. It holds no authority of its own: whatever it calls afterwards is
// authorised by the API's normal IAM checks for that test identity.
import { request } from 'node:https';
import { readFileSync } from 'node:fs';

function call(origin, ca, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    const req = request({ hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, ca, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}
function cookiesFrom(response) {
  return (response.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));
}

export async function signIn({ origin, caFile, identityKey, accessCode }) {
  const ca = readFileSync(caFile);
  const login = await call(origin, ca, 'GET', '/auth/login');
  if (login.status < 300 || login.status >= 400 || !login.headers.location) throw new Error(`HON /auth/login did not redirect (HTTP ${login.status}).`);
  const transactionCookies = cookiesFrom(login);
  const authorize = new URL(login.headers.location);
  if (authorize.origin !== origin) throw new Error('Unexpected identity provider origin.');
  const form = new URLSearchParams(authorize.searchParams);
  form.set('identity', identityKey);
  form.set('access_code', accessCode);
  const consent = await call(origin, ca, 'POST', `${authorize.pathname}`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, 'Sec-Fetch-Site': 'same-origin' }, body: form.toString(),
  });
  if (consent.status !== 303 || !consent.headers.location) throw new Error(`Test sign-in refused (HTTP ${consent.status}). Check the access code.`);
  const callback = new URL(consent.headers.location);
  const finished = await call(origin, ca, 'GET', `${callback.pathname}${callback.search}`, { headers: { Cookie: transactionCookies.join('; ') } });
  const session = cookiesFrom(finished).find((c) => c.startsWith('hon_session='));
  if (!session) throw new Error(`HON did not issue a session (HTTP ${finished.status}): ${finished.body.slice(0, 200)}`);
  return {
    cookie: session,
    api: (method, path, { json, headers = {} } = {}) => call(origin, ca, method, path, {
      headers: { Cookie: session, Accept: 'application/json', ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: json === undefined ? undefined : JSON.stringify(json),
    }).then((r) => ({ ...r, data: (() => { try { return JSON.parse(r.body); } catch { return undefined; } })() })),
  };
}
