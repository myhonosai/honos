import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthenticatedIdentity } from '../foundation/manus-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { HonTier } from '@hon/contracts';

export interface ProvisionOrganizationInput {
  legalName: string;
  displayName: string;
  schoolName: string;
  schoolSlug: string;
  timezone: string;
  initialTier: HonTier;
  idempotencyKey: string;
}

export interface ProvisionedOrganization {
  organizationId: string;
  schoolId: string;
  ownerRoleId: string;
  replayed: boolean;
}

@Injectable()
export class HqOnboardingService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async provisionInitialSchool(identity: AuthenticatedIdentity, input: ProvisionOrganizationInput): Promise<ProvisionedOrganization> {
    const normalized = {
      legalName: input.legalName.trim(),
      displayName: input.displayName.trim(),
      schoolName: input.schoolName.trim(),
      schoolSlug: input.schoolSlug.trim().toLowerCase(),
      timezone: input.timezone.trim(),
      initialTier: input.initialTier,
    };
    if (Object.values(normalized).some((value) => value.length === 0)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Organization and school fields cannot be blank.' });
    }
    const requestId = randomUUID();
    const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    return this.database.provisionSchoolFromHq({
      externalSubject: identity.externalSubject,
      ...normalized,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      requestId,
      correlationId: requestId,
    });
  }
}
