import { Allow, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Injectable, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { ActionReviewBinding } from '@hon/contracts';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
export class ActionDecisionDto {
  @IsIn(['APPROVED', 'DENIED']) decision!: 'APPROVED' | 'DENIED';
  @Allow() binding!: ActionReviewBinding;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
@Injectable()
export class ActionReviewHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command: string = 'action-approvals';
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{method:string;headers:Record<string,unknown>}>();
    if (req.method !== 'GET' && req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin') throw new ForbiddenException({code:'HUMAN_UI_REQUIRED'});
    return super.canActivate(context);
  }
}
