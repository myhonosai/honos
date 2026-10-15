import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { CreateCurriculumInput } from '@hon/contracts';

export class CreateCurriculumDto implements CreateCurriculumInput {
  @IsString() @MaxLength(140) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsIn(['LINEAR', 'ROTATIONAL', 'HYBRID', 'SKILL_BASED', 'MODULE_BASED', 'ATTENDANCE_PLUS_APPROVAL', 'CUSTOM'])
  modelCode!: CreateCurriculumInput['modelCode'];
}
