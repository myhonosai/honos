import { readFileSync } from 'node:fs';

export type DatabaseEnvironment = Readonly<Record<string, string | undefined>>;

// Messages never include a URL, host, credential or certificate: they are safe to log.
export class DatabaseConnectionConfigurationError extends Error {
  constructor(readonly reason: string) {
    super(`HON database connection configuration is invalid: ${reason}.`);
    this.name = 'DatabaseConnectionConfigurationError';
  }
}

export interface VerifiedDatabaseConnection {
  connectionString: string;
  // false only for a loopback fixture; otherwise always a verifying TLS configuration.
  ssl: false | { ca: string; rejectUnauthorized: true };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// node-postgres merges connection-string query parameters OVER the explicit `ssl` option
// (pg/lib/connection-parameters.js), and a `host` parameter replaces the URL host. Any of these
// would silently downgrade or redirect the connection, so they are refused instead of honoured.
const FORBIDDEN_PARAMETERS = /^(?:ssl|sslmode|sslcert|sslkey|sslrootcert|sslpassword|sslnegotiation|sslcompression|requiressl|uselibpqcompat|host|hostaddr)$/i;

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

export function isLoopbackDatabaseUrl(connectionString: string): boolean {
  return LOOPBACK_HOSTS.has(parseDatabaseUrl(connectionString).hostname);
}

function parseDatabaseUrl(connectionString: string): URL {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new DatabaseConnectionConfigurationError('the database URL cannot be parsed');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new DatabaseConnectionConfigurationError('the database URL must use the postgresql scheme');
  }
  if (!url.hostname) throw new DatabaseConnectionConfigurationError('the database URL must name a host');
  for (const key of url.searchParams.keys()) {
    if (FORBIDDEN_PARAMETERS.test(key)) {
      throw new DatabaseConnectionConfigurationError(`remove the "${key.toLowerCase()}" URL parameter; HON configures and verifies TLS itself`);
    }
  }
  return url;
}

function certificateAuthority(env: DatabaseEnvironment): string {
  const inline = env.HON_DATABASE_CA_CERT;
  const file = env.HON_DATABASE_CA_CERT_FILE;
  if (inline && file) throw new DatabaseConnectionConfigurationError('set only one of HON_DATABASE_CA_CERT or HON_DATABASE_CA_CERT_FILE');
  let pem: string;
  if (inline) {
    // Single-line secret stores commonly escape newlines.
    pem = inline.includes('\\n') ? inline.replaceAll('\\n', '\n') : inline;
  } else if (file) {
    try {
      pem = readFileSync(file, 'utf8');
    } catch {
      throw new DatabaseConnectionConfigurationError('HON_DATABASE_CA_CERT_FILE cannot be read');
    }
  } else {
    throw new DatabaseConnectionConfigurationError('a non-local database requires HON_DATABASE_CA_CERT or HON_DATABASE_CA_CERT_FILE for certificate verification');
  }
  if (!PEM_CERTIFICATE.test(pem) || /PRIVATE KEY/.test(pem)) {
    throw new DatabaseConnectionConfigurationError('the database CA must be PEM certificate(s) only');
  }
  return pem;
}

/**
 * Connection options for every HON PostgreSQL client (runtime pool, migrations, verifiers, bootstrap).
 * Loopback fixtures keep plaintext; every other host requires a configured CA and verifies both the
 * certificate chain and the host name (Node's default checkServerIdentity). There is deliberately no
 * option to disable verification.
 */
export function verifiedDatabaseConnection(connectionString: string, env: DatabaseEnvironment = process.env): VerifiedDatabaseConnection {
  const url = parseDatabaseUrl(connectionString);
  if (LOOPBACK_HOSTS.has(url.hostname)) return { connectionString, ssl: false };
  return { connectionString, ssl: { ca: certificateAuthority(env), rejectUnauthorized: true } };
}
