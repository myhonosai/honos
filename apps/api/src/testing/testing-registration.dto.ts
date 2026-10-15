import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import type { DecideTestingRegistrationInterestInput, SubmitTestingRegistrationInterestInput } from '@hon/contracts';

export class SubmitTestingRegistrationInterestDto implements SubmitTestingRegistrationInterestInput {
  @IsUUID()
  studentProfileId!: string;

  @IsUUID()
  testingEventId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class DecideTestingRegistrationInterestDto implements DecideTestingRegistrationInterestInput {
  @IsIn(['ACCEPT', 'DECLINE', 'WAITLIST'])
  decision!: 'ACCEPT' | 'DECLINE' | 'WAITLIST';

  @IsInt()
  @Min(1)
  @Max(999999998)
  expectedVersion!: number;
}
