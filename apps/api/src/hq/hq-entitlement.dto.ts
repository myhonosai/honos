import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import { hqEntitlementUuid, validateHqEntitlementTransitionInput, type HqEntitlementTier } from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';

export class HqEntitlementTransitionDto { declare targetTier: HqEntitlementTier; declare expectedVersion: number }
export function assertHqEntitlementHumanRequest(req: HonRequest): void {
  const contextual = ['honContext','honCommandContext','commandContext','actionContext','principalType','source','actionRequestId','delegatedByPrincipalId','organizationId','schoolId','familyId'];
  if (contextual.some(key => Object.hasOwn(req,key))
    || req.honIdentity && Object.keys(req.honIdentity).some(key => !['externalSubject','displayName','email'].includes(key))) {
    throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  }
}
@Injectable()
export class HqEntitlementHumanUiGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    context.switchToHttp().getResponse().setHeader('Cache-Control','private, no-store');
    assertHqEntitlementHumanRequest(req);
    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { /* fail closed */ }
    if (!origin) throw new ServiceUnavailableException({ code: 'HUMAN_UI_ORIGIN_NOT_CONFIGURED' });
    if (req.method !== 'PATCH' || req.headers.origin !== origin || req.headers['x-hon-human-command'] !== 'hq-entitlement-transition'
      || Object.keys(req.headers).some(key => key.toLowerCase().startsWith('x-hon-') && key.toLowerCase() !== 'x-hon-human-command')
      || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-mode'] !== 'same-origin'
      || req.headers['sec-fetch-dest'] !== 'empty' || req.headers['sec-fetch-user'] !== undefined
      || typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    if (Object.keys(req.query ?? {}).length || req.originalUrl?.includes('?')) throw new BadRequestException({ code: 'INVALID_HQ_ENTITLEMENT_INPUT' });
    try {
      hqEntitlementUuid(req.params.organizationId); hqEntitlementUuid(req.headers['idempotency-key']);
      validateHqEntitlementTransitionInput(req.body);
    } catch { throw new BadRequestException({ code: 'INVALID_HQ_ENTITLEMENT_INPUT' }); }
    return true;
  }
}
