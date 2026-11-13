import { Allow } from 'class-validator';

/** 0258 school payment connection commands. Every field is closed-validated by the shared contract validators in the service. */
export class StartSchoolPayConnectionDto {
  @Allow() providerCode?: unknown;
}
export class SchoolPayVersionDto {
  @Allow() expectedVersion?: unknown;
}
export class FinishSchoolPayOnboardingDto {
  @Allow() expectedVersion?: unknown;
  @Allow() state?: unknown;
  @Allow() authorizationCode?: unknown;
}
export class DisconnectSchoolPayDto {
  @Allow() expectedVersion?: unknown;
  @Allow() reason?: unknown;
}

/** 0321 saved payment method commands; closed-validated by the shared contract validators in the service. */
export class StartSchoolPayMethodSetupDto {
  @Allow() connectionId?: unknown;
  @Allow() methodKinds?: unknown;
  @Allow() consentTextVersion?: unknown;
}
export class FinishSchoolPayMethodSetupDto {
  @Allow() expectedVersion?: unknown;
  @Allow() setupState?: unknown;
}
export class RemoveSchoolPayMethodDto {
  @Allow() expectedVersion?: unknown;
  @Allow() reason?: unknown;
}

/** 0322 autopay and sibling discount commands; closed-validated by the shared contract validators in the service. */
export class SetSchoolPayDiscountRuleDto {
  @Allow() basedOnVersion?: unknown;
  @Allow() kind?: unknown;
  @Allow() secondValue?: unknown;
  @Allow() laterValue?: unknown;
  @Allow() currency?: unknown;
}
export class EnrollSchoolPayAutopayDto {
  @Allow() methodId?: unknown;
  @Allow() consentTextVersion?: unknown;
}
export class ChangeSchoolPayAutopayMethodDto {
  @Allow() expectedVersion?: unknown;
  @Allow() methodId?: unknown;
}
export class SetSchoolPayAutopayStateDto {
  @Allow() expectedVersion?: unknown;
  @Allow() state?: unknown;
}
export class PrepareSchoolPayAutopayCycleDto {
  @Allow() expectedVersion?: unknown;
  @Allow() cycleDate?: unknown;
}
export class CancelSchoolPayAutopayDto {
  @Allow() expectedVersion?: unknown;
  @Allow() reason?: unknown;
}
export class StartSchoolPayChargeDto {
  @Allow() totalMinor?: unknown;
  @Allow() currency?: unknown;
}
export class ReconcileSchoolPayChargeDto {}
