import { Allow } from 'class-validator';

/** 0552 calendar settings commands. Every field is closed-validated by the shared contract validators in the service. */
export class CalendarShareSettingsDto { @Allow() expectedVersion?: unknown; @Allow() address?: unknown; @Allow() phone?: unknown }
export class CalendarBlockOutDto { @Allow() label?: unknown; @Allow() firstDate?: unknown; @Allow() lastDate?: unknown }
export class CalendarVersionDto { @Allow() expectedVersion?: unknown }
export class ShareCalendarDto {
  @Allow() expectedVersion?: unknown; @Allow() kind?: unknown; @Allow() name?: unknown; @Allow() description?: unknown; @Allow() programId?: unknown;
  @Allow() memberIds?: unknown; @Allow() ageMin?: unknown; @Allow() ageMax?: unknown; @Allow() enabled?: unknown;
}
