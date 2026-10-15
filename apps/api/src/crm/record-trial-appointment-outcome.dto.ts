import {
  CRM_TRIAL_OUTCOME_STATUSES,
  type CrmTrialOutcomeStatus,
  type RecordTrialAppointmentOutcomeInput,
} from '@hon/contracts';
import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

/**
 * Tenant, actor, source, and appointment type are server-derived. Outcome notes
 * are evidence for the recorded result, not a lead, enrollment, or booking edit.
 */
export class RecordTrialAppointmentOutcomeDto implements RecordTrialAppointmentOutcomeInput {
  @IsIn([...CRM_TRIAL_OUTCOME_STATUSES])
  status!: CrmTrialOutcomeStatus;

  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(2000)
  outcomeNotes?: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
