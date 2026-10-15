import { IsInt, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';

/** No actor, organization, source, external-service, action, or student fields are accepted. */
export class IssueTestingCertificateDto {
  @IsUUID()
  schoolId!: string;

  @IsUUID()
  testingCandidateId!: string;

  @IsInt()
  @Min(1)
  @Max(999_999_999)
  expectedCandidateVersion!: number;

  /** Creation is the sole operation in this immutable slice and therefore requires zero. */
  @IsInt()
  @Min(0)
  @Max(0)
  expectedCertificateVersion!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;
}

export class TestingCertificateHumanUiGuard extends CurriculumHumanUiGuard {
  protected override readonly command = 'testing-certificate';
}
