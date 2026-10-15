import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import type { Request } from 'express';
/** CSRF boundary, not a claim that a browser header proves legal identity or human presence. */
@Injectable()
export class DocumentHumanUiGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.method === 'GET') return true;
    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { /* fail closed */ }
    if (!origin) throw new ServiceUnavailableException({ code: 'HUMAN_UI_ORIGIN_NOT_CONFIGURED', detail: 'Configure HON_PUBLIC_ORIGIN for sensitive document UI commands.' });
    if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['x-hon-human-command'] !== 'document-acknowledgement'
      || request.headers['sec-fetch-site'] === 'cross-site' || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED', detail: 'Same-origin human UI JSON commands only.' });
    return true;
  }
}
