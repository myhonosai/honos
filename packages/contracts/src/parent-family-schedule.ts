import type {
  ClassBookingKind,
  ClassBookingStatus,
  ScheduleItemStatus,
} from './index.js';

/**
 * Parent/Eian schedule read model. This intentionally has no identifiers,
 * capacity or roster information, staff/instructor data, billing data, or
 * records outside the selected, resolver-authorized family.
 */
export interface ParentFamilySchedule {
  bookings: ParentFamilyScheduleBooking[];
}

/** A booking for one selected-family student in the requested time window. */
export interface ParentFamilyScheduleBooking {
  student: {
    displayName: string;
  };
  booking: {
    kind: ClassBookingKind;
    status: ClassBookingStatus;
  };
  session: {
    name: string;
    startsAt: string;
    endsAt: string;
    roomName?: string | undefined;
    status: ScheduleItemStatus;
  };
  program: {
    name: string;
  };
}
