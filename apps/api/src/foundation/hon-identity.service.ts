import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthConfigurationError, HON_SESSION_COOKIE, cookieValue, sessionConfig, verifySession, type NormalizedIdentity } from '@hon/auth';
import type { Request } from 'express';

export type AuthenticatedIdentity = NormalizedIdentity;
export type HonRequest = Request & { honIdentity?: AuthenticatedIdentity };

@Injectable()
export class HonIdentityService {
  authenticate(request: Request): AuthenticatedIdentity {
    try {
      const config = sessionConfig();
      const token = cookieValue(request.headers.cookie, HON_SESSION_COOKIE);
      if (!token) throw new UnauthorizedException('HON requires an authenticated application session.');
      return verifySession(token, config);
    } catch (error) {
      if (error instanceof AuthConfigurationError) throw new ServiceUnavailableException('HON application session validation is not configured.');
      // Never attach the original JWT/provider error, request, cookie, or authorization header.
      throw new UnauthorizedException('HON could not validate the application session.');
    }
  }
}
