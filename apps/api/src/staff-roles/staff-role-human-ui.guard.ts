import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import type { Request } from 'express';

/** Cookie-authenticated IAM writes are same-origin browser JSON commands only.
 * The marker is CSRF defense, NOT identity/authority; the identity guard and SQL
 * still re-resolve the verified session and live role permissions independently.
 */
@Injectable()
export class StaffRoleHumanUiGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.method === 'GET') return true;
    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { /* fail closed below */ }
    if (!origin) throw new ServiceUnavailableException({ code: 'HUMAN_UI_ORIGIN_NOT_CONFIGURED', detail: 'HON_PUBLIC_ORIGIN must be configured for sensitive staff role UI commands.' });
    if (request.method !== 'POST' || request.headers.origin !== origin
      || request.headers['x-hon-human-command'] !== 'staff-role-admin'
      || request.headers['sec-fetch-site'] === 'cross-site'
      || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED', detail: 'Staff role commands require same-origin human UI JSON requests.' });
    }
    return true;
  }
}
