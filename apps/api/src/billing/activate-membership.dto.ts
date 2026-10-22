import { Allow } from 'class-validator';

/**
 * Two-step activation confirmation (0177). Every field is closed-validated by the shared contract validator in the
 * service, so this DTO only admits the known keys past the global whitelist. A pre-0177 `{ expectedVersion }` body is
 * refused with ACTIVATION_TWO_STEP_CONFIRMATION_REQUIRED.
 */
export class ActivateMembershipDto {
  @Allow() expectedVersion?: unknown;
  @Allow() previewDigest?: unknown;
  @Allow() startDate?: unknown;
  @Allow() endDate?: unknown;
  @Allow() dateSource?: unknown;
  @Allow() dateAdjustmentReason?: unknown;
  @Allow() acknowledgedWarnings?: unknown;
  @Allow() overrides?: unknown;
  @Allow() adultVerification?: unknown;
  @Allow() reasonCode?: unknown;
  @Allow() reasonText?: unknown;
  @Allow() confirmation?: unknown;
}

/** Read-only activation preview: `{}` for the suggested dates or one exact date pair. */
export class MembershipActivationPreviewDto {
  @Allow() startDate?: unknown;
  @Allow() endDate?: unknown;
}
