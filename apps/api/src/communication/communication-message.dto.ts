import {
  COMMUNICATION_MESSAGE_CHANNELS,
  type CreateCommunicationMessageInput,
  type QueueCommunicationMessageInput,
} from '@hon/contracts';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** The client may supply only recipient, channel, content, and an optional schedule. */
export class CreateCommunicationMessageDto implements CreateCommunicationMessageInput {
  @IsUUID()
  recipientPersonId!: string;

  @IsIn([...COMMUNICATION_MESSAGE_CHANNELS])
  channel!: (typeof COMMUNICATION_MESSAGE_CHANNELS)[number];

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  content!: string;

  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  scheduledAt?: string;
}

/** Queueing requires an optimistic-concurrency version supplied by the human UI. */
export class QueueCommunicationMessageDto implements QueueCommunicationMessageInput {
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class ListCommunicationMessagesDto {
  @IsOptional()
  @IsUUID()
  recipientPersonId?: string;

  @IsOptional()
  @IsIn([...COMMUNICATION_MESSAGE_CHANNELS])
  channel?: (typeof COMMUNICATION_MESSAGE_CHANNELS)[number];

  @IsOptional()
  @IsIn(['DRAFT', 'QUEUED', 'CANCELLED'])
  lifecycle?: 'DRAFT' | 'QUEUED' | 'CANCELLED';

  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}
