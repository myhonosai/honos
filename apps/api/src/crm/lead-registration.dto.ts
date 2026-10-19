import { Allow } from 'class-validator';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import { CRM_LEAD_REGISTRATION_UUID, validateRegisterCrmLeadInput } from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';

export class RegisterCrmLeadDto {
  @Allow() declare registrationPath: 'ADULT' | 'GUARDIAN_CHILD';
  @Allow() declare confirmation: 'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION';
  @Allow() declare birthDate?: string;
  @Allow() declare childGivenName?: string;
  @Allow() declare childFamilyName?: string;
  @Allow() declare childBirthDate?: string;
}
function assertDirectHumanRegistrationRequest(req: HonRequest): void {
  const contextual = ['honContext','honCommandContext','commandContext','actionContext','principalType','source','actionRequestId','delegatedByPrincipalId'];
  if (contextual.some(key => Object.hasOwn(req,key)) || req.honIdentity && Object.keys(req.honIdentity).some(key => !['externalSubject','displayName','email'].includes(key))) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
}
@Injectable()
export class LeadRegistrationHumanUiGuard extends CurriculumHumanUiGuard {
  protected override readonly command = 'crm-lead-register';
  override canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    context.switchToHttp().getResponse().setHeader('Cache-Control','private, no-store');
    if (Object.keys(req.query ?? {}).length || req.originalUrl?.includes('?')) throw new BadRequestException({ code: 'REGISTRATION_SELECTORS_NOT_ACCEPTED' });
    assertDirectHumanRegistrationRequest(req);
    if (req.method !== 'POST' || Object.keys(req.headers).some(key => key.toLowerCase().startsWith('x-hon-') && key.toLowerCase() !== 'x-hon-human-command')
      || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-mode'] !== 'same-origin' || req.headers['sec-fetch-dest'] !== 'empty' || req.headers['sec-fetch-user'] !== undefined
      || typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    super.canActivate(context);
    const key=req.headers['idempotency-key']; if(typeof key !== 'string' || !CRM_LEAD_REGISTRATION_UUID.test(key)) throw new ConflictException({code:'IDEMPOTENCY_KEY_REQUIRED'});
    try { validateRegisterCrmLeadInput(req.body); } catch { throw new BadRequestException({code:'INVALID_CRM_LEAD_REGISTRATION_INPUT'}); }
    return true;
  }
}
