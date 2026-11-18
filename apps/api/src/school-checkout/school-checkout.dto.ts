import { Allow } from 'class-validator';

/** 0402 checkout page save. Every field is closed-validated by the shared contract validator in the service. */
export class SaveCheckoutPageDto {
  @Allow() pageId?: unknown;
  @Allow() expectedVersion?: unknown;
  @Allow() slug?: unknown;
  @Allow() groupKey?: unknown;
  @Allow() status?: unknown;
  @Allow() content?: unknown;
}

/** 0402 checkout groups and staff grid order. */
export class SaveCheckoutSettingsDto {
  @Allow() expectedVersion?: unknown;
  @Allow() groups?: unknown;
  @Allow() pageOrder?: unknown;
}
