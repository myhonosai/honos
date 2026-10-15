import { Allow } from 'class-validator';
import { ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
import type { TeachingAssessmentInput, TeachingLessonInput, TeachingResourceInput } from '@hon/contracts';

export class TeachingLessonDto implements TeachingLessonInput {
  @Allow() declare expectedVersion: number; @Allow() declare title: string; @Allow() declare instructionalObjective: string;
  @Allow() declare sections: TeachingLessonInput['sections']; @Allow() declare durationMinutes: number; @Allow() declare status: TeachingLessonInput['status'];
  @Allow() declare targetCurriculumId: string | null; @Allow() declare targetRankId: string | null;
}
export class TeachingResourceDto implements TeachingResourceInput {
  @Allow() declare expectedVersion: number; @Allow() declare title: string; @Allow() declare resourceType: TeachingResourceInput['resourceType'];
  @Allow() declare description: string; @Allow() declare status: TeachingResourceInput['status'];
}
export class TeachingAssessmentDto implements TeachingAssessmentInput {
  @Allow() declare expectedVersion: number; @Allow() declare observation: string; @Allow() declare assessedSkills: TeachingAssessmentInput['assessedSkills'];
  @Allow() declare instructorNote: string | null; @Allow() declare assessedOn: string; @Allow() declare status: TeachingAssessmentInput['status'];
  @Allow() declare targetCurriculumId: string | null; @Allow() declare targetRankId: string | null;
}
@Injectable()
export class TeachingStudioHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command: string = 'teaching-studio';
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ method: string; headers: Record<string, unknown> }>();
    if (request.method !== 'GET' && request.headers['sec-fetch-site'] !== undefined && request.headers['sec-fetch-site'] !== 'same-origin') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    return super.canActivate(context);
  }
}
