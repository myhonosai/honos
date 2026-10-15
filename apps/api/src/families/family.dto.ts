import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateFamilyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  displayName!: string;
}

export class AddFamilyMemberDto {
  @IsUUID()
  personId!: string;

  @IsIn(['GUARDIAN', 'STUDENT', 'DEPENDENT', 'OTHER'])
  memberRole!: 'GUARDIAN' | 'STUDENT' | 'DEPENDENT' | 'OTHER';

  @IsOptional()
  @IsBoolean()
  isBillingContact?: boolean;
}
