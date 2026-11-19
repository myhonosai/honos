import { Allow } from 'class-validator';

/** 0551 calendar card commands. Every field is closed-validated by the shared contract validators in the service. */
export class CreateCalendarCardDto {
  @Allow() kind?: unknown; @Allow() programId?: unknown; @Allow() name?: unknown; @Allow() roomName?: unknown; @Allow() capacity?: unknown;
  @Allow() bookingPolicy?: unknown; @Allow() instructorPrincipalId?: unknown; @Allow() localDate?: unknown; @Allow() localStartTime?: unknown;
  @Allow() durationMinutes?: unknown; @Allow() repeatWeekdays?: unknown; @Allow() repeatUntil?: unknown;
}
export class MoveCalendarCardDto { @Allow() expectedVersion?: unknown; @Allow() startsAt?: unknown; @Allow() endsAt?: unknown }
