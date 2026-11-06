import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = '__Host-hon_lab_gate';
const ACCESS = '/__private-access';
const LOGOUT = `${ACCESS}/logout`;
const TTL_MS = 2 * 60 * 60 * 1000;
const MAX_TOKENS = 1024;
const MAX_FORM_BYTES = 4096;
const MAX_COOKIE_BYTES = 8192;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;
const BODY_TIMEOUT_MS = 10_000;
const hash = (value) => createHash('sha256').update(value).digest();
const tokenKey = (value) => hash(value).toString('hex');
const CLEAR_COOKIE = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;

const FORM = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Private nonproduction access</title></head>
<body><main><h1>NONPRODUCTION — restricted access</h1>
<p>This temporary HON test environment is private. Authorized testers only.</p>
<p>The environment passcode is separate from HON sign-in. Unlocking this gate does not create a HON session or grant school or HQ authority.</p>
<form method="post" action="/__private-access"><label for="passcode">Private site passcode</label>
<input id="passcode" name="passcode" type="password" required autocomplete="off" maxlength="4096">
<button type="submit">Unlock test site</button></form>
</main></body></html>`;

function singleHeader(req, name) {
  if (Array.isArray(req.rawHeaders)) {
    const matches = [];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (String(req.rawHeaders[index]).toLowerCase() === name) matches.push(req.rawHeaders[index + 1]);
    }
    if (matches.length > 1) return null;
    if (matches.length === 1) return typeof matches[0] === 'string' ? matches[0] : null;
  }
  const value = req.headers?.[name];
  return value === undefined || typeof value === 'string' ? value : null;
}

function gateCookie(req) {
  const values = [];
  if (Array.isArray(req.rawHeaders)) {
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (String(req.rawHeaders[index]).toLowerCase() === 'cookie') values.push(req.rawHeaders[index + 1]);
    }
  }
  if (!values.length && req.headers?.cookie !== undefined) values.push(req.headers.cookie);
  if (values.some((value) => typeof value !== 'string')) return { invalid: true };
  const header = values.join('; ');
  if (Buffer.byteLength(header) > MAX_COOKIE_BYTES) return { invalid: true };
  let count = 0;
  let token;
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    const name = (separator < 0 ? item : item.slice(0, separator)).trim();
    if (name !== COOKIE) continue;
    count += 1;
    token = separator < 0 ? '' : item.slice(separator + 1).trim();
  }
  if (count > 1) return { invalid: true };
  return { token: count === 1 && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined };
}

// This environment credential must not reach HON/IdP upstreams. Preserve
// their existing cookies and authorization; do not create or consume them.
function stripGateCookie(req) {
  const strip = (value) => value.split(';').filter((item) => {
    const separator = item.indexOf('=');
    return (separator < 0 ? item : item.slice(0, separator)).trim() !== COOKIE;
  }).join(';').trim();
  if (typeof req.headers?.cookie === 'string') {
    const remaining = strip(req.headers.cookie);
    if (remaining) req.headers.cookie = remaining;
    else delete req.headers.cookie;
  }
  if (Array.isArray(req.rawHeaders)) {
    const remaining = [];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      const name = req.rawHeaders[index];
      const value = req.rawHeaders[index + 1];
      if (String(name).toLowerCase() !== 'cookie') remaining.push(name, value);
      else {
        const cookies = strip(value);
        if (cookies) remaining.push(name, cookies);
      }
    }
    req.rawHeaders = remaining;
  }
}

function privateHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Cookie');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}

function respond(res, status, body = '', type = 'text/plain; charset=utf-8') {
  privateHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  // Native form POSTs need a same-origin referrer policy to preserve Origin.
  // Cross-origin referrers remain suppressed; Origin:null stays forbidden.
  if (type === 'text/html; charset=utf-8') res.setHeader('Referrer-Policy', 'same-origin');
  res.end(body);
}

function redirect(res, location) {
  res.setHeader('Location', location);
  respond(res, 303);
}

function isApi(req, pathname) {
  return /^\/api(?:\/|$)/.test(pathname)
    || /^\/\.well-known(?:\/|$)/.test(pathname)
    || /\/(?:token|jwks(?:\.json)?|userinfo|introspect|revoke)\/?$/.test(pathname)
    || /(?:application\/json|\+json)(?:[;,\s]|$)/i.test(singleHeader(req, 'accept') ?? '');
}

// Never accumulate more than 4096 bytes. Oversize, stalled or aborted bodies
// fail closed; the response closes the connection rather than draining them.
function boundedBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let timer;
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      // Keep this listener until end/close so a subsequent stream error cannot
      // become an uncaught exception after a refusal.
      req.once('close', () => req.off('error', onError));
      if (result.status) req.pause();
      resolve(result);
    };
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_FORM_BYTES) finish({ status: 413 });
      else chunks.push(bytes);
    };
    const onEnd = () => {
      finish({ body: Buffer.concat(chunks, size) });
      req.off('error', onError);
    };
    const onAborted = () => finish({ status: 400 });
    const onError = () => finish({ status: 400 });
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.on('error', onError);
    timer = setTimeout(() => finish({ status: 408 }), BODY_TIMEOUT_MS);
    timer.unref();
  });
}

function parsePasscode(body) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    const fields = text.split('&');
    if (fields.length !== 1) return undefined;
    const separator = fields[0].indexOf('=');
    if (separator < 0) return undefined;
    const decode = (value) => decodeURIComponent(value.replace(/\+/g, ' '));
    if (decode(fields[0].slice(0, separator)) !== 'passcode') return undefined;
    return decode(fields[0].slice(separator + 1));
  } catch {
    return undefined;
  }
}

/**
 * Environment-only defense in depth, before ALL app/IdP/static/API routes.
 * The caller owns HTTPS termination, canonical edge-header handling, private
 * backchannels and the proxy. No bypass header or route is recognized here.
 * The gate has no persistence, HON session handling, identity or tenant role.
 */
export function createPrivateSiteGate({ origin, passcode, proxy, now = Date.now }) {
  let canonicalOrigin;
  try {
    const parsed = new URL(origin);
    if (typeof origin !== 'string' || !/^https:\/\/[^/?#]+$/i.test(origin)
      || parsed.protocol !== 'https:' || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error();
    canonicalOrigin = parsed.origin;
  } catch {
    throw new TypeError('A bare HTTPS origin is required.');
  }
  if (typeof passcode !== 'string' || [...passcode].length < 32) {
    throw new TypeError('A passcode of at least 32 characters is required.');
  }
  if (typeof proxy !== 'function' || typeof now !== 'function') {
    throw new TypeError('A proxy function and clock function are required.');
  }
  const expected = hash(passcode);
  // Only token hashes and expiries are retained. Bounded per-process gate
  // state: no attacker-keyed/IP/forwarded-header maps or persistent tokens.
  const tokens = new Map();
  let windowStart;
  let failures = 0;
  const revokeAll = () => tokens.clear();

  const handler = async (req, res) => {
    try {
      const time = now();
      if (!Number.isFinite(time) || time < 0 || time > 8.64e15 - TTL_MS) {
        respond(res, 503, 'Private access unavailable.');
        return;
      }
      for (const [key, expiry] of tokens) if (expiry <= time) tokens.delete(key);
      if (windowStart === undefined || time < windowStart || time - windowStart >= FAILURE_WINDOW_MS) {
        windowStart = time;
        failures = 0;
      }
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')
        || /[\\\u0000-\u0020\u007f]/.test(req.url)) {
        respond(res, 400, 'Invalid request.');
        return;
      }
      const target = new URL(req.url, canonicalOrigin);
      if (target.origin !== canonicalOrigin) {
        respond(res, 400, 'Invalid request.');
        return;
      }
      const cookie = gateCookie(req);
      const key = cookie.token ? tokenKey(cookie.token) : undefined;
      const authorized = !cookie.invalid && key !== undefined && tokens.has(key);
      const rawPath = req.url.split('?')[0];
      if (rawPath === ACCESS || rawPath === LOGOUT) {
        if (rawPath === ACCESS && req.method === 'GET') {
          respond(res, 200, FORM, 'text/html; charset=utf-8');
          return;
        }
        if (req.method !== 'POST') {
          res.setHeader('Allow', rawPath === ACCESS ? 'GET, POST' : 'POST');
          respond(res, 405, 'Method not allowed.');
          return;
        }
        // Require Origin even without Fetch Metadata. Never derive it from
        // Host, forwarded headers, Referer or a user-provided return URL.
        const fetchSite = singleHeader(req, 'sec-fetch-site');
        if (singleHeader(req, 'origin') !== canonicalOrigin
          || (fetchSite !== undefined && fetchSite !== 'same-origin')) {
          res.setHeader('Connection', 'close');
          respond(res, 403, 'Private access denied.');
          return;
        }
        if (cookie.invalid) {
          res.setHeader('Set-Cookie', CLEAR_COOKIE);
          res.setHeader('Connection', 'close');
          respond(res, 400, 'Invalid request.');
          return;
        }
        if (rawPath === ACCESS && failures >= MAX_FAILURES) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil((windowStart + FAILURE_WINDOW_MS - time) / 1000))));
          res.setHeader('Connection', 'close');
          respond(res, 429, 'Private access temporarily unavailable.');
          return;
        }
        const length = singleHeader(req, 'content-length');
        const encoding = singleHeader(req, 'content-encoding');
        if ((length !== undefined && (length === null || !/^\d+$/.test(length) || Number(length) > MAX_FORM_BYTES))
          || encoding !== undefined) {
          if (rawPath === ACCESS) failures = Math.min(MAX_FAILURES, failures + 1);
          res.setHeader('Connection', 'close');
          respond(res, length !== null && Number(length) > MAX_FORM_BYTES ? 413 : 400, 'Invalid form.');
          return;
        }
        if (rawPath === ACCESS && !/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(singleHeader(req, 'content-type') ?? '')) {
          failures = Math.min(MAX_FAILURES, failures + 1);
          res.setHeader('Connection', 'close');
          respond(res, 415, 'Invalid form.');
          return;
        }
        const body = await boundedBody(req);
        if (body.status) {
          if (rawPath === ACCESS) failures = Math.min(MAX_FAILURES, failures + 1);
          res.setHeader('Connection', 'close');
          respond(res, body.status, 'Invalid form.');
          return;
        }
        if (rawPath === LOGOUT) {
          if (body.body.length !== 0) {
            respond(res, 400, 'Invalid form.');
            return;
          }
          if (key !== undefined) tokens.delete(key);
          res.setHeader('Set-Cookie', CLEAR_COOKIE);
          redirect(res, ACCESS);
          return;
        }
        // Recheck after awaiting the body: concurrent pending attempts must
        // not bypass the process-wide failure limit or server-side expiry.
        const completedAt = now();
        if (!Number.isFinite(completedAt) || completedAt < time || completedAt > 8.64e15 - TTL_MS) {
          respond(res, 503, 'Private access unavailable.');
          return;
        }
        if (completedAt - windowStart >= FAILURE_WINDOW_MS) {
          windowStart = completedAt;
          failures = 0;
        }
        if (failures >= MAX_FAILURES) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil((windowStart + FAILURE_WINDOW_MS - completedAt) / 1000))));
          respond(res, 429, 'Private access temporarily unavailable.');
          return;
        }
        const candidate = parsePasscode(body.body);
        if (candidate === undefined) {
          failures = Math.min(MAX_FAILURES, failures + 1);
          respond(res, 400, 'Invalid form.');
          return;
        }
        if (!timingSafeEqual(hash(candidate), expected)) {
          failures = Math.min(MAX_FAILURES, failures + 1);
          respond(res, 401, FORM, 'text/html; charset=utf-8');
          return;
        }
        for (const [stored, expiry] of tokens) if (expiry <= completedAt) tokens.delete(stored);
        if (tokens.size >= MAX_TOKENS && !tokens.has(key)) {
          respond(res, 503, 'Private access unavailable.');
          return;
        }
        const token = randomBytes(32).toString('base64url');
        if (key !== undefined) tokens.delete(key);
        tokens.set(tokenKey(token), completedAt + TTL_MS);
        res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=7200; Expires=${new Date(completedAt + TTL_MS).toUTCString()}`);
        redirect(res, '/');
        return;
      }
      if (!authorized) {
        if (isApi(req, target.pathname)) {
          respond(res, 401, '{"error":"private_access_required"}', 'application/json; charset=utf-8');
        } else {
          redirect(res, ACCESS);
        }
        return;
      }
      stripGateCookie(req);
      await proxy(req, res);
    } catch {
      // Do not log or reflect request bodies, passcodes, cookies, tokens or
      // upstream error details. Clear partially prepared upstream headers.
      if (res.headersSent || res.writableEnded) {
        res.destroy();
      } else {
        for (const name of res.getHeaderNames()) res.removeHeader(name);
        respond(res, 503, 'Private access unavailable.');
      }
    }
  };
  return { handler, revokeAll };
}
