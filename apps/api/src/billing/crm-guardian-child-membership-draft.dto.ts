import { Allow } from 'class-validator';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import {
  CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID,
  validateCrmGuardianChildMembershipDraftConfirmationInput,
  validateCrmGuardianChildMembershipDraftInput,
  validateCrmGuardianChildMembershipPreparationInput,
  validateCrmGuardianChildPayerDesignationInput,
  validateCrmGuardianChildPayerDesignationPreparationInput,
} from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
import { assertDirectHumanBillingAccountRequest } from './billing-account-human-ui.guard.js';

export class CrmGuardianChildPayerDesignationPreparationDto { @Allow() declare studentProfileId: string; }
export class CrmGuardianChildPayerDesignationDto extends CrmGuardianChildPayerDesignationPreparationDto {
  @Allow() declare confirmation: 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_PAYER_DESIGNATION';
}
export class CrmGuardianChildMembershipPreparationDto { @Allow() declare studentProfileId: string; }
/** Kept distinct even though its closed request is currently one opaque selector. */
export class CrmGuardianChildMembershipDraftConfirmationDto { @Allow() declare studentProfileId: string; }
export class CrmGuardianChildMembershipDraftDto extends CrmGuardianChildMembershipPreparationDto {
  @Allow() declare planCode: string;
  @Allow() declare termStartedAt?: string;
  @Allow() declare termEndsAt?: string;
  @Allow() declare confirmation: 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_CRM_MEMBERSHIP_DRAFT';
}

@Injectable()
export class CrmGuardianChildMembershipNoStoreGuard {
  canActivate(context: ExecutionContext): boolean {
    const response = context.switchToHttp().getResponse();
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return true;
  }
}

/** Dedicated transport boundary: no generic membership or billing-account command can satisfy these routes. */
@Injectable()
export class CrmGuardianChildMembershipHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command: string = 'crm-guardian-child-membership-draft';
  protected readonly read: boolean = false;
  protected validate(value: unknown): void { validateCrmGuardianChildMembershipDraftInput(value); }

  override canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HonRequest>();
    if (Object.keys(request.query ?? {}).length || request.originalUrl?.includes('?')) {
      throw new BadRequestException({ code: 'MEMBERSHIP_SELECTORS_NOT_ACCEPTED' });
    }
    assertDirectHumanBillingAccountRequest(request);
    if (request.method !== 'POST'
      || Object.keys(request.headers).some(key => key.toLowerCase().startsWith('x-hon-') && key.toLowerCase() !== 'x-hon-human-command')
      || request.headers['sec-fetch-site'] !== 'same-origin'
      || request.headers['sec-fetch-mode'] !== 'same-origin'
      || request.headers['sec-fetch-dest'] !== 'empty'
      || request.headers['sec-fetch-user'] !== undefined
      || typeof request.headers['content-type'] !== 'string'
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'])) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    super.canActivate(context);
    const idempotencyKey = request.headers['idempotency-key'];
    if (this.read ? idempotencyKey !== undefined : typeof idempotencyKey !== 'string' || !CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID.test(idempotencyKey)) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    try { this.validate(request.body); }
    catch { throw new BadRequestException({ code: 'INVALID_CRM_GUARDIAN_CHILD_MEMBERSHIP_INPUT' }); }
    return true;
  }
}

@Injectable()
export class CrmGuardianChildPayerDesignationHumanUiGuard extends CrmGuardianChildMembershipHumanUiGuard {
  protected override readonly command = 'crm-guardian-child-payer-designation';
  protected override validate(value: unknown): void { validateCrmGuardianChildPayerDesignationInput(value); }
}
@Injectable()
export class CrmGuardianChildPayerDesignationPreparationHumanUiGuard extends CrmGuardianChildMembershipHumanUiGuard {
  protected override readonly command = 'crm-guardian-child-payer-designation-prepare';
  protected override readonly read = true;
  protected override validate(value: unknown): void { validateCrmGuardianChildPayerDesignationPreparationInput(value); }
}
@Injectable()
export class CrmGuardianChildMembershipPreparationHumanUiGuard extends CrmGuardianChildMembershipHumanUiGuard {
  protected override readonly command = 'crm-guardian-child-membership-prepare';
  protected override readonly read = true;
  protected override validate(value: unknown): void { validateCrmGuardianChildMembershipPreparationInput(value); }
}
@Injectable()
export class CrmGuardianChildMembershipConfirmationHumanUiGuard extends CrmGuardianChildMembershipHumanUiGuard {
  protected override readonly command = 'crm-guardian-child-membership-confirmation';
  protected override readonly read = true;
  protected override validate(value: unknown): void { validateCrmGuardianChildMembershipDraftConfirmationInput(value); }
}
