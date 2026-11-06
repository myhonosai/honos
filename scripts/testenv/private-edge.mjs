// Temporary approved sandbox edge ONLY. HON sessions/IAM/entitlements stay unmodified.
import { createServer } from 'node:http';
import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateSiteGate } from './private-site-gate.mjs';
import { testEnvironmentRuntime } from './runtime-config.mjs';
import { validateStateDirectory, assertPrivateFile } from './state-safety.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = testEnvironmentRuntime();
if (runtime.origin === runtime.privateOrigin) throw new Error('Private edge requires approved public HTTPS origin.');
if (!process.env.HON_TESTENV_HOME?.startsWith('/')) throw new Error('Private edge requires explicit external state.');
const state = validateStateDirectory(process.env.HON_TESTENV_HOME, { root });
const secretsFile = join(state, 'secrets.json');
const ca = readFileSync(join(state, 'tls/ca.pem'));
assertPrivateFile(secretsFile);
const siteExpiresAt = Date.parse(JSON.parse(readFileSync(secretsFile, 'utf8')).createdAt) + 7 * 86400000;
if (!Number.isFinite(siteExpiresAt) || Date.now() >= siteExpiresAt) throw new Error('Temporary site lifespan is invalid or expired.');
const port = Number(process.env.HON_TESTENV_EDGE_PORT ?? 3450);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || Object.values(runtime.ports).includes(port)) throw new Error('Edge port is invalid.');
const publicHost = new URL(runtime.origin).host;
const hopHeaders = new Set(['connection', 'proxy-connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'forwarded', 'x-real-ip']);
function proxy(req, res) {
  // This explicit environment-only ingress contract removes untrusted proxy metadata.
  // Actual browser Origin/Sec-Fetch/human-command/expected-principal/idempotency are NOT invented.
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (hopHeaders.has(key) || key.startsWith('x-forwarded-') || key === 'host') continue;
    if (key === 'cookie') {
      headers.cookie = String(value).split(';').filter(piece => !piece.trim().startsWith('__Host-hon_lab_gate=')).join(';');
    } else headers[key] = value;
  }
  headers.host = publicHost;
  const upstream = request({ hostname: 'localhost', port: runtime.ports.gateway, servername: 'localhost', ca,
    rejectUnauthorized: true, method: req.method, path: req.url, headers }, response => {
    const outgoing = { ...response.headers, 'cache-control': 'private, no-store', pragma: 'no-cache',
      'referrer-policy': response.headers['referrer-policy'] ?? 'no-referrer' };
    delete outgoing.connection;
    res.writeHead(response.statusCode ?? 502, outgoing); response.pipe(res);
  });
  upstream.setTimeout(30000, () => upstream.destroy());
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'private, no-store' });
    res.end('Private test application is unavailable.');
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}
function loadGate() {
  assertPrivateFile(secretsFile);
  const { gatePasscode } = JSON.parse(readFileSync(secretsFile, 'utf8'));
  if (typeof gatePasscode !== 'string' || gatePasscode.length < 32) throw new Error('Secure private gate passcode is missing.');
  return createPrivateSiteGate({ origin: runtime.origin, passcode: gatePasscode, proxy });
}
let gate = loadGate();
const server = createServer((req, res) => {
  if (Date.now() >= siteExpiresAt) {
    gate.revokeAll(); res.writeHead(410, { 'Cache-Control': 'private, no-store' }); res.end('Temporary private test site has expired.'); return;
  }
  if (!req.url?.startsWith('/') || req.url.startsWith('//') || /[\x00-\x20\x7f]/.test(req.url)) {
    res.writeHead(400, { 'Cache-Control': 'private, no-store' }); res.end('Invalid request.'); return;
  }
  Promise.resolve(gate.handler(req, res)).catch(() => {
    if (!res.headersSent) res.writeHead(503, { 'Cache-Control': 'private, no-store' });
    res.end('Private test access is unavailable.');
  });
});
server.requestTimeout = 30000; server.headersTimeout = 15000;
// Revocation is operator-only, not an unauthenticated public route.
process.on('SIGUSR2', () => { gate.revokeAll(); console.log('All private gate sessions revoked.'); });
process.on('SIGHUP', () => { gate.revokeAll(); try { gate = loadGate(); console.log('Private credentials reloaded; previous sessions revoked.'); } catch { server.close(); console.error('Gate credential reload refused; access closed.'); process.exitCode = 1; } });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { gate.revokeAll(); server.close(() => process.exit(0)); server.closeAllConnections(); });
server.listen(port, '0.0.0.0', () => console.log('Temporary passcode-protected edge ready; HON login is independently required.'));
