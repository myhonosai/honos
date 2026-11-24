import { Allow } from 'class-validator';

/** 0628 bodies. Every field is closed-validated by the shared contract validators in the service. */
export class RenameSchoolMediaDto {
  @Allow() assetId?: unknown;
  @Allow() expectedVersion?: unknown;
  @Allow() title?: unknown;
}
export class DeleteSchoolMediaDto {
  @Allow() assetId?: unknown;
  @Allow() expectedVersion?: unknown;
}
