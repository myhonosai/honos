import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import type { CreateProgramInput } from '@hon/contracts';

export class CreateProgramDto implements CreateProgramInput {
  @IsString()
  @MaxLength(140)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  minimumAgeMonths?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  maximumAgeMonths?: number;
}
