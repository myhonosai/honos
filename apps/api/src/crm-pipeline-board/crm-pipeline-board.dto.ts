import { Allow } from 'class-validator';

/** 0417 commands. Every field is closed-validated by the shared contract validators in the service. */
export class MoveCrmLeadStageDto {
  @Allow() stageId?: unknown;
  @Allow() expectedVersion?: unknown;
}
export class SaveCrmPipelineStagesDto {
  @Allow() expectedVersion?: unknown;
  @Allow() stages?: unknown;
  @Allow() moves?: unknown;
}
