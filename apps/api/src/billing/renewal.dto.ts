import { Allow } from 'class-validator';
import { Injectable, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { RenewalInput, RenewalStatus } from '@hon/contracts';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
export class RenewalDto implements RenewalInput {
  @Allow() declare expectedVersion: number;
  @Allow() declare membershipId: string;
  @Allow() declare reviewFrom: string;
  @Allow() declare reviewTo: string;
  @Allow() declare status: RenewalStatus;
  @Allow() declare note: string;
  @Allow() declare reason: string;
  @Allow() declare reminderNeeded: boolean | null;
}
@Injectable()
export class RenewalHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command: string = 'billing-renewals';
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ method: string; headers: Record<string, unknown> }>();
    if (req.method !== 'GET' && req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    return super.canActivate(context);
  }
}
