import { Controller, ForbiddenException, Get, Inject, Injectable, Param, ParseUUIDPipe, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { composeAiTeamReadiness, validateAiTeamReadinessRow, type AiTeamReadyAgentKey } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { MARKETING_PROVIDER_RUNTIME, type ProviderRuntime } from '../ai/provider-runtime.js';
import { CLAIRE_PROVIDER_RUNTIME } from '../ai/claire-provider-runtime.js';
import { CHAD_PROVIDER_RUNTIME } from '../ai/chad-provider-runtime.js';
import { HON_REPLY_PROVIDER_RUNTIME } from '../ai/hon-reply-provider-runtime.js';

type Readiness = { readiness(providerId: string): string };

/**
 * AI-R1: which live AI team members the requesting human can use now at this school, and the first gate that refuses.
 * The database decides authorization (each agent's own gate), the S4-c spend decision, the HQ route and the S4-b budget.
 * The server runtime state is read locally; no provider is called and nothing is written.
 */
@Injectable()
export class AiTeamReadinessService {
  constructor(
    private readonly database: RuntimeDatabaseService,
    @Inject(MARKETING_PROVIDER_RUNTIME) private readonly marcus: ProviderRuntime,
    @Inject(CLAIRE_PROVIDER_RUNTIME) private readonly claire: Readiness,
    @Inject(CHAD_PROVIDER_RUNTIME) private readonly chad: Readiness,
    @Inject(HON_REPLY_PROVIDER_RUNTIME) private readonly hon: Readiness,
  ) {}
  async read(context: { organizationId: string; schoolId: string; principalId: string; externalSubject: string }) {
    const requestId = randomUUID();
    let row: unknown;
    try {
      row = await this.database.withTenantTransaction({ ...context, principalType: 'HUMAN_USER', requestId }, async (client) => {
        await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)");
        await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'");
        return (await client.query<{ data: unknown }>('SELECT hon.read_ai_team_readiness($1) data', [context.externalSubject])).rows[0]?.data;
      });
    } catch (error) {
      if ((error as { code?: string }).code === '42501') throw new ForbiddenException({ code: 'AI_TEAM_READINESS_FORBIDDEN' });
      throw new ServiceUnavailableException({ code: 'AI_TEAM_READINESS_UNAVAILABLE' });
    }
    let validated;
    try { validated = validateAiTeamReadinessRow(row); } catch { throw new ServiceUnavailableException({ code: 'AI_TEAM_READINESS_UNAVAILABLE' }); }
    if (validated.organizationId !== context.organizationId || validated.schoolId !== context.schoolId) throw new ServiceUnavailableException({ code: 'AI_TEAM_READINESS_UNAVAILABLE' });
    const runtimes: Record<AiTeamReadyAgentKey, Readiness> = { marcus: this.marcus, claire: this.claire, chad: this.chad, hon: this.hon };
    return { data: composeAiTeamReadiness(validated, (key) => (runtimes[key].readiness('OPENROUTER') === 'READY' ? 'READY' : 'CONFIGURATION_REQUIRED')), meta: { requestId, correlationId: requestId } };
  }
}

@Controller('organizations/:organizationId/schools/:schoolId/ai/team/capabilities')
@UseGuards(HonIdentityGuard)
export class AiTeamReadinessController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly readiness: AiTeamReadinessService) {}
  @Get()
  async read(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string, @Req() request: HonRequest) {
    const identity = request.honIdentity;
    if (!identity || Object.keys(request.query ?? {}).length > 0) throw new ForbiddenException({ code: 'AI_TEAM_READINESS_FORBIDDEN' });
    // The path is not authority: the live resolver derives principal and school from the verified identity.
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'ai.invocation.plan');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException({ code: 'AI_TEAM_READINESS_FORBIDDEN' });
    request.res?.setHeader('Cache-Control', 'private, no-store');
    return this.readiness.read({ organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, externalSubject: identity.externalSubject });
  }
}
