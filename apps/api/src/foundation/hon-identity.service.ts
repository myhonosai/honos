import { ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthConfigurationError, HON_SESSION_COOKIE, bearerToken, cookieValue, sessionConfig, verifyMobileSession, verifySession, type NormalizedIdentity } from '@hon/auth';
import type { Request } from 'express';

export type AuthenticatedIdentity = NormalizedIdentity;
/** WEB = browser cookie session. MOBILE = native parent app bearer session (M2). */
export type HonChannel = 'WEB' | 'MOBILE';
export type HonRequest = Request & { honIdentity?: AuthenticatedIdentity; honChannel?: HonChannel };

/** Native parent app sessions reach only family-facing routes; staff and HQ stay browser-only until reviewed. */
const MOBILE_ROUTES = /^\/v1\/(?:parent|me|auth\/mobile)\//;

@Injectable()
export class HonIdentityService {
  authenticate(request: Request): AuthenticatedIdentity {
    let channel: HonChannel;
    let identity: AuthenticatedIdentity;
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
        identity = verifyMobileSession(bearer, config);
      }
    } catch (error) {
      if (error instanceof AuthConfigurationError) throw new ServiceUnavailableException('HON application session validation is not configured.');
      if (error instanceof UnauthorizedException) throw error;
      // Never attach the original JWT/provider error, request, cookie, or authorization header.
      throw new UnauthorizedException('HON could not validate the application session.');
    }
    if (channel === 'MOBILE' && !MOBILE_ROUTES.test(new URL(request.originalUrl ?? request.url ?? '/', 'http://hon.invalid').pathname)) {
      throw new ForbiddenException({ code: 'MOBILE_SESSION_SCOPE', detail: 'This route is not available to the HON Parent app.' });
    }
    (request as HonRequest).honChannel = channel;
    return identity;
  }
}
