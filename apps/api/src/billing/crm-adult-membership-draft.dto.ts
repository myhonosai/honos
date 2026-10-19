import { Allow } from 'class-validator';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import { CRM_ADULT_MEMBERSHIP_DRAFT_UUID, validateCrmAdultMembershipDraftInput, validateCrmAdultMembershipPreparationInput } from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
import { assertDirectHumanBillingAccountRequest } from './billing-account-human-ui.guard.js';

export class CrmAdultMembershipPreparationDto { @Allow() declare studentProfileId: string; }
export class CrmAdultMembershipDraftDto extends CrmAdultMembershipPreparationDto {
  @Allow() declare planCode: string;
  @Allow() declare termStartedAt?: string;
  @Allow() declare termEndsAt?: string;
  @Allow() declare confirmation: 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT';
}
@Injectable()
export class CrmAdultMembershipNoStoreGuard {
  canActivate(context: ExecutionContext): boolean {
    const res = context.switchToHttp().getResponse();
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return true;
  }
}
/** Separate closed marker and Fetch Metadata boundary; never the generic membership route. */
@Injectable()
export class CrmAdultMembershipDraftHumanUiGuard extends CurriculumHumanUiGuard {
  protected override readonly command: string = 'crm-adult-membership-draft';
  protected readonly preparation: boolean = false;
  override canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    if (Object.keys(req.query ?? {}).length || req.originalUrl?.includes('?')) throw new BadRequestException({ code: 'MEMBERSHIP_SELECTORS_NOT_ACCEPTED' });
    assertDirectHumanBillingAccountRequest(req);
    if (req.method !== 'POST' || Object.keys(req.headers).some(key => key.toLowerCase().startsWith('x-hon-') && key.toLowerCase() !== 'x-hon-human-command')
      || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-mode'] !== 'same-origin'
      || req.headers['sec-fetch-dest'] !== 'empty' || req.headers['sec-fetch-user'] !== undefined
      || typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    super.canActivate(context);
    const key = req.headers['idempotency-key'];
    if (this.preparation ? key !== undefined : typeof key !== 'string' || !CRM_ADULT_MEMBERSHIP_DRAFT_UUID.test(key)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    try { this.preparation ? validateCrmAdultMembershipPreparationInput(req.body) : validateCrmAdultMembershipDraftInput(req.body); }
    catch { throw new BadRequestException({ code: 'INVALID_CRM_ADULT_MEMBERSHIP_INPUT' }); }
    return true;
  }
}
@Injectable()
export class CrmAdultMembershipPreparationHumanUiGuard extends CrmAdultMembershipDraftHumanUiGuard {
  protected override readonly command = 'crm-adult-membership-prepare';
  protected override readonly preparation = true;
}
