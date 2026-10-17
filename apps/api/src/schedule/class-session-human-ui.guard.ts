import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import type { HonRequest } from '../foundation/hon-identity.service.js';

const AUTHORITY_HEADERS = new Set([
  'authorization', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto',
  'x-real-ip', 'x-original-url', 'x-rewrite-url', 'x-subject', 'x-user-id', 'x-principal-id',
  'x-organization-id', 'x-school-id', 'x-role', 'x-tier', 'x-source',
  'x-delegated-by-principal-id', 'x-action-request-id',
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Browser transport boundary only. Canonical scope resolution and service/RLS
 * authorization remain independent and authoritative for the mutation itself.
 */
@Injectable()
export class ClassSessionHumanUiGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<HonRequest>();
    http.getResponse()?.setHeader?.('Cache-Control', 'private, no-store');

    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { /* fail closed */ }
    if (!origin) throw new ServiceUnavailableException({ code: 'HUMAN_UI_ORIGIN_NOT_CONFIGURED' });

    const headers = request.headers;
    const unexpectedHonHeader = Object.keys(headers).some((header) =>
      header.toLowerCase().startsWith('x-hon-') && header.toLowerCase() !== 'x-hon-human-command');
    const authorityHeader = Object.keys(headers).some((header) => AUTHORITY_HEADERS.has(header.toLowerCase()));
    const hasSelector = Object.keys(request.query ?? {}).length > 0 || request.originalUrl?.includes('?');
    const json = typeof headers['content-type'] === 'string'
      && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers['content-type']);

    if (hasSelector) throw new BadRequestException({ code: 'CLASS_SESSION_SELECTORS_NOT_ACCEPTED' });
    if (request.method !== 'POST'
      || headers.origin !== origin
      || headers['x-hon-human-command'] !== 'class-session'
      || headers['sec-fetch-site'] !== 'same-origin'
      || headers['sec-fetch-mode'] !== 'same-origin'
      || headers['sec-fetch-dest'] !== 'empty'
      || headers['sec-fetch-user'] !== undefined
      || !json
      || typeof headers['idempotency-key'] !== 'string'
      || !UUID_V4.test(headers['idempotency-key'])
      || unexpectedHonHeader
      || authorityHeader) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    return true;
  }
}
