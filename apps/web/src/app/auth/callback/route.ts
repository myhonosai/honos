import { AUTH_TRANSACTION_COOKIE, HON_SESSION_COOKIE, MANUS_SESSION_COOKIE, SESSION_SECONDS, AuthConfigurationError, AuthValidationError, callbackParameters, cookieValue, exchangeManusCode, exchangeOidcCode, issueManusSession, issueSession, manusState, verifyTransaction, type ManusConfig, type OidcConfig } from '@hon/auth';
import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE, authError, cookieOptions, redirectUri, webAuthConfig } from '../../../server/auth-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  let callback = 'https://invalid.example/auth/callback';
  const finish = (response: NextResponse): NextResponse => {
    response.cookies.set(AUTH_TRANSACTION_COOKIE, '', { ...cookieOptions(callback, '/auth'), maxAge: 0 });
    response.cookies.set('hon_oauth_nonce', '', { ...cookieOptions(callback), maxAge: 0 });
    return response;
  };
  let config: ManusConfig | OidcConfig;
  let code: string;
  let transaction: ReturnType<typeof verifyTransaction>;
  try {
    config = webAuthConfig();
    callback = redirectUri(request, config);
    const url = new URL(request.url);
    const parameters = callbackParameters(url);
    if (config.mode === 'OIDC' && (url.searchParams.getAll('iss').length > 1 || url.searchParams.has('iss') && url.searchParams.get('iss') !== config.issuer)) throw new AuthValidationError();
    code = parameters.code;
    const state = config.mode === 'OIDC' ? parameters.state : manusState(parameters.state, callback);
    transaction = verifyTransaction(cookieValue(request.headers.get('cookie'), AUTH_TRANSACTION_COOKIE), state, callback, config);
  } catch (error) {
    return finish(error instanceof AuthConfigurationError
      ? authError('IDENTITY_NOT_CONFIGURED', 'HON authentication is not configured. Contact the application operator.', 503)
      : authError('OAUTH_STATE_INVALID', 'HON rejected an invalid or unbound sign-in request. Return to /auth/login and try again.', 400));
  }
  try {
    // This discriminated branch prevents any Manus environment lookup or network dependency in OIDC mode.
    const identity = config.mode === 'OIDC' ? await exchangeOidcCode(code, transaction, config) : await exchangeManusCode(code, transaction, config);
    const response = NextResponse.redirect(new URL('/hq', callback), { headers: NO_STORE });
    response.cookies.set(HON_SESSION_COOKIE, issueSession(identity, config), { ...cookieOptions(callback), maxAge: SESSION_SECONDS });
    if (config.mode === 'MANUS_DEVELOPMENT') {
      response.cookies.set(MANUS_SESSION_COOKIE, issueManusSession(identity, config), { ...cookieOptions(callback), maxAge: SESSION_SECONDS });
    } else {
      response.cookies.set(MANUS_SESSION_COOKIE, '', { ...cookieOptions(callback), maxAge: 0 });
    }
    return finish(response);
  } catch {
    return finish(authError('OAUTH_IDENTITY_UNAVAILABLE', 'HON could not verify the account. Return to /auth/login and try again.', 503));
  }
}
