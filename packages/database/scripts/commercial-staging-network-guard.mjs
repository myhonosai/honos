// Test-process guard for trusted, fixed proof scripts; not a sandbox for hostile code.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dgram from 'node:dgram';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import workers from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, lstatSync } from 'node:fs';
import { postgresTarget } from './commercial-staging-safety.mjs';

const audit = process.env.HON_STAGING_NETWORK_AUDIT;
if (!audit?.startsWith('/home/ubuntu/jobs/') && !audit?.startsWith('/tmp/')) throw Error('Private network audit required.');
const stat = lstatSync(audit);
if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw Error('Unsafe network audit.');
const counters = { allowedPostgresConnections: 0, blockedNetworkAttempts: 0, blockedProcessAttempts: 0 };
const refuse = kind => { counters[kind]++; throw Error('COMMERCIAL_VALIDATION_EXTERNAL_EFFECT_REFUSED'); };
const denyNetwork = () => refuse('blockedNetworkAttempts');
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  if (!postgresTarget(args)) return denyNetwork();
  counters.allowedPostgresConnections++;
  return originalConnect.apply(this, args);
};
for (const module of [http, https]) for (const key of ['request', 'get']) module[key] = denyNetwork;
http2.connect = tls.connect = dgram.createSocket = denyNetwork;
const loopback = address => ['127.0.0.1', '::1'].includes(address);
const originalLookup = dns.lookup;
dns.lookup = function (host, ...args) {
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return denyNetwork();
  const callback = args.pop();
  return originalLookup.call(this, host, ...args, (error, addresses, family) => {
    if (!error && !(Array.isArray(addresses) ? addresses.every(a => loopback(a.address)) : loopback(addresses))) {
      counters.blockedNetworkAttempts++; return callback(Error('COMMERCIAL_VALIDATION_EXTERNAL_EFFECT_REFUSED'));
    }
    callback(error, addresses, family);
  });
};
const originalPromiseLookup = dns.promises.lookup;
dns.promises.lookup = async function (host, ...args) {
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return denyNetwork();
  const result = await originalPromiseLookup.call(this, host, ...args);
  if (!(Array.isArray(result) ? result.every(a => loopback(a.address)) : loopback(result.address))) return denyNetwork();
  return result;
};
for (const module of [dns, dns.promises]) {
  for (const key of Object.keys(module).filter(k => /^resolve|^reverse$|^lookupService$/.test(k))) module[key] = denyNetwork;
  module.Resolver = class { constructor() { denyNetwork(); } };
}
globalThis.fetch = async () => denyNetwork();
for (const key of ['WebSocket', 'EventSource']) globalThis[key] = class { constructor() { denyNetwork(); } };
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = () => refuse('blockedProcessAttempts');
workers.Worker = class { constructor() { refuse('blockedProcessAttempts'); } };
syncBuiltinESMExports();
process.on('exit', () => {
  appendFileSync(audit, JSON.stringify(counters) + '\n');
  if (counters.blockedNetworkAttempts || counters.blockedProcessAttempts) process.exitCode = 1;
});
