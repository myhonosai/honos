import { AuthValidationError, type ManusConfig } from './config.js';
import { normalizedIdentity, type NormalizedIdentity } from './session.js';
import { jsonResponse, type AuthFetch } from './oidc.js';
import type { AuthTransaction } from './transaction.js';

export function manusAuthorizationUrl(config: ManusConfig, transaction: AuthTransaction): URL {
  const url = new URL('/app-auth', config.portalUrl);
  url.searchParams.set('appId', config.projectId);
  url.searchParams.set('redirectUri', transaction.redirectUri);
  // Preserve the Manus adapter's state envelope, but the callback binds it to a signed HON transaction.
  url.searchParams.set('state', Buffer.from(JSON.stringify({ redirectUri: transaction.redirectUri, nonce: transaction.state })).toString('base64url'));
  url.searchParams.set('responseType', 'code');
  return url;
}
export function manusState(encoded: string, redirectUri: string): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || !('nonce' in parsed) || typeof parsed.nonce !== 'string' || !('redirectUri' in parsed) || parsed.redirectUri !== redirectUri) throw new Error();
    return parsed.nonce;
  } catch { throw new AuthValidationError(); }
}
export async function exchangeManusCode(code: string, transaction: AuthTransaction, config: ManusConfig, fetcher: AuthFetch = fetch): Promise<NormalizedIdentity> {
  try {
    const post = async (endpoint: string, body: Record<string, string>): Promise<Record<string, unknown>> => jsonResponse(await fetcher(`${config.apiUrl.replace(/\/$/, '')}/webdev.v1.WebDevAuthPublicService/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000), body: JSON.stringify(body) }));
    const tokens = await post('ExchangeToken', { clientId: config.projectId, grantType: 'authorization_code', code, redirectUri: transaction.redirectUri });
    if (typeof tokens.accessToken !== 'string' || !tokens.accessToken) throw new Error();
    const info = await post('GetUserInfo', { accessToken: tokens.accessToken });
    return normalizedIdentity({ externalSubject: info.openId, displayName: info.name, email: info.email });
  } catch { throw new AuthValidationError(); }
}
