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
/** 0654 video upload start and finish. */
export class BeginSchoolVideoDto {
  @Allow() title?: unknown;
  @Allow() mediaType?: unknown;
  @Allow() byteSize?: unknown;
}
export class FinishSchoolVideoDto {
  @Allow() assetId?: unknown;
}
