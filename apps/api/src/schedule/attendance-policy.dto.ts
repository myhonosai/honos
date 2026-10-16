import { ATTENDANCE_CATEGORIES, ATTENDANCE_WEIGHT_MAX, type AttendanceCategory, type AttendanceCategoryPolicy, type ConfigureAttendancePolicyInput } from '@hon/contracts';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, Max, Min, ValidateNested } from 'class-validator';
export class AttendanceCategoryPolicyDto implements AttendanceCategoryPolicy {
  @IsIn([...ATTENDANCE_CATEGORIES])
  category!: AttendanceCategory;
  @IsBoolean()
  operationalAllowed!: boolean;
  @IsBoolean()
  progressionEnabled!: boolean;
  @IsInt()
  @Min(0)
  @Max(ATTENDANCE_WEIGHT_MAX)
  weightMilli!: number;
}
export class ConfigureAttendancePolicyDto implements ConfigureAttendancePolicyInput {
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedVersion!: number;
  @IsArray()
  @ArrayMinSize(7)
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => AttendanceCategoryPolicyDto)
  categories!: AttendanceCategoryPolicyDto[];
}
