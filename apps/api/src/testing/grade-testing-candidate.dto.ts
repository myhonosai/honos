import {
  TESTING_CANDIDATE_GRADE_RESULTS,
  type GradeTestingCandidateInput,
  type TestingCandidateGradeResult,
} from '@hon/contracts';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** Request shape for an instructor's final testing-candidate assessment. */
export class GradeTestingCandidateDto implements GradeTestingCandidateInput {
  @IsIn([...TESTING_CANDIDATE_GRADE_RESULTS])
  result!: TestingCandidateGradeResult;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  instructorNotes?: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
