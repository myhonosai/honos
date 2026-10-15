import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  WORK_ITEM_STATUSES,
  type CreateWorkItemInput,
  type TransitionWorkItemInput,
  type WorkItemStatus,
} from '@hon/contracts';

export class CreateWorkItemDto implements CreateWorkItemInput {
  @IsString()
  @MaxLength(100)
  workType!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  subjectType?: string;

  @IsOptional()
  @IsUUID()
  subjectId?: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

export class TransitionWorkItemDto implements TransitionWorkItemInput {
  @IsIn([...WORK_ITEM_STATUSES])
  targetStatus!: WorkItemStatus;

  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsOptional()
  @IsObject()
  result?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  errorReason?: string;
}

export class ListWorkItemsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
