import { Allow } from 'class-validator';
import { Injectable, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type {
  CreateInstructorQualificationInput, RecordInstructorQualificationEvidenceInput,
  RetireInstructorQualificationInput, ReviewInstructorQualificationEvidenceInput,
} from '@hon/contracts';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';

export class CreateInstructorQualificationDto implements CreateInstructorQualificationInput {
  @Allow() declare code: string; @Allow() declare title: string; @Allow() declare kind: 'QUALIFICATION' | 'CERTIFICATION'; @Allow() declare courseProgramId: string | null;
}
export class RetireInstructorQualificationDto implements RetireInstructorQualificationInput { @Allow() declare expectedVersion: number; }
export class RecordInstructorQualificationEvidenceDto implements RecordInstructorQualificationEvidenceInput {
  @Allow() declare qualificationId: string; @Allow() declare expectedQualificationVersion: number; @Allow() declare attainedOn: string; @Allow() declare expiresOn: string | null; @Allow() declare evidenceReference: string;
}
export class ReviewInstructorQualificationEvidenceDto implements ReviewInstructorQualificationEvidenceInput {
  @Allow() declare expectedReviewVersion: number; @Allow() declare status: 'REVIEWED' | 'RETIRED'; @Allow() declare reviewNote: string;
}
@Injectable()
export class InstructorQualificationsHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command = 'instructor-qualifications';
  canActivate(context: ExecutionContext): boolean {
    const request=context.switchToHttp().getRequest<{method:string;headers:Record<string,unknown>}>();
    const site=request.headers['sec-fetch-site'];
    if (request.method !== 'GET' && site !== undefined && site !== 'same-origin') throw new ForbiddenException({code:'HUMAN_UI_REQUIRED'});
    return super.canActivate(context);
  }
}
