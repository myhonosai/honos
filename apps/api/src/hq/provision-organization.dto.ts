import { IsIn, IsString, Matches, MaxLength } from 'class-validator';

export class ProvisionOrganizationDto {
  @IsString()
  @MaxLength(180)
  legalName!: string;

  @IsString()
  @MaxLength(120)
  displayName!: string;

  @IsString()
  @MaxLength(120)
  schoolName!: string;

  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  @MaxLength(80)
  schoolSlug!: string;

  @IsString()
  @MaxLength(64)
  timezone!: string;

  @IsIn(['ESSENTIAL', 'CORE', 'COMPLETE'])
  initialTier!: 'ESSENTIAL' | 'CORE' | 'COMPLETE';
}
