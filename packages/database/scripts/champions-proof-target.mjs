/**
 * Fail-closed target guard for the destructive Champions Club fixture proofs added by #123 (0201) and #124 (0202).
 *
 * A proof may only touch the dedicated, marked, disposable localhost database that setup-champions-club-validation.mjs
 * creates. The connection URLs are checked twice:
 *   1. strictly as text (scheme, exact localhost:5432, exact database and role, non-empty password, no query string,
 *      fragment or whitespace), and
 *   2. with the parser node-postgres itself uses (pg-connection-string, resolved from the installed pg), so that the
 *      effective destination the real client would use is exactly host=localhost, port=5432, the exact database and
 *      role, and no other connection option (host/hostaddr/port/user overrides, sockets, sslmode, options, ...).
 * libpq-style PG* environment variables are refused as well. Clients must then be built from the returned explicit
 * config (never from a raw string), and verifyChampionsProofConnection() must run on a connected client before any
 * write: it checks the server-side database, role, a TCP loopback peer and the setup marker on database and role.
 * The pure checks are socket-free and covered by test-champions-proof-target.mjs.
 */
import { createRequire } from 'node:module';

export const CHAMPIONS_DATABASE = 'hon_champions_validation';
export const CHAMPIONS_OWNER_ROLE = 'hon_champions_owner';
export const CHAMPIONS_RUNTIME_ROLE = 'hon_champions_runtime';
export const CHAMPIONS_MARKER = 'HON disposable Champions Club validation';
const REFUSAL = 'Only the exact disposable localhost Champions Club validation database is permitted; never a remote or unverified database.';
const require = createRequire(createRequire(import.meta.url).resolve('pg'));
const { parse: parsePgConnectionString } = require('pg-connection-string');

/** Validates one URL for one role and returns the explicit client config node-postgres would use for it. */
export function championsTargetConfig(raw, role) {
  // No query, fragment, whitespace or percent-encoding at all (the fixture's credentials are base64url), so nothing
  // can be smuggled in as an encoded socket path, host or option.
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048 || /[?#%\s\\]/.test(raw)) throw new Error(REFUSAL);
  let url, username, password;
  try { url = new URL(raw); username = decodeURIComponent(url.username); password = decodeURIComponent(url.password); } catch { throw new Error(REFUSAL); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'localhost' || url.port !== '5432'
    || url.pathname !== `/${CHAMPIONS_DATABASE}` || username !== role || password.length === 0 || url.search !== '' || url.hash !== '') throw new Error(REFUSAL);
  // Same interpretation as the real client: every effective parameter must be exactly the expected one.
  let effective;
  try { effective = parsePgConnectionString(raw); } catch { throw new Error(REFUSAL); }
  const keys = Object.keys(effective).filter(k => effective[k] !== undefined).sort();
  if (keys.join(',') !== 'database,host,password,port,user' || effective.host !== 'localhost' || String(effective.port) !== '5432'
    || effective.database !== CHAMPIONS_DATABASE || effective.user !== role || effective.password !== password) throw new Error(REFUSAL);
  return Object.freeze({ host: 'localhost', port: 5432, database: CHAMPIONS_DATABASE, user: role, password, ssl: false });
}

export function assertNoLibpqOverrides(env) {
  const overrides = Object.keys(env).filter(k => /^PG[A-Z]/.test(k));
  if (overrides.length) throw new Error(`Refusing libpq connection overrides (${overrides.join(', ')}).`);
}

/** Validates both fixture URLs and the environment; returns explicit owner and runtime client configs. */
export function championsProofTargets(env) {
  assertNoLibpqOverrides(env);
  return { owner: championsTargetConfig(env.DATABASE_URL, CHAMPIONS_OWNER_ROLE), runtime: championsTargetConfig(env.HON_RUNTIME_DATABASE_URL, CHAMPIONS_RUNTIME_ROLE) };
}

/** Server-side check on a connected client, before any write. Fails closed on anything unexpected. */
export async function verifyChampionsProofConnection(client, role) {
  const { rows: [r] } = await client.query(`SELECT current_database() AS db, current_user AS usr, session_user AS session_usr,
    host(inet_server_addr()) AS server_addr, host(inet_client_addr()) AS client_addr,
    (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()) AS db_marker,
    (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user) AS role_marker,
    (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS db_owner`);
  const loopback = a => a === '127.0.0.1' || a === '::1';
  if (!r || r.db !== CHAMPIONS_DATABASE || r.usr !== role || r.session_usr !== role || !loopback(r.server_addr) || !loopback(r.client_addr)
    || r.db_marker !== CHAMPIONS_MARKER || r.role_marker !== CHAMPIONS_MARKER || r.db_owner !== CHAMPIONS_OWNER_ROLE) throw new Error(REFUSAL);
}
