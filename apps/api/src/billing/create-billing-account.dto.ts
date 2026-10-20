import { IsBoolean, IsOptional, IsString, IsUUID, Length, Matches, ValidateIf } from 'class-validator';

export class CreateBillingAccountDto {
  @IsUUID()
  responsiblePersonId!: string;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsOptional()
  @IsBoolean()
  createAdditional?: boolean;

  @ValidateIf((value: CreateBillingAccountDto) => value.createAdditional === true)
  @IsString()
  @Length(1, 500)
  @Matches(/^\S(?:[\s\S]*\S)?$/)
  @Matches(/^[^\u0000-\u001f\u007f-\u009f]*$/u)
  additionalReason?: string;
}
