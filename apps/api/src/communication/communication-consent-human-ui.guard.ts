import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import type { Request } from 'express';

/** The exact human-command marker the staff People screen sends with a consent record. */
export const COMMUNICATION_CONSENT_HUMAN_COMMAND = 'communication.consent.record';
const DELEGATION_HEADERS = ['x-hon-source', 'x-hon-action-request-id', 'x-hon-delegated-by-principal-id'] as const;

/**
 * Consent evidence is recorded only by a person at the school's own web app: a same-origin PUT from the public origin
 * carrying the exact marker, JSON, and no source or delegation selector. The read is a GET that refuses the same
 * selectors. An agent, automation or other site cannot record consent through this route.
 */
@Injectable()
export class CommunicationConsentHumanUiGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const headers = request.headers;
    if (DELEGATION_HEADERS.some((key) => headers[key] !== undefined)
      || (headers['sec-fetch-site'] !== undefined && headers['sec-fetch-site'] !== 'same-origin')) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    if (request.method === 'GET') return true;
    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { /* fail closed */ }
    if (!origin) throw new ServiceUnavailableException({ code: 'HUMAN_UI_ORIGIN_NOT_CONFIGURED' });
    if (request.method !== 'PUT' || headers.origin !== origin || headers['x-hon-human-command'] !== COMMUNICATION_CONSENT_HUMAN_COMMAND
      || !/^application\/json(?:\s*;|$)/i.test(headers['content-type'] ?? '')) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    return true;
  }
}
