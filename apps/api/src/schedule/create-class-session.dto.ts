import {
  CLASS_SESSION_BOOKING_POLICIES,
  type ClassSessionBookingPolicy,
  type CreateClassSessionInput,
} from '@hon/contracts';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateClassSessionDto implements CreateClassSessionInput {
  @IsUUID()
  programId!: string;

  @IsString()
  @MaxLength(160)
  name!: string;

  @IsISO8601({ strict: true })
  startsAt!: string;

  @IsISO8601({ strict: true })
  endsAt!: string;

  @IsInt()
  @Min(1)
  capacity!: number;

  @IsIn([...CLASS_SESSION_BOOKING_POLICIES])
  bookingPolicy!: ClassSessionBookingPolicy;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  roomName?: string;
}
