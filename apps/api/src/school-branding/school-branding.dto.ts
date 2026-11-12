import { Allow } from 'class-validator';

/** 0268 branding save. Every field is closed-validated by the shared contract validator in the service. */
export class SaveSchoolBrandingDto {
  @Allow() branding?: unknown;
  @Allow() expectedVersion?: unknown;
}
