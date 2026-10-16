import {
  CLASS_BOOKING_KINDS,
  type GenericClassBookingKind,
  type CreateClassBookingInput,
} from '@hon/contracts';
import { IsIn, IsUUID } from 'class-validator';

/**
 * Staff can choose only the student and the business kind of the booking.
 * Source and actor are deliberately absent: the authenticated controller
 * derives them as HUMAN_UI and HUMAN_USER respectively.
 */
export class CreateClassBookingDto implements CreateClassBookingInput {
  @IsUUID()
  studentProfileId!: string;

  @IsIn([...CLASS_BOOKING_KINDS])
  bookingKind!: GenericClassBookingKind;
}
