// End-to-end proof that HON database connections verify the server certificate.
// Starts a private, throwaway PostgreSQL 16 cluster with TLS on 127.0.0.2/.3 (loopback interface, but
// not one of the plaintext fixture hosts, so HON treats it as a remote database) using a freshly
// generated CA. No network, no shared cluster, no credentials beyond a generated local password.
// Proves: correct CA connects with verification; a different CA, a host-name mismatch, a missing CA
// and URL TLS overrides are all refused.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { verifiedDatabaseConnection } from '../dist/index.js';

if (process.env.GITHUB_ACTIONS !== 'true' && process.env.HON_DB_PROOFS_LOCAL !== '1') throw new Error('Set HON_DB_PROOFS_LOCAL=1 to run locally.');
if (process.env.DATABASE_URL || process.env.HON_RUNTIME_DATABASE_URL) throw new Error('Unset database URLs; this proof generates its own cluster.');
const bin = process.env.HON_POSTGRES_BIN ?? '/usr/lib/postgresql/16/bin';
const port = '55437';
const asRoot = process.getuid?.() === 0;
const root = mkdtempSync(join(tmpdir(), 'hon-tls-proof-'));
chmodSync(root, 0o755);
const pgdata = join(root, 'pgdata');
const safeEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' };
const sh = (binary, args, options = {}) => {
  const [command, argv] = asRoot && options.asPostgres ? ['sudo', ['-u', 'postgres', binary, ...args]] : [binary, args];
  const result = spawnSync(command, argv, { encoding: 'utf8', env: safeEnv, stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'], ...(options.input ? { input: options.input } : {}) });
  if (result.status !== 0) throw new Error(`${binary.split('/').at(-1)} failed: ${result.stderr.slice(0, 400)}`);
  return result.stdout;
};
const openssl = (...args) => sh('openssl', args);
const expect = (condition, message) => { if (!condition) throw new Error(message); console.log(`PASS: ${message}`); };

let started = false;
try {
  // Two independent CAs; the server certificate is issued by the first for 127.0.0.2 only.
  for (const name of ['ca', 'rogue-ca']) {
    openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', `/CN=HON ${name} proof`, '-keyout', join(root, `${name}.key`), '-out', join(root, `${name}.crt`));
  }
  openssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', '/CN=127.0.0.2', '-keyout', join(root, 'server.key'), '-out', join(root, 'server.csr'));
  writeFileSync(join(root, 'san.ext'), 'subjectAltName=IP:127.0.0.2\n');
  openssl('x509', '-req', '-in', join(root, 'server.csr'), '-CA', join(root, 'ca.crt'), '-CAkey', join(root, 'ca.key'), '-CAcreateserial', '-days', '1', '-extfile', join(root, 'san.ext'), '-out', join(root, 'server.crt'));
  const password = randomBytes(24).toString('base64url');
  writeFileSync(join(root, 'pw'), `${password}\n`, { mode: 0o644 });
  if (asRoot) sh('chown', ['-R', 'postgres:postgres', root]);
  sh(`${bin}/initdb`, ['-D', pgdata, '-U', 'postgres', '--pwfile', join(root, 'pw'), '--auth-host=scram-sha-256', '--auth-local=trust', '--no-locale', '--encoding=UTF8'], { asPostgres: true });
  for (const file of ['server.crt', 'server.key']) sh('cp', [join(root, file), join(pgdata, file)], { asPostgres: true });
  sh('chmod', ['600', join(pgdata, 'server.key')], { asPostgres: true });
  const conf = readFileSync(join(pgdata, 'postgresql.conf'), 'utf8') + `\nssl = on\nlisten_addresses = '127.0.0.2,127.0.0.3'\nport = ${port}\nunix_socket_directories = '${root}'\n`;
  sh('tee', [join(pgdata, 'postgresql.conf')], { asPostgres: true, input: conf });
  // Refuse any non-TLS TCP connection outright.
  sh('tee', [join(pgdata, 'pg_hba.conf')], { asPostgres: true, input: 'local all all trust\nhostssl all all 127.0.0.0/8 scram-sha-256\n' });
  try {
    sh(`${bin}/pg_ctl`, ['-D', pgdata, '-l', join(root, 'server.log'), '-w', 'start'], { asPostgres: true });
  } catch (error) {
    let log = '';
    try { log = readFileSync(join(root, 'server.log'), 'utf8').slice(-800); } catch { /* no log */ }
    throw new Error(`${error.message}\n${log}`);
  }
  started = true;

  const url = `postgresql://postgres:${password}@127.0.0.2:${port}/postgres`;
  const ca = readFileSync(join(root, 'ca.crt'), 'utf8');
  const rogue = readFileSync(join(root, 'rogue-ca.crt'), 'utf8');
  const attempt = async (connectionString, env) => {
    const client = new pg.Client({ ...verifiedDatabaseConnection(connectionString, env), connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      return (await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0]?.ssl === true ? 'TLS' : 'PLAINTEXT';
    } catch (error) {
      return `REFUSED:${error.code ?? error.name}`;
    } finally {
      await client.end().catch(() => {});
    }
  };
  const first = await attempt(url, { HON_DATABASE_CA_CERT: ca });
  expect(first === 'TLS', `the configured CA connects over verified TLS (${first})`);
  expect(await attempt(url, { HON_DATABASE_CA_CERT: ca.replaceAll('\n', '\\n') }) === 'TLS', 'an escaped single-line CA secret is accepted');
  writeFileSync(join(root, 'ca-copy.crt'), ca);
  expect(await attempt(url, { HON_DATABASE_CA_CERT_FILE: join(root, 'ca-copy.crt') }) === 'TLS', 'a CA file path connects over verified TLS');
  const wrongCa = await attempt(url, { HON_DATABASE_CA_CERT: rogue });
  expect(wrongCa.startsWith('REFUSED:'), `a server certificate from another CA is refused (${wrongCa})`);
  // Same server and CA, reached at an address the certificate does not cover.
  const mismatch = await attempt(`postgresql://postgres:${password}@127.0.0.3:${port}/postgres`, { HON_DATABASE_CA_CERT: ca });
  expect(mismatch.startsWith('REFUSED:'), `a host name not in the certificate is refused (${mismatch})`);
  // Contrast with the configuration this replaces: it accepts a server whose certificate it cannot verify.
  const legacy = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false, ca: rogue }, connectionTimeoutMillis: 5000 });
  let legacyConnected = false;
  try { await legacy.connect(); legacyConnected = true; } catch { /* expected to connect */ } finally { await legacy.end().catch(() => {}); }
  expect(legacyConnected, 'the former rejectUnauthorized:false setting accepts an unverifiable server (the defect being fixed)');
  let missing;
  try { verifiedDatabaseConnection(url, {}); } catch (error) { missing = error; }
  expect(/requires HON_DATABASE_CA_CERT/.test(missing?.message ?? ''), 'a remote database without a configured CA is refused before connecting');
  let override;
  try { verifiedDatabaseConnection(`${url}?sslmode=disable`, { HON_DATABASE_CA_CERT: ca }); } catch (error) { override = error; }
  expect(/remove the "sslmode" URL parameter/.test(override?.message ?? ''), 'a URL that would disable TLS is refused');
  expect(!(missing.message + override.message).includes(password), 'configuration errors never contain the credential');
  console.log('PASS: HON database TLS verification proven against a private TLS-only PostgreSQL cluster.');
} finally {
  if (started) { try { sh(`${bin}/pg_ctl`, ['-D', pgdata, '-m', 'immediate', '-w', 'stop'], { asPostgres: true }); } catch { /* best effort */ } }
  rmSync(root, { recursive: true, force: true });
}
