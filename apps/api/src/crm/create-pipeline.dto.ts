import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';

export class CreatePipelineStageDto {
  @IsString()
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsIn(['WON', 'LOST', 'ARCHIVED'])
  terminalStatus?: 'WON' | 'LOST' | 'ARCHIVED';
}

export class CreatePipelineDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreatePipelineStageDto)
  stages!: CreatePipelineStageDto[];
}
