import { Allow } from 'class-validator';

/** 0239 class-series commands. Every field is closed-validated by the shared contract validators in the service. */
export class CreateClassSeriesDto {
  @Allow() programId?: unknown; @Allow() name?: unknown; @Allow() roomName?: unknown; @Allow() capacity?: unknown; @Allow() bookingPolicy?: unknown;
  @Allow() weekdays?: unknown; @Allow() localStartTime?: unknown; @Allow() durationMinutes?: unknown; @Allow() startsOn?: unknown; @Allow() endsOn?: unknown;
}
export class ReviseClassSeriesDto {
  @Allow() expectedVersion?: unknown; @Allow() name?: unknown; @Allow() roomName?: unknown; @Allow() capacity?: unknown; @Allow() bookingPolicy?: unknown;
  @Allow() weekdays?: unknown; @Allow() localStartTime?: unknown; @Allow() durationMinutes?: unknown; @Allow() endsOn?: unknown;
}
export class EndClassSeriesDto { @Allow() expectedVersion?: unknown; @Allow() lastDate?: unknown; @Allow() reason?: unknown }
export class FillClassSeriesDto { @Allow() expectedVersion?: unknown; @Allow() throughDate?: unknown }
export class SetClassSeriesOngoingDto { @Allow() expectedVersion?: unknown; @Allow() ongoing?: unknown }
/** 0251 top-up takes an empty body. */
export class TopUpClassSeriesDto {}
