import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { RegisterTestingCandidateInput } from '@hon/contracts';

export class RegisterTestingCandidateDto implements RegisterTestingCandidateInput {
  @IsUUID()
  studentCurriculumEnrollmentId!: string;

  @IsUUID()
  targetRankId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  instructorNotes?: string;
}
