import { Allow } from 'class-validator';

/**
 * E1b-1 membership date management (0178). Every field is closed-validated by the shared contract validators in the
 * service, so these DTOs only admit the known keys past the global whitelist.
 */
export class MembershipDateRevisionPreviewDto {
  @Allow() changeKind?: unknown;
  @Allow() startDate?: unknown;
  @Allow() endDate?: unknown;
}

export class ConfirmMembershipDateRevisionDto {
  @Allow() expectedVersion?: unknown;
  @Allow() expectedPeriodVersion?: unknown;
  @Allow() previewDigest?: unknown;
  @Allow() changeKind?: unknown;
  @Allow() startDate?: unknown;
  @Allow() endDate?: unknown;
  @Allow() dateSource?: unknown;
  @Allow() dateAdjustmentReason?: unknown;
  @Allow() acknowledgedWarnings?: unknown;
  @Allow() reasonCode?: unknown;
  @Allow() reasonText?: unknown;
  @Allow() confirmation?: unknown;
}

/** The history read takes `{}`. */
export class MembershipDateHistoryDto {}

export class MembershipDateConfirmationQueueDto {
  @Allow() after?: unknown;
  @Allow() limit?: unknown;
}
