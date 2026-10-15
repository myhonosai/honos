import {
  COMMUNICATION_CONSENT_STATUSES,
  type CommunicationConsentStatus,
  type RecordCommunicationConsentInput,
} from '@hon/contracts';
import { IsIn, IsInt, IsISO8601, IsOptional, Min } from 'class-validator';

/**
 * Consent provenance is deliberately constrained to STAFF at this staff endpoint.
 * Tenant, person, channel, actor, and runtime source are never client inputs.
 */
export class RecordCommunicationConsentDto implements RecordCommunicationConsentInput {
  @IsIn([...COMMUNICATION_CONSENT_STATUSES])
  status!: CommunicationConsentStatus;

  @IsIn(['STAFF'])
  source!: 'STAFF';

  @IsISO8601({ strict: true, strictSeparator: true })
  capturedAt!: string;

  /** Required by the service only if a consent already exists for the channel. */
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
