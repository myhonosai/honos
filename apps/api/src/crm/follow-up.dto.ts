import { Allow } from 'class-validator';
import { Injectable, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { FollowUpInput, FollowUpPriority, FollowUpTransition } from '@hon/contracts';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
export class FollowUpDto implements FollowUpInput {
  @Allow() declare expectedVersion: number;
  @Allow() declare leadId: string;
  @Allow() declare assigneeId: string;
  @Allow() declare subject: string;
  @Allow() declare note: string;
  @Allow() declare dueAt: string | null;
  @Allow() declare priority: FollowUpPriority;
}
export class FollowUpTransitionDto implements FollowUpTransition { @Allow() declare expectedVersion: number; }
@Injectable()
export class FollowUpHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command: string = 'crm-follow-ups';
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ method: string; headers: Record<string, unknown> }>();
    if (req.method !== 'GET' && req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    return super.canActivate(context);
  }
}
