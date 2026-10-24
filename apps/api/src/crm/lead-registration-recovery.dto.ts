import { BadRequestException, ConflictException, ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import { CRM_LEAD_REGISTRATION_RECOVERY_COMMAND, validateCrmLeadRegistrationRecoveryInput } from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';

/** Closed empty body: no student, receipt, account, membership, actor or scope selector is accepted. */
export class CrmLeadRegistrationRecoveryDto {}

/** Separate direct-human read marker; a read never carries an Idempotency-Key and confers no authority. */
@Injectable()
export class LeadRegistrationRecoveryHumanUiGuard extends CurriculumHumanUiGuard {
  protected override readonly command = CRM_LEAD_REGISTRATION_RECOVERY_COMMAND;
  override canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    const res = context.switchToHttp().getResponse();
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (Object.keys(req.query ?? {}).length || req.originalUrl?.includes('?')) throw new BadRequestException({ code: 'REGISTRATION_SELECTORS_NOT_ACCEPTED' });
    const contextual = ['honContext','honCommandContext','commandContext','actionContext','principalType','source','actionRequestId','delegatedByPrincipalId'];
    if (contextual.some(key => Object.hasOwn(req, key)) || req.honIdentity && Object.keys(req.honIdentity).some(key => !['externalSubject','displayName','email'].includes(key))) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    if (req.method !== 'POST' || Object.keys(req.headers).some(key => key.toLowerCase().startsWith('x-hon-') && key.toLowerCase() !== 'x-hon-human-command')
      || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-mode'] !== 'same-origin' || req.headers['sec-fetch-dest'] !== 'empty' || req.headers['sec-fetch-user'] !== undefined
      || typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    super.canActivate(context);
    if (req.headers['idempotency-key'] !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    try { validateCrmLeadRegistrationRecoveryInput(req.body); } catch { throw new BadRequestException({ code: 'INVALID_CRM_LEAD_REGISTRATION_RECOVERY_INPUT' }); }
    return true;
  }
}
