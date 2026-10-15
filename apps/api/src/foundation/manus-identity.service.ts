import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { verify, type JwtPayload } from 'jsonwebtoken';

export interface AuthenticatedIdentity {
  externalSubject: string;
}

export type HonRequest = Request & { honIdentity?: AuthenticatedIdentity };

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const entry of cookieHeader.split(';')) {
    const [key, ...rawValue] = entry.trim().split('=');
    if (key === name) return decodeURIComponent(rawValue.join('='));
  }
  return undefined;
}

@Injectable()
export class ManusIdentityService {
  authenticate(request: Request): AuthenticatedIdentity {
    const token = cookieValue(request.headers.cookie, 'webdev_app_session');
    if (!token) throw new UnauthorizedException('HON requires an authenticated application session.');

    const jwtSecret = process.env.MANUS_JWT_SECRET;
    if (!jwtSecret) {
      throw new ServiceUnavailableException('HON application session validation is not configured.');
    }

    let payload: JwtPayload;
    try {
      payload = verify(token, jwtSecret, { algorithms: ['HS256'] }) as JwtPayload;
    } catch {
      throw new UnauthorizedException('HON could not validate the application session.');
    }

    const expectedApplicationId = process.env.MANUS_PROJECT_ID;
    if (!expectedApplicationId) {
      throw new ServiceUnavailableException('HON application identity configuration is incomplete.');
    }
    const payloadApplicationId = typeof payload.appId === 'string' ? payload.appId : undefined;
    if (payloadApplicationId !== expectedApplicationId) {
      throw new UnauthorizedException('HON rejected a session issued for another application.');
    }

    const externalSubject = typeof payload.openId === 'string'
      ? payload.openId
      : typeof payload.sub === 'string'
        ? payload.sub
        : undefined;
    if (!externalSubject) throw new UnauthorizedException('HON session has no usable identity subject.');

    return { externalSubject };
  }
}
