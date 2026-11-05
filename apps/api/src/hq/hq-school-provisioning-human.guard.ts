import { BadRequestException, ConflictException, ForbiddenException, Injectable, ServiceUnavailableException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { assertHqEntitlementHumanRequest } from './hq-entitlement.dto.js';

export const HQ_SCHOOL_PROVISIONING_COMMAND = 'hq-school-provisioning';
export const HQ_EXPECTED_PRINCIPAL_HEADER = 'x-hon-expected-principal';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Direct-human gate for HQ school creation. Runs before HonIdentityGuard: only a same-origin browser POST from the
 * configured HON origin, carrying the screen's command marker, a UUID idempotency key and the HQ principal the screen
 * verified, reaches the database. Delegated, agent, action and tenant/family context is refused.
 */
@Injectable()
export class HqSchoolProvisioningHumanGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    const res = context.switchToHttp().getResponse();
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    assertHqEntitlementHumanRequest(req);
    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { /* fail closed */ }
    if (!origin) throw new ServiceUnavailableException({ code: 'HUMAN_UI_ORIGIN_NOT_CONFIGURED' });
    const allowed = new Set(['x-hon-human-command', HQ_EXPECTED_PRINCIPAL_HEADER]);
    if (req.method !== 'POST' || req.headers.authorization !== undefined || req.headers.origin !== origin
      || Object.keys(req.headers).some(key => key.toLowerCase().startsWith('x-hon-') && !allowed.has(key.toLowerCase()))
      || req.headers['x-hon-human-command'] !== HQ_SCHOOL_PROVISIONING_COMMAND
      || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-mode'] !== 'same-origin'
      || req.headers['sec-fetch-dest'] !== 'empty' || req.headers['sec-fetch-user'] !== undefined
      || typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    if (Object.keys(req.query ?? {}).length || req.originalUrl?.includes('?')) throw new BadRequestException({ code: 'HQ_PROVISIONING_INPUT_INVALID' });
    const expected = req.headers[HQ_EXPECTED_PRINCIPAL_HEADER];
    if (typeof expected !== 'string' || !UUID.test(expected)) throw new BadRequestException({ code: 'HQ_EXPECTED_PRINCIPAL_REQUIRED' });
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !UUID.test(key)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique UUID Idempotency-Key header is required for tenant provisioning.' });
    return true;
  }
}
