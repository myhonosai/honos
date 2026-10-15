import {
  ATTENDANCE_STATUSES,
  type AttendanceStatus,
  type RecordAttendanceInput,
} from '@hon/contracts';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class RecordAttendanceDto implements RecordAttendanceInput {
  @IsUUID()
  studentProfileId!: string;

  @IsIn([...ATTENDANCE_STATUSES])
  status!: AttendanceStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  /**
   * Required only when a command changes an existing attendance state. This
   * makes the write conditional on the state the caller actually observed.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
