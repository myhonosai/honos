import { Allow } from 'class-validator';

/**
 * 0224 membership pause commands. Every field is closed-validated by the shared contract validators in the service, so
 * these DTOs only admit the known keys past the global whitelist.
 */
export class SetSchoolMembershipPausePolicyDto {
  @Allow() expectedVersion?: unknown;
  @Allow() pausesAllowed?: unknown;
  @Allow() maxPauseDays?: unknown;
  @Allow() maxPausedDaysPerYear?: unknown;
  @Allow() holdFee?: unknown;
}

export class PauseMembershipDto {
  @Allow() expectedVersion?: unknown;
  @Allow() resumeOn?: unknown;
  @Allow() pauseReason?: unknown;
}

export class ResumeMembershipDto {
  @Allow() expectedVersion?: unknown;
  @Allow() resumeReason?: unknown;
}

export class RecordMembershipRefundDto {
  @Allow() amountMinor?: unknown;
  @Allow() currency?: unknown;
  @Allow() refundedOn?: unknown;
  @Allow() method?: unknown;
  @Allow() reason?: unknown;
}
