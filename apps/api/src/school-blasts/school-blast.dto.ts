import { Allow } from 'class-validator';

/** 0536 bodies. Every field is closed-validated by the shared contract validators in the service. */
export class SaveSchoolBlastDto {
  @Allow() blastId?: unknown;
  @Allow() expectedVersion?: unknown;
  @Allow() name?: unknown;
  @Allow() channel?: unknown;
  @Allow() subject?: unknown;
  @Allow() body?: unknown;
  @Allow() audience?: unknown;
}
export class SendSchoolBlastDto {
  @Allow() blastId?: unknown;
  @Allow() expectedVersion?: unknown;
  @Allow() sendAt?: unknown;
}
export class CancelSchoolBlastDto {
  @Allow() blastId?: unknown;
  @Allow() expectedVersion?: unknown;
}
