import { IsInt, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import type { CreateCurriculumRankInput } from '@hon/contracts';

export class CreateCurriculumRankDto implements CreateCurriculumRankInput {
  @IsString() @MaxLength(120) name!: string;
  @IsInt() @Min(1) progressionOrder!: number;
  @IsOptional() @IsString() @MaxLength(32) displayColor?: string;
  @IsOptional() @IsObject() exposureRequirement?: Record<string, unknown>;
  @IsOptional() @IsObject() masteryRequirement?: Record<string, unknown>;
  @IsOptional() @IsObject() promotionRequirement?: Record<string, unknown>;
}
