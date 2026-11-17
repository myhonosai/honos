import { Allow } from 'class-validator';

/** 0468 bodies. Every field is closed-validated by the shared contract validators in the service. */
export class TimeClockPunchDto {
  @Allow() action?: unknown;
  @Allow() expectedVersion?: unknown;
}
export class SaveTimeEntryDto {
  @Allow() entryId?: unknown;
  @Allow() expectedVersion?: unknown;
  @Allow() staffPrincipalId?: unknown;
  @Allow() clockIn?: unknown;
  @Allow() clockOut?: unknown;
  @Allow() reason?: unknown;
}
export class TimesheetDecisionDto {
  @Allow() staffPrincipalId?: unknown;
  @Allow() weekStart?: unknown;
  @Allow() action?: unknown;
  @Allow() expectedVersion?: unknown;
}
