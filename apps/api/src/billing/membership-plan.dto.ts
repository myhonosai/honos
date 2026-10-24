import { Allow } from 'class-validator';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import {
  CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_COMMAND, CRM_ADULT_MEMBERSHIP_DRAFT_UUID, CRM_ADULT_MEMBERSHIP_PLAN_OPTIONS_COMMAND, MEMBERSHIP_PLAN_CATALOG_READ_COMMAND,
  MEMBERSHIP_PLAN_CREATE_COMMAND, MEMBERSHIP_PLAN_REVISE_COMMAND, validateCreateMembershipPlanInput, validateCrmAdultMembershipDraftFromPlanInput,
  validateMembershipPlanReadInput, validateReviseMembershipPlanInput,
} from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
import { assertDirectHumanBillingAccountRequest } from './billing-account-human-ui.guard.js';

/** Closed empty body: reads accept no plan, program, actor or scope selector. */
export class MembershipPlanReadDto {}
class MembershipPlanTermsDto {
  @Allow() declare displayName: string;
  @Allow() declare description?: string | null;
  @Allow() declare programId?: string | null;
  @Allow() declare availability: string;
  @Allow() declare currency: string;
  @Allow() declare priceMinor: number;
  @Allow() declare billingFrequency: string;
  @Allow() declare termKind: string;
  @Allow() declare termMonths?: number | null;
  @Allow() declare confirmation: string;
}
export class CreateMembershipPlanDto extends MembershipPlanTermsDto { @Allow() declare planCode: string; }
export class ReviseMembershipPlanDto extends MembershipPlanTermsDto { @Allow() declare expectedVersion: number; }
export class CrmAdultMembershipDraftFromPlanDto {
  @Allow() declare studentProfileId: string;
  @Allow() declare membershipPlanId: string;
  @Allow() declare membershipPlanVersion: number;
  @Allow() declare termStartedAt?: string;
  @Allow() declare confirmation: string;
}

/**
 * Direct-human transport for the plan catalog and the plan-bound adult DRAFT: no query, no contextual
 * authority, same-origin Fetch Metadata, one closed X-HON-Human-Command marker per route, JSON only.
 * Commands require a UUID Idempotency-Key; reads refuse one. Authority is still decided in PostgreSQL.
 */
@Injectable()
export class MembershipPlanCreateHumanUiGuard extends CurriculumHumanUiGuard {
  protected override readonly command: string = MEMBERSHIP_PLAN_CREATE_COMMAND;
  protected readonly read: boolean = false;
  protected readonly invalidCode: string = 'INVALID_MEMBERSHIP_PLAN_INPUT';
  protected validate(value: unknown): void { validateCreateMembershipPlanInput(value); }
  override canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    if (Object.keys(req.query ?? {}).length || req.originalUrl?.includes('?')) throw new BadRequestException({ code: 'MEMBERSHIP_PLAN_SELECTORS_NOT_ACCEPTED' });
    assertDirectHumanBillingAccountRequest(req);
    if (req.method !== 'POST' || Object.keys(req.headers).some(key => key.toLowerCase().startsWith('x-hon-') && key.toLowerCase() !== 'x-hon-human-command')
      || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-mode'] !== 'same-origin'
      || req.headers['sec-fetch-dest'] !== 'empty' || req.headers['sec-fetch-user'] !== undefined
      || typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    super.canActivate(context);
    const key = req.headers['idempotency-key'];
    if (this.read && key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    if (!this.read && (typeof key !== 'string' || !CRM_ADULT_MEMBERSHIP_DRAFT_UUID.test(key))) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    try { this.validate(req.body); } catch { throw new BadRequestException({ code: this.invalidCode }); }
    return true;
  }
}
@Injectable()
export class MembershipPlanReviseHumanUiGuard extends MembershipPlanCreateHumanUiGuard {
  protected override readonly command = MEMBERSHIP_PLAN_REVISE_COMMAND;
  protected override validate(value: unknown): void { validateReviseMembershipPlanInput(value); }
}
@Injectable()
export class MembershipPlanCatalogHumanUiGuard extends MembershipPlanCreateHumanUiGuard {
  protected override readonly command = MEMBERSHIP_PLAN_CATALOG_READ_COMMAND;
  protected override readonly read = true;
  protected override validate(value: unknown): void { validateMembershipPlanReadInput(value); }
}
@Injectable()
export class CrmAdultMembershipPlanOptionsHumanUiGuard extends MembershipPlanCreateHumanUiGuard {
  protected override readonly command = CRM_ADULT_MEMBERSHIP_PLAN_OPTIONS_COMMAND;
  protected override readonly read = true;
  protected override validate(value: unknown): void { validateMembershipPlanReadInput(value); }
}
@Injectable()
export class CrmAdultMembershipDraftFromPlanHumanUiGuard extends MembershipPlanCreateHumanUiGuard {
  protected override readonly command = CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_COMMAND;
  protected override readonly invalidCode = 'INVALID_CRM_ADULT_MEMBERSHIP_INPUT';
  protected override validate(value: unknown): void { validateCrmAdultMembershipDraftFromPlanInput(value); }
}
