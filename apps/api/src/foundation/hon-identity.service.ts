import { ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthConfigurationError, HON_SESSION_COOKIE, bearerToken, cookieValue, sessionConfig, verifyMobileSession, verifySession, verifyStaffMobileSession, type NormalizedIdentity } from '@hon/auth';
import type { Request } from 'express';

export type AuthenticatedIdentity = NormalizedIdentity;
/** WEB = browser cookie session. MOBILE = native app bearer session (family app M2, staff app S0). */
export type HonChannel = 'WEB' | 'MOBILE';
/** Which native app the bearer session belongs to. Unset on the web channel. */
export type HonMobileApp = 'FAMILY' | 'STAFF';
export type HonRequest = Request & { honIdentity?: AuthenticatedIdentity; honChannel?: HonChannel; honMobileApp?: HonMobileApp };

/** HON Family app sessions reach only family-facing routes. */
const FAMILY_MOBILE_ROUTES = /^\/v1\/(?:parent|me|auth\/mobile)\//;
/**
 * HON Staff app sessions reach only this explicit allow-list (S0, docs/architecture/STAFF_MOBILE_SIGN_IN.md). Each
 * later phase adds its exact routes in its own reviewed PR. Everything else (organizations, HQ, parent, other staff
 * routes) stays browser-only. Identity only: every route still authorizes school, role and permission itself.
 */
const STAFF_MOBILE_ROUTES: readonly RegExp[] = [
  /^\/v1\/me\/[^/]/,
  /^\/v1\/auth\/mobile\/[^/]/,
  /^\/v1\/staff\/current-reporting-school$/,
  /^\/v1\/staff\/reporting-schools$/,
];

@Injectable()
export class HonIdentityService {
  authenticate(request: Request): AuthenticatedIdentity {
    let channel: HonChannel;
    let identity: AuthenticatedIdentity;
    let app: HonMobileApp | undefined;
    try {
      const config = sessionConfig();
      const cookie = cookieValue(request.headers.cookie, HON_SESSION_COOKIE);
      if (cookie) {
        // Browser path, unchanged: the cookie decides and any Authorization header (e.g. a staging proxy's Basic
        // auth) is ignored. A browser cannot attach a bearer cross-origin anyway: CORS is off.
        channel = 'WEB';
        const { emailVerified: _proof, ...rest } = verifySession(cookie, config);
        identity = rest;
      } else {
        const bearer = bearerToken(request.headers.authorization);
        if (!bearer) throw new UnauthorizedException('HON requires an authenticated application session.');
        channel = 'MOBILE';
        // Family first, then staff: distinct JWT types and audiences, so a token can only ever match one.
        try { identity = verifyMobileSession(bearer, config); app = 'FAMILY'; }
        catch { identity = verifyStaffMobileSession(bearer, config); app = 'STAFF'; }
      }
    } catch (error) {
      if (error instanceof AuthConfigurationError) throw new ServiceUnavailableException('HON application session validation is not configured.');
      if (error instanceof UnauthorizedException) throw error;
      // Never attach the original JWT/provider error, request, cookie, or authorization header.
      throw new UnauthorizedException('HON could not validate the application session.');
    }
    if (channel === 'MOBILE') {
      const mobileApp: HonMobileApp = app === 'STAFF' ? 'STAFF' : 'FAMILY';
      const path = new URL(request.originalUrl ?? request.url ?? '/', 'http://hon.invalid').pathname;
      const allowed = mobileApp === 'STAFF' ? STAFF_MOBILE_ROUTES.some(route => route.test(path)) : FAMILY_MOBILE_ROUTES.test(path);
      if (!allowed) throw new ForbiddenException({ code: 'MOBILE_SESSION_SCOPE', detail: mobileApp === 'STAFF' ? 'This route is not available to the HON Staff app yet.' : 'This route is not available to the HON Parent app.' });
      (request as HonRequest).honMobileApp = mobileApp;
    }
    (request as HonRequest).honChannel = channel;
    return identity;
  }
}
