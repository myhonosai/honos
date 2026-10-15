import { Allow } from 'class-validator';
import { ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import type { AchievementDefinitionInput, AchievementAwardInput } from '@hon/contracts';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
export class AchievementDefinitionDto implements AchievementDefinitionInput {
  @Allow() declare expectedVersion: number;
  @Allow() declare name: string;
  @Allow() declare description: string;
  @Allow() declare category: AchievementDefinitionInput['category'];
  @Allow() declare ageBand: AchievementDefinitionInput['ageBand'];
  @Allow() declare visualToken: AchievementDefinitionInput['visualToken'];
  @Allow() declare status: AchievementDefinitionInput['status'];
}
export class AchievementAwardDto implements AchievementAwardInput {
  @Allow() declare expectedVersion: number;
  @Allow() declare definitionId: string;
  @Allow() declare definitionVersion: number;
  @Allow() declare reason: string | null;
  @Allow() declare awardedOn: string;
  @Allow() declare visibleToFamily: boolean;
  @Allow() declare status: AchievementAwardInput['status'];
}
@Injectable()
export class AchievementHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command = 'student-achievements';
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ method: string; headers: Record<string, unknown> }>();
    if (req.method !== 'GET' && req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    return super.canActivate(context);
  }
}
