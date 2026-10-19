import { BadRequestException, ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import type { HonRequest } from '../foundation/hon-identity.service.js';

const AUTHORITY_HEADERS = new Set([
  'authorization', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto',
  'x-real-ip', 'x-original-url', 'x-rewrite-url', 'x-subject', 'x-user-id', 'x-principal-id',
  'x-organization-id', 'x-school-id', 'x-role', 'x-tier', 'x-source',
  'x-delegated-by-principal-id', 'x-action-request-id', 'idempotency-key',
]);

/** Browser transport is strict; controller and fixed database projection reauthorize again. */
@Injectable()
export class CrmIntakeStagesHumanUiGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<HonRequest>();
    http.getResponse()?.setHeader?.('Cache-Control', 'private, no-store');
    http.getResponse()?.setHeader?.('Referrer-Policy', 'no-referrer');
    http.getResponse()?.setHeader?.('X-Robots-Tag', 'noindex, nofollow');

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
      throw new BadRequestException({ code: 'CRM_INTAKE_STAGES_SELECTORS_NOT_ACCEPTED' });
    }
    // Same-origin browser GETs do not send Origin. If a caller does send it,
    // reject a configured cross-origin value, while the custom read header and
    // Fetch Metadata still bind the normal browser transport to this boundary.
    let configuredOrigin: string | undefined;
    if (headers.origin !== undefined) {
      try { configuredOrigin = configuredPublicOrigin(process.env); } catch { /* reject below */ }
    }
    if (request.method !== 'GET' || (headers.origin !== undefined && headers.origin !== configuredOrigin)
      || headers['x-hon-human-read'] !== 'crm-intake-stages'
      || headers['sec-fetch-site'] !== 'same-origin' || headers['sec-fetch-mode'] !== 'same-origin'
      || headers['sec-fetch-dest'] !== 'empty' || headers['sec-fetch-user'] !== undefined
      || unexpectedHonHeader || authorityHeader) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    return true;
  }
}
