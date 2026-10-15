import { IsIn, IsInt, IsString, IsUUID, Matches, Max, Min } from 'class-validator';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';

/** No actor, organization, outcome, rank, certificate, family, or execution fields are accepted. */
export class RecordTestingScorecardEvaluationDto {
  @IsUUID()
  schoolId!: string;

  @IsUUID()
  testingCandidateId!: string;

  @IsUUID()
  testingEventId!: string;

  @IsString()
  @Matches(/^[A-Z][A-Z0-9_.-]{0,63}$/)
  criterionCode!: string;

  @IsIn(['OBSERVED', 'NOT_OBSERVED', 'NEEDS_FOLLOW_UP'])
  assessment!: 'OBSERVED' | 'NOT_OBSERVED' | 'NEEDS_FOLLOW_UP';

  @IsInt()
  @Min(1)
  @Max(999_999_999)
  expectedCandidateVersion!: number;

  @IsInt()
  @Min(1)
  @Max(999_999_999)
  expectedTestingEventVersion!: number;

  @IsInt()
  @Min(0)
  @Max(999_999_999)
  expectedScorecardVersion!: number;
}

export class TestingScorecardHumanUiGuard extends CurriculumHumanUiGuard {
  protected override readonly command = 'testing-scorecard';
}
