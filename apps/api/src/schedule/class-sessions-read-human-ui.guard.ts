import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { forwardedHostMatchesPublicOrigin } from './same-origin-proxy.js';

const AUTHORITY_HEADERS = new Set([
  'authorization', 'forwarded', 'x-forwarded-for', 'x-forwarded-port', 'x-forwarded-proto',
  'x-real-ip', 'x-original-url', 'x-rewrite-url', 'x-subject', 'x-user-id', 'x-principal-id',
  'x-organization-id', 'x-school-id', 'x-role', 'x-tier', 'x-source',
  'x-delegated-by-principal-id', 'x-action-request-id', 'idempotency-key',
]);

/** Browser transport is strict, but database function authorization remains authoritative. */
@Injectable()
export class ClassSessionsReadHumanUiGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<HonRequest>();
    http.getResponse()?.setHeader?.('Cache-Control', 'private, no-store');
    http.getResponse()?.setHeader?.('Referrer-Policy', 'no-referrer');
    http.getResponse()?.setHeader?.('X-Robots-Tag', 'noindex, nofollow');

    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { /* fail closed */ }
    if (!origin) throw new ServiceUnavailableException({ code: 'HUMAN_UI_ORIGIN_NOT_CONFIGURED' });

    const headers = request.headers;
    const hasSelector = Object.keys(request.query ?? {}).length > 0 || request.originalUrl?.includes('?');
    const unexpectedHonHeader = Object.keys(headers).some((header) => {
      const name = header.toLowerCase();
      return name.startsWith('x-hon-') && name !== 'x-hon-human-read';
    });
    const authorityHeader = Object.keys(headers).some((header) => AUTHORITY_HEADERS.has(header.toLowerCase()));
    const hasBody = request.body !== undefined && request.body !== null;
    if (hasSelector || hasBody || headers['transfer-encoding'] !== undefined
      || (headers['content-length'] !== undefined && headers['content-length'] !== '0')) {
      throw new BadRequestException({ code: 'CLASS_SESSIONS_READ_SELECTORS_NOT_ACCEPTED' });
    }
    // Browsers omit Origin on same-origin GET (Fetch standard), so it is optional here but must match when
    // present; the forbidden Sec-Fetch-* metadata plus the custom read header (which forces a CORS preflight
    // Nest never grants) carry the same-origin proof. POST commands still require Origin.
    if (request.method !== 'GET' || (headers.origin !== undefined && headers.origin !== origin)
      || !forwardedHostMatchesPublicOrigin(headers['x-forwarded-host'], origin)
      || headers['x-hon-human-read'] !== 'class-sessions'
      || headers['sec-fetch-site'] !== 'same-origin' || headers['sec-fetch-mode'] !== 'same-origin'
      || headers['sec-fetch-dest'] !== 'empty' || headers['sec-fetch-user'] !== undefined
      || unexpectedHonHeader || authorityHeader) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    return true;
  }
}
