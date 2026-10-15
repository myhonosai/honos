import { Type } from 'class-transformer';
import {
  IsEmail,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class PrimaryContactDto {
  @IsString()
  @MaxLength(120)
  givenName!: string;

  @IsString()
  @MaxLength(120)
  familyName!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @Matches(/^\+[1-9]\d{1,14}$/)
  phoneE164?: string;
}

export class CreateLeadDto {
  @IsUUID()
  pipelineId!: string;

  @IsUUID()
  pipelineStageId!: string;

  @ValidateNested()
  @Type(() => PrimaryContactDto)
  primaryContact!: PrimaryContactDto;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  sourceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  programInterestCode?: string;

  @IsOptional()
  @IsISO8601()
  nextFollowUpAt?: string;

  @IsOptional()
  @IsObject()
  attribution?: Record<string, string>;
}
