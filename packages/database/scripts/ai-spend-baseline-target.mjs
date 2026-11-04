/**
 * AI-0 disposable-target guard. Pure and socket-free: it only parses strings, so it can be tested without any
 * database, DNS or network access. A URL is accepted only if node-postgres would connect to exactly the checked
 * target: PostgreSQL scheme, exact localhost:5432, exact database and role, non-empty password, and no query string
 * or fragment (pg lets query parameters such as host, user, port and sslmode override the URL parts).
 * libpq-style PG* environment variables are refused too, so nothing outside the URL can redirect a connection.
 */
export const AI0_DATABASE = 'hon_ai_spend_baseline_validation';
export const AI0_OWNER_ROLE = 'hon_ai_spend_baseline_owner';
export const AI0_RUNTIME_ROLE = 'hon_ai_spend_baseline_runtime';
const REFUSAL = 'AI-0 permits only the exact disposable localhost owner/runtime aliases.';

export function assertDisposableTarget(raw, role, database = AI0_DATABASE) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048 || /[?#\s]/.test(raw)) throw new Error(REFUSAL);
  let url;
  try { url = new URL(raw); } catch { throw new Error(REFUSAL); }
  let username, password;
  try { username = decodeURIComponent(url.username); password = decodeURIComponent(url.password); } catch { throw new Error(REFUSAL); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'localhost' || url.port !== '5432'
    || url.pathname !== `/${database}` || username !== role || password.length === 0 || url.search !== '' || url.hash !== '') throw new Error(REFUSAL);
  return url.toString();
}

export function assertNoLibpqOverrides(env) {
  const overrides = Object.keys(env).filter((k) => /^PG[A-Z]/.test(k));
  if (overrides.length) throw new Error(`AI-0 refuses libpq connection overrides (${overrides.join(', ')}).`);
}
