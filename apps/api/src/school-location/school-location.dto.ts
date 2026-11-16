import { Allow } from 'class-validator';

/** 0392 location save. Every field is closed-validated by the shared contract validator in the service. */
export class SaveSchoolLocationDto {
  @Allow() location?: unknown;
  @Allow() expectedVersion?: unknown;
}
