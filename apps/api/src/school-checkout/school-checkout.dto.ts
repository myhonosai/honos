import { Allow } from 'class-validator';

/** 0269 checkout page save. Every field is closed-validated by the shared contract validator in the service. */
export class SaveCheckoutPageDto {
  @Allow() kind?: unknown;
  @Allow() expectedVersion?: unknown;
  @Allow() status?: unknown;
  @Allow() content?: unknown;
}
