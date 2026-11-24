import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Per-school provider tokens (Square OAuth). Plain text exists only in API memory; the database sees the sealed text. */
export interface SchoolPayCredential { accessToken: string; refreshToken: string; accessExpiresAt: string }
/** What a sealed credential is bound to: a copy on another connection, provider or account never opens. */
export interface SchoolPayCredentialBinding { connectionId: string; providerCode: string; accountRef: string }

const KEY_ID = /^[a-z0-9-]{1,40}$/;
const TOKEN = /^[\x21-\x7e]{1,1024}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SEALED = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/;

function refuse(): never { throw new Error('SCHOOL_PAY_VAULT_REFUSED'); }
function credentialOk(value: unknown): value is SchoolPayCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(',') === 'accessExpiresAt,accessToken,refreshToken'
    && typeof row.accessToken === 'string' && TOKEN.test(row.accessToken)
    && typeof row.refreshToken === 'string' && TOKEN.test(row.refreshToken)
    && typeof row.accessExpiresAt === 'string' && INSTANT.test(row.accessExpiresAt) && new Date(row.accessExpiresAt).toISOString() === row.accessExpiresAt;
}
function aad(binding: SchoolPayCredentialBinding, keyId: string): Buffer {
  return Buffer.from(`hon-school-pay-credential:v1:${keyId}:${binding.connectionId.toLowerCase()}:${binding.providerCode}:${binding.accountRef}`, 'utf8');
}

/** AES-256-GCM with a fresh 96-bit IV per seal; the key id, connection, provider and account are authenticated data. */
export class SchoolPaymentVault {
  constructor(private readonly key: Buffer, readonly keyId: string) {
    if (key.length !== 32 || !KEY_ID.test(keyId)) refuse();
  }

  seal(binding: SchoolPayCredentialBinding, credential: SchoolPayCredential): string {
    if (!credentialOk(credential)) refuse();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(aad(binding, this.keyId));
    const body = Buffer.concat([cipher.update(JSON.stringify({ accessToken: credential.accessToken, refreshToken: credential.refreshToken,
      accessExpiresAt: credential.accessExpiresAt }), 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
  }

  open(binding: SchoolPayCredentialBinding, keyId: string, sealed: string): SchoolPayCredential {
    const parts = typeof sealed === 'string' && sealed.length <= 8100 ? SEALED.exec(sealed) : null;
    if (keyId !== this.keyId || !parts) refuse();
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(parts[1]!, 'base64url'));
      decipher.setAAD(aad(binding, keyId));
      decipher.setAuthTag(Buffer.from(parts[3]!, 'base64url'));
      const value: unknown = JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[2]!, 'base64url')), decipher.final()]).toString('utf8'));
      if (!credentialOk(value)) refuse();
      return value;
    } catch { return refuse(); }
  }
}

/** The vault for this process, or null when no valid key is configured (providers that need one stay NOT_CONFIGURED). */
export function schoolPaymentVaultFromEnvironment(env: NodeJS.ProcessEnv = process.env): SchoolPaymentVault | null {
  const encoded = env.HON_SCHOOL_PAY_VAULT_KEY ?? '';
  const keyId = env.HON_SCHOOL_PAY_VAULT_KEY_ID ?? '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded) || !KEY_ID.test(keyId)) return null;
  const key = Buffer.from(encoded, 'base64');
  return key.length === 32 ? new SchoolPaymentVault(key, keyId) : null;
}

export const SCHOOL_PAYMENT_VAULT = Symbol('SCHOOL_PAYMENT_VAULT');

/**
 * The vault for the API process: the configured key, or, only with the in-process simulators outside production, a
 * random per-process key (simulated tokens are synthetic and lost on restart, which the simulators tolerate).
 */
export function schoolPaymentVaultForProcess(env: NodeJS.ProcessEnv = process.env): SchoolPaymentVault | null {
  const configured = schoolPaymentVaultFromEnvironment(env);
  if (configured) return configured;
  return env.HON_SCHOOL_PAY_SIMULATORS === '1' && env.NODE_ENV !== 'production' ? new SchoolPaymentVault(randomBytes(32), 'sim-ephemeral') : null;
}
