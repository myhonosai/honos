import type { CreatePlannedAbsenceRequestInput } from '@hon/contracts';
import {
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

// Date-only and timezone-free local timestamps are ambiguous across a school
// boundary, so the public request contract requires an explicit UTC offset.
const TIMEZONE_QUALIFIED_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export class CreateParentPlannedAbsenceDto implements CreatePlannedAbsenceRequestInput {
  @IsUUID()
  studentProfileId!: string;

  @IsISO8601({ strict: true })
  @Matches(TIMEZONE_QUALIFIED_ISO_TIMESTAMP, {
    message: 'startsAt must be a timezone-qualified ISO 8601 timestamp.',
  })
  startsAt!: string;

  @IsISO8601({ strict: true })
  @Matches(TIMEZONE_QUALIFIED_ISO_TIMESTAMP, {
    message: 'endsAt must be a timezone-qualified ISO 8601 timestamp.',
  })
  endsAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
