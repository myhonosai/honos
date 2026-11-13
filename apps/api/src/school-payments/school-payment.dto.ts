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
