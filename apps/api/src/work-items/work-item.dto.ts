import { Allow } from 'class-validator';
import { Injectable, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { HumanWorkInput, HumanWorkFields, HumanWorkStatus, HumanWorkTransition } from '@hon/contracts';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
export class HumanWorkDto implements HumanWorkInput {
  @Allow() declare expectedVersion: number;
  @Allow() declare title: string;
  @Allow() declare description: string;
  @Allow() declare priority: HumanWorkFields['priority'];
  @Allow() declare dueAt: string | null;
  @Allow() declare assigneeId: string | null;
}
export class HumanWorkTransitionDto implements HumanWorkTransition {
  @Allow() declare expectedVersion: number;
  @Allow() declare targetStatus: HumanWorkStatus;
}
@Injectable()
export class WorkItemHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command: string = 'human-work';
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ method: string; headers: Record<string, unknown> }>();
    if (req.method !== 'GET' && req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    return super.canActivate(context);
  }
}
