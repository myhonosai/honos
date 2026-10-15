import { authMode, manusConfig, oidcConfig, publicOrigin, type ManusConfig, type OidcConfig } from '@hon/auth';
import { NextRequest, NextResponse } from 'next/server';

export const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
export function webAuthConfig(): ManusConfig | OidcConfig {
  return authMode() === 'OIDC' ? oidcConfig() : manusConfig();
}
export function redirectUri(request: NextRequest, config: ManusConfig | OidcConfig): string {
  return config.mode === 'OIDC' ? config.redirectUri : `${publicOrigin(request.headers)}/auth/callback`;
}
export function cookieOptions(origin = 'https://invalid.example', path = '/') {
  const secure = new URL(origin).protocol === 'https:';
  return { httpOnly: true, secure, sameSite: secure ? 'none' as const : 'lax' as const, path };
}
export function authError(code: string, detail: string, status: number): NextResponse {
  return NextResponse.json({ code, detail }, { status, headers: NO_STORE });
}
