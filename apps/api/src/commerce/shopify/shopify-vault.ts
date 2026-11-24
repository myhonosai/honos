import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Shopify token pairs (expiring offline tokens). Plain text exists only in API memory; the database sees the sealed text.
 * AES-256-GCM with a fresh 96-bit IV per seal; the key id, the connection and the shop are authenticated data, so a
 * sealed pair copied to another connection or shop never opens.
 */
export interface ShopifyCredential { accessToken: string; refreshToken: string; accessExpiresAt: string; refreshExpiresAt: string }
export interface ShopifyCredentialBinding { connectionId: string; shopDomain: string }

const KEY_ID = /^[a-z0-9-]{1,40}$/;
const TOKEN = /^[\x21-\x7e]{1,1024}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SEALED = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/;
const KEYS = 'accessExpiresAt,accessToken,refreshExpiresAt,refreshToken';

function refuse(): never { throw new Error('SHOPIFY_VAULT_REFUSED'); }
function instant(v: unknown): boolean { return typeof v === 'string' && INSTANT.test(v) && new Date(v).toISOString() === v; }
function credentialOk(value: unknown): value is ShopifyCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(',') === KEYS && typeof row.accessToken === 'string' && TOKEN.test(row.accessToken)
    && typeof row.refreshToken === 'string' && TOKEN.test(row.refreshToken) && instant(row.accessExpiresAt) && instant(row.refreshExpiresAt);
}
function aad(binding: ShopifyCredentialBinding, keyId: string): Buffer {
  return Buffer.from(`hon-shopify-credential:v1:${keyId}:${binding.connectionId.toLowerCase()}:${binding.shopDomain}`, 'utf8');
}

export class ShopifyVault {
  constructor(private readonly key: Buffer, readonly keyId: string) {
    if (key.length !== 32 || !KEY_ID.test(keyId)) refuse();
  }

  seal(binding: ShopifyCredentialBinding, credential: ShopifyCredential): string {
    if (!credentialOk(credential)) refuse();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(aad(binding, this.keyId));
    const body = Buffer.concat([cipher.update(JSON.stringify({ accessToken: credential.accessToken, refreshToken: credential.refreshToken,
      accessExpiresAt: credential.accessExpiresAt, refreshExpiresAt: credential.refreshExpiresAt }), 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
  }

  open(binding: ShopifyCredentialBinding, keyId: string, sealed: string): ShopifyCredential {
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

/** The configured vault (HON_SHOPIFY_VAULT_KEY: 32 bytes base64, HON_SHOPIFY_VAULT_KEY_ID), or null. */
export function shopifyVaultFromEnvironment(env: Record<string, string | undefined>): ShopifyVault | null {
  const encoded = env.HON_SHOPIFY_VAULT_KEY ?? '', keyId = env.HON_SHOPIFY_VAULT_KEY_ID ?? '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded) || !KEY_ID.test(keyId)) return null;
  const key = Buffer.from(encoded, 'base64');
  return key.length === 32 ? new ShopifyVault(key, keyId) : null;
}

/** A random per-process vault for the fake only (fake tokens are synthetic and lost on restart). */
export function ephemeralShopifyVault(): ShopifyVault { return new ShopifyVault(randomBytes(32), 'fake-ephemeral'); }
