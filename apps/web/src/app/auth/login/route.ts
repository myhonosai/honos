import { AUTH_TRANSACTION_COOKIE, TRANSACTION_SECONDS, createTransaction, issueTransaction, manusAuthorizationUrl, oidcAuthorizationUrl } from '@hon/auth';
import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE, authError, cookieOptions, redirectUri, webAuthConfig } from '../../../server/auth-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const config = webAuthConfig();
    const callback = redirectUri(request, config);
    const transaction = createTransaction(callback);
    const authorization = config.mode === 'OIDC' ? oidcAuthorizationUrl(config, transaction) : manusAuthorizationUrl(config, transaction);
    const response = NextResponse.redirect(authorization, { headers: NO_STORE });
    response.cookies.set(AUTH_TRANSACTION_COOKIE, issueTransaction(transaction, config), { ...cookieOptions(callback, '/auth'), maxAge: TRANSACTION_SECONDS });
    return response;
  } catch {
    return authError('IDENTITY_NOT_CONFIGURED', 'HON authentication is not configured. Contact the application operator.', 503);
  }
}
