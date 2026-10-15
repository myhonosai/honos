import { Allow } from 'class-validator';
import { Injectable, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { StaffRevisionInput } from '@hon/contracts';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
export class StaffAvailabilityRevisionDto implements StaffRevisionInput {
  @Allow() declare expectedVersion: number;
  @Allow() declare status: 'ACTIVE' | 'ENDED';
  @Allow() declare effectiveFrom: string;
  @Allow() declare endsOn: string | null;
  @Allow() declare windows?: NonNullable<StaffRevisionInput['windows']>;
  @Allow() declare qualifications?: NonNullable<StaffRevisionInput['qualifications']>;
}
@Injectable()
export class StaffAvailabilityHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command: string = 'staff-availability';
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ method: string; headers: Record<string, unknown> }>();
    const site = request.headers['sec-fetch-site'];
    if (request.method !== 'GET' && site !== undefined && site !== 'same-origin') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    return super.canActivate(context);
  }
}
