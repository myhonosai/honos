import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AiControlPlaneKind, AiControlPlaneSnapshot, AiRouteDecision, AiTaskProfileDecision } from '@hon/contracts';
import { aiConfigUuid, decideAiRoute, validateAiControlPlaneWrite, validateAiRouteRequest, decideAiTaskProfileRoute, validateAiTaskProfilePreviewRequest } from '@hon/domain';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

@Injectable()
export class HqAiProviderService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  private fail(error: unknown): never {
    const code = (error as { code?: string })?.code;
    if (code === '42501') throw new ForbiddenException({ code: 'PERMISSION_DENIED', detail: 'HQ AI control-plane access denied.' });
    if (code === '23505' || code === '40001') throw new ConflictException({ code: code === '23505' ? 'IDEMPOTENCY_CONFLICT' : 'VERSION_CONFLICT', detail: 'The configuration changed or the idempotency key was reused.' });
    if (code === 'P0002') throw new NotFoundException({ code: 'CONFIGURATION_NOT_FOUND', detail: 'The registered policy or task profile does not exist.' });
    if (['22023', '22P02', '22007', '22008', '22003', '23514', '23503', '23502'].includes(code ?? '') || (error instanceof Error && error.message === 'VALIDATION_FAILED')) {
      // Never echo submitted metadata, credentials, SQL errors, or references.
      throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Only approved non-secret control-plane fields and opaque credential references are accepted.' });
    }
    throw error;
  }

  async read(externalSubject: string): Promise<AiControlPlaneSnapshot> {
    try { return await this.database.readAiControlPlaneFromHq(externalSubject); } catch (error) { return this.fail(error); }
  }

  async write(externalSubject: string, kind: AiControlPlaneKind, input: unknown, idempotencyKey: unknown) {
    try {
      const payload = validateAiControlPlaneWrite(kind, input);
      const key = aiConfigUuid(idempotencyKey);
      return await this.database.writeAiControlPlaneFromHq(externalSubject, kind, payload, key, randomUUID());
    } catch (error) { return this.fail(error); }
  }

  async previewTaskProfile(externalSubject: string, input: unknown): Promise<AiTaskProfileDecision> {
    try {
      const request = validateAiTaskProfilePreviewRequest(input);
      const registry = await this.database.resolveAiTaskProfileRegistryFromHq(externalSubject, request.profileId);
      return decideAiTaskProfileRoute(request, registry);
    } catch (error) { return this.fail(error); }
  }

  async preview(externalSubject: string, input: unknown): Promise<AiRouteDecision> {
    try {
      const request = validateAiRouteRequest(input);
      const registry = await this.database.resolveAiRoutingRegistryFromHq(externalSubject, request.policyId);
      return decideAiRoute(request, registry);
    } catch (error) { return this.fail(error); }
  }
}
