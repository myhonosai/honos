/**
 * Fail-closed target guard for the destructive CRM list pagination proof (B-CRM-4, PR #166, Manus P1-166-1). It mirrors
 * champions-proof-target.mjs for the dedicated CRM-close fixture created by setup-crm-lead-close-validation.mjs.
 *
 * The connection URLs are checked strictly as text and with node-postgres's own parser (no host/hostaddr/port/user
 * overrides, sockets, sslmode or options), libpq PG* variables and provider credentials or execution switches are
 * refused, and verifyCrmCloseProofConnection() must run on a connected client before any write: it checks the
 * server-side database, role, a TCP loopback peer and the setup marker on database and role. The pure checks are
 * socket-free and covered by test-crm-close-proof-target.mjs, which the proof runs first.
 */
import { createRequire } from 'node:module';

export const CRM_CLOSE_DATABASE = 'hon_crm_close_validation';
export const CRM_CLOSE_OWNER_ROLE = 'hon_crm_close_owner';
export const CRM_CLOSE_RUNTIME_ROLE = 'hon_crm_close_runtime';
export const CRM_CLOSE_MARKER = 'HON disposable CRM-only lead close validation';
const REFUSAL = 'Only the exact disposable localhost CRM-close validation database is permitted; never a remote or unverified database.';
const require = createRequire(createRequire(import.meta.url).resolve('pg'));
const { parse: parsePgConnectionString } = require('pg-connection-string');

/** Validates one URL for one role and returns the explicit client config node-postgres would use for it. */
export function crmCloseTargetConfig(raw, role) {
  // No query, fragment, whitespace or percent-encoding at all (the fixture's credentials are base64url), so nothing
  // can be smuggled in as an encoded socket path, host or option.
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048 || /[?#%\s\\]/.test(raw)) throw new Error(REFUSAL);
  let url, username, password;
  try { url = new URL(raw); username = decodeURIComponent(url.username); password = decodeURIComponent(url.password); } catch { throw new Error(REFUSAL); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'localhost' || url.port !== '5432'
    || url.pathname !== `/${CRM_CLOSE_DATABASE}` || username !== role || password.length === 0 || url.search !== '' || url.hash !== '') throw new Error(REFUSAL);
  // Same interpretation as the real client: every effective parameter must be exactly the expected one.
  let effective;
  try { effective = parsePgConnectionString(raw); } catch { throw new Error(REFUSAL); }
  const keys = Object.keys(effective).filter(k => effective[k] !== undefined).sort();
  if (keys.join(',') !== 'database,host,password,port,user' || effective.host !== 'localhost' || String(effective.port) !== '5432'
    || effective.database !== CRM_CLOSE_DATABASE || effective.user !== role || effective.password !== password) throw new Error(REFUSAL);
  return Object.freeze({ host: 'localhost', port: 5432, database: CRM_CLOSE_DATABASE, user: role, password, ssl: false });
}

export function assertNoLibpqOverrides(env) {
  const overrides = Object.keys(env).filter(k => /^PG[A-Z]/.test(k));
  if (overrides.length) throw new Error(`Refusing libpq connection overrides (${overrides.join(', ')}).`);
}

const PROVIDER = /^(?:OPENROUTER|DIRECT_LLM_API|HEYGEN|HIGGSFIELD|OPENAI|ANTHROPIC|GOOGLE|STRIPE|SQUARE|TWILIO|SHOPIFY|META|FACEBOOK|INSTAGRAM|TIKTOK|SENDGRID|MAILGUN|POSTMARK|SLACK|DISCORD|AWS|AZURE|GCP|SUPABASE|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i;
/** Provider credentials and execution switches have no place in a disposable read proof. */
export function assertNoProviderExecution(env) {
  const risky = Object.keys(env).filter(k => PROVIDER.test(k));
  if (risky.length) throw new Error(`Refusing provider credentials or execution switches (${risky.join(', ')}).`);
}

/** Validates both fixture URLs and the environment; returns explicit owner and runtime client configs. */
export function crmCloseProofTargets(env) {
  assertNoLibpqOverrides(env);
  assertNoProviderExecution(env);
  return { owner: crmCloseTargetConfig(env.DATABASE_URL, CRM_CLOSE_OWNER_ROLE), runtime: crmCloseTargetConfig(env.HON_RUNTIME_DATABASE_URL, CRM_CLOSE_RUNTIME_ROLE) };
}

/** Server-side check on a connected client, before any write. Fails closed on anything unexpected. */
export async function verifyCrmCloseProofConnection(client, role) {
  const { rows: [r] } = await client.query(`SELECT current_database() AS db, current_user AS usr, session_user AS session_usr,
    host(inet_server_addr()) AS server_addr, host(inet_client_addr()) AS client_addr,
    (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()) AS db_marker,
    (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user) AS role_marker,
    (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS db_owner`);
  const loopback = a => a === '127.0.0.1' || a === '::1';
  if (!r || r.db !== CRM_CLOSE_DATABASE || r.usr !== role || r.session_usr !== role || !loopback(r.server_addr) || !loopback(r.client_addr)
    || r.db_marker !== CRM_CLOSE_MARKER || r.role_marker !== CRM_CLOSE_MARKER || r.db_owner !== CRM_CLOSE_OWNER_ROLE) throw new Error(REFUSAL);
}
