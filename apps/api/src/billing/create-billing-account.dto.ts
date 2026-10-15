import { IsOptional, IsUUID, Matches } from 'class-validator';

export class CreateBillingAccountDto {
  @IsUUID()
  responsiblePersonId!: string;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;
}
