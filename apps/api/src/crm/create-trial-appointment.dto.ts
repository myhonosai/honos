import type { CreateTrialAppointmentInput } from '@hon/contracts';
import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Tenant, lead, appointment type, status, actor, and source are all
 * server-derived. This public command accepts only scheduling details.
 */
export class CreateTrialAppointmentDto implements CreateTrialAppointmentInput {
  @IsISO8601({ strict: true })
  startsAt!: string;

  @IsISO8601({ strict: true })
  endsAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
