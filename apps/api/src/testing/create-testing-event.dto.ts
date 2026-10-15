import { IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateTestingEventDto {
  @IsUUID() curriculumId!: string;
  @IsString() @MaxLength(160) name!: string;
  @IsISO8601() startsAt!: string;
  @IsOptional() @IsISO8601() endsAt?: string;
  @IsOptional() @IsISO8601() registrationOpensAt?: string;
  @IsOptional() @IsISO8601() registrationClosesAt?: string;
}
