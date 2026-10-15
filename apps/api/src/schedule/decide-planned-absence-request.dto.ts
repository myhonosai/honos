import {
  PLANNED_ABSENCE_REVIEW_DECISIONS,
  type DecidePlannedAbsenceRequestInput,
  type PlannedAbsenceReviewDecision,
} from '@hon/contracts';
import { IsIn, IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

/** Human staff's final decision on an already submitted planned-absence request. */
export class DecidePlannedAbsenceRequestDto implements DecidePlannedAbsenceRequestInput {
  @IsIn([...PLANNED_ABSENCE_REVIEW_DECISIONS])
  decision!: PlannedAbsenceReviewDecision;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reviewNote!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
