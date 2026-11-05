import { BadRequestException, ConflictException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthenticatedIdentity } from '../foundation/hon-identity.service.js';
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
  /** The HQ principal the human screen verified (X-HON-Expected-Principal). */
  expectedPrincipalId: string;
}

export type ProvisionedEntitlementStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
export interface ProvisionedOrganization {
  organizationId: string;
  schoolId: string;
  ownerRoleId: string;
  replayed: boolean;
  /** The HQ principal the database resolved as the actor; always equal to the expected principal. */
  actorPrincipalId: string;
  /** The school's entitlement status when this response was produced (SUSPENDED for a new school: no operating access). */
  entitlementStatus: ProvisionedEntitlementStatus;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_KEYS = 'actorPrincipalId,entitlementStatus,organizationId,ownerRoleId,replayed,schoolId';
const STATUSES: readonly string[] = ['ACTIVE', 'SUSPENDED', 'ARCHIVED'];

/** Closed receipt: exactly the reviewed fields, and the actor echo must equal the expected principal. */
export function verifyProvisioningReceipt(value: unknown, expectedPrincipalId: string): ProvisionedOrganization {
  const r = value as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== RECEIPT_KEYS
    || ![r.organizationId, r.schoolId, r.ownerRoleId, r.actorPrincipalId].every(v => typeof v === 'string' && UUID.test(v))
    || typeof r.replayed !== 'boolean' || typeof r.entitlementStatus !== 'string' || !STATUSES.includes(r.entitlementStatus)
    || (r.actorPrincipalId as string).toLowerCase() !== expectedPrincipalId.toLowerCase()
    || (!r.replayed && r.entitlementStatus !== 'SUSPENDED')) {
    throw new ServiceUnavailableException({ code: 'HQ_PROVISIONING_UNAVAILABLE' });
  }
  return { organizationId: r.organizationId as string, schoolId: r.schoolId as string, ownerRoleId: r.ownerRoleId as string,
    replayed: r.replayed, actorPrincipalId: r.actorPrincipalId as string, entitlementStatus: r.entitlementStatus as ProvisionedEntitlementStatus };
}

/** Database detail never reaches the client. */
export function provisioningFailure(error: unknown): never {
  if (error instanceof ServiceUnavailableException) throw error;
  const failure = error as { code?: string; message?: string } | undefined;
  if (failure?.code === '42501' && failure.message === 'HQ_EXPECTED_PRINCIPAL_MISMATCH') throw new ConflictException({ code: 'HQ_EXPECTED_PRINCIPAL_MISMATCH' });
  switch (failure?.code) {
    case '42501': throw new ForbiddenException({ code: 'HQ_PROVISIONING_FORBIDDEN' });
    case '23505': throw new ConflictException({ code: 'HQ_PROVISIONING_CONFLICT' });
    case '55P03': case '40001': case '40P01': throw new ConflictException({ code: 'HQ_PROVISIONING_IN_PROGRESS' });
    case 'P0001': case '22023': case '22P02': case '23514': case '22001': throw new BadRequestException({ code: 'HQ_PROVISIONING_INPUT_INVALID' });
    default: throw new ServiceUnavailableException({ code: 'HQ_PROVISIONING_UNAVAILABLE' });
  }
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
    if (typeof input.expectedPrincipalId !== 'string' || !UUID.test(input.expectedPrincipalId)) {
      throw new BadRequestException({ code: 'HQ_EXPECTED_PRINCIPAL_REQUIRED' });
    }
    const requestId = randomUUID();
    const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    let result: unknown;
    try {
      result = await this.database.provisionSchoolFromHq({
        externalSubject: identity.externalSubject,
        expectedPrincipalId: input.expectedPrincipalId.toLowerCase(),
        ...normalized,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        requestId,
        correlationId: requestId,
      });
    } catch (error) {
      provisioningFailure(error);
    }
    return verifyProvisioningReceipt(result, input.expectedPrincipalId);
  }
}
