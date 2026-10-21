import { Allow } from 'class-validator';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import {
  CRM_GUARDIAN_CHILD_ADDITION_COMMAND, CRM_GUARDIAN_CHILD_ENROLLMENT_READ_COMMAND, CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_COMMAND,
  CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_COMMAND, CRM_LEAD_REGISTRATION_UUID, validateCrmGuardianChildAdditionInput, validateCrmGuardianChildEnrollmentReadInput,
  validateCrmGuardianChildMembershipDraftFromPlanInput, validateCrmGuardianChildPayerDesignationInput,
} from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
import { assertDirectHumanBillingAccountRequest } from '../billing/billing-account-human-ui.guard.js';

/** Closed empty body: the lead id in the path is the only selector. */
export class CrmGuardianChildEnrollmentReadDto {}
export class CrmGuardianChildPayerDesignationDto { @Allow() declare confirmation: string; }
export class CrmGuardianChildAdditionDto {
  @Allow() declare childGivenName: string;
  @Allow() declare childFamilyName: string;
  @Allow() declare childBirthDate: string;
  @Allow() declare confirmation: string;
}
export class CrmGuardianChildMembershipDraftFromPlanDto {
  @Allow() declare studentProfileId: string;
  @Allow() declare membershipPlanId: string;
  @Allow() declare membershipPlanVersion: number;
  @Allow() declare termStartedAt?: string;
  @Allow() declare confirmation: string;
}

/**
 * Direct-human transport for guardian/child enrollment: no query, no contextual authority, same-origin Fetch
 * Metadata, one closed X-HON-Human-Command marker per route, JSON only, no-store responses. Commands require a UUID
 * Idempotency-Key; the read refuses one. Authority is still decided in PostgreSQL.
 */
@Injectable()
export class CrmGuardianChildEnrollmentReadHumanUiGuard extends CurriculumHumanUiGuard {
  protected override readonly command: string = CRM_GUARDIAN_CHILD_ENROLLMENT_READ_COMMAND;
  protected readonly read: boolean = true;
  protected readonly invalidCode: string = 'INVALID_CRM_GUARDIAN_CHILD_ENROLLMENT_INPUT';
  protected validate(value: unknown): void { validateCrmGuardianChildEnrollmentReadInput(value); }
  override canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    const res = context.switchToHttp().getResponse();
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (Object.keys(req.query ?? {}).length || req.originalUrl?.includes('?')) throw new BadRequestException({ code: 'CRM_GUARDIAN_CHILD_SELECTORS_NOT_ACCEPTED' });
    assertDirectHumanBillingAccountRequest(req);
    if (req.method !== 'POST' || Object.keys(req.headers).some(key => key.toLowerCase().startsWith('x-hon-') && key.toLowerCase() !== 'x-hon-human-command')
      || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-mode'] !== 'same-origin'
      || req.headers['sec-fetch-dest'] !== 'empty' || req.headers['sec-fetch-user'] !== undefined
      || typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    super.canActivate(context);
    const key = req.headers['idempotency-key'];
    if (this.read && key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    if (!this.read && (typeof key !== 'string' || !CRM_LEAD_REGISTRATION_UUID.test(key))) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    try { this.validate(req.body); } catch { throw new BadRequestException({ code: this.invalidCode }); }
    return true;
  }
}
@Injectable()
export class CrmGuardianChildPayerDesignationHumanUiGuard extends CrmGuardianChildEnrollmentReadHumanUiGuard {
  protected override readonly command = CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_COMMAND;
  protected override readonly read = false;
  protected override validate(value: unknown): void { validateCrmGuardianChildPayerDesignationInput(value); }
}
@Injectable()
export class CrmGuardianChildAdditionHumanUiGuard extends CrmGuardianChildEnrollmentReadHumanUiGuard {
  protected override readonly command = CRM_GUARDIAN_CHILD_ADDITION_COMMAND;
  protected override readonly read = false;
  protected override validate(value: unknown): void { validateCrmGuardianChildAdditionInput(value); }
}
@Injectable()
export class CrmGuardianChildMembershipDraftFromPlanHumanUiGuard extends CrmGuardianChildEnrollmentReadHumanUiGuard {
  protected override readonly command = CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_COMMAND;
  protected override readonly read = false;
  protected override validate(value: unknown): void { validateCrmGuardianChildMembershipDraftFromPlanInput(value); }
}
