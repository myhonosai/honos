import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateNested } from 'class-validator';

export class MembershipPaymentScheduleDto {
  @IsIn(['WEEKLY', 'MONTHLY', 'ANNUAL', 'CUSTOM'])
  frequency!: 'WEEKLY' | 'MONTHLY' | 'ANNUAL' | 'CUSTOM';

  @IsInt()
  @Min(1)
  amountMinor!: number;

  @IsOptional()
  @IsISO8601()
  nextChargeAt?: string;

  @IsBoolean()
  autoRenew!: boolean;
}

export class CreateMembershipDto {
  @IsUUID()
  billingAccountId!: string;

  @IsUUID()
  participantPersonId!: string;

  @IsString()
  @MaxLength(80)
  planCode!: string;

  @IsOptional()
  @IsISO8601()
  termStartedAt?: string;

  @IsOptional()
  @IsISO8601()
  termEndsAt?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MembershipPaymentScheduleDto)
  paymentSchedule?: MembershipPaymentScheduleDto;
}
