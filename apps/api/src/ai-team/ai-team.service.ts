import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  AI_TEAM_CATALOG,
  aiTeamAgentDefinition,
} from '@hon/config';
import {
  HON_AI_TEAM_AGENT_KEYS,
  HON_AI_TEAM_AVATAR_KEYS,
  HON_AI_TEAM_VOICE_PROFILES,
  type AiTeamDirectory,
  type AiTeamDirectoryAgent,
  type AiTeamPresentation,
  type CommandContext,
  type HonAiTeamAgentKey,
  type HonAiTeamAvatarKey,
  type HonAiTeamVoiceProfile,
  type UpdateAiTeamPresentationInput,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

interface PresentationPreferenceRow {
  id: string;
  agentKey: string;
  displayName: string | null;
  avatarKey: string | null;
  voiceProfile: string | null;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface IdempotencyRecord {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_body: AiTeamDirectoryAgent | null;
}

interface NormalizedPresentationInput {
  expectedVersion: number;
  displayName?: string | undefined;
  avatarKey?: HonAiTeamAvatarKey | undefined;
  voiceProfile?: HonAiTeamVoiceProfile | undefined;
}

const DISPLAY_NAME = /^[A-Za-z0-9][A-Za-z0-9 .,'-]{0,79}$/;
const PATCH_FIELDS = new Set(['expectedVersion', 'displayName', 'avatarKey', 'voiceProfile']);

function validationError(detail: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw validationError('displayName must be a string.');
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 80 || !DISPLAY_NAME.test(normalized)) {
    throw validationError('displayName must contain 1 to 80 safe letters, numbers, spaces, periods, commas, apostrophes, or hyphens.');
  }
  return normalized;
}

/**
 * Validates the runtime shape as well as DTO validation. This protects direct
 * callers and makes forbidden control-plane fields fail closed rather than
 * being silently ignored.
 */
export function normalizeAiTeamPresentationInput(input: UpdateAiTeamPresentationInput): NormalizedPresentationInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw validationError('A presentation update object is required.');
  }
  for (const key of Object.keys(input)) {
    if (!PATCH_FIELDS.has(key)) {
      throw validationError(`Field ${key} is not allowed for AI Team presentation customization.`);
    }
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw validationError('expectedVersion must be a non-negative whole number; use 0 when no presentation override exists.');
  }

  const hasDisplayName = hasOwn(input, 'displayName');
  const hasAvatarKey = hasOwn(input, 'avatarKey');
  const hasVoiceProfile = hasOwn(input, 'voiceProfile');
  if (!hasDisplayName && !hasAvatarKey && !hasVoiceProfile) {
    throw validationError('At least one safe presentation field must be provided.');
  }

  const normalized: NormalizedPresentationInput = { expectedVersion: input.expectedVersion };
  if (hasDisplayName) normalized.displayName = normalizeDisplayName(input.displayName);
  if (hasAvatarKey) {
    if (!HON_AI_TEAM_AVATAR_KEYS.includes(input.avatarKey as HonAiTeamAvatarKey)) {
      throw validationError('avatarKey must be an approved static HON agent asset key.');
    }
    normalized.avatarKey = input.avatarKey as HonAiTeamAvatarKey;
  }
  if (hasVoiceProfile) {
    if (!HON_AI_TEAM_VOICE_PROFILES.includes(input.voiceProfile as HonAiTeamVoiceProfile)) {
      throw validationError('voiceProfile must be an approved provider-neutral presentation preset.');
    }
    normalized.voiceProfile = input.voiceProfile as HonAiTeamVoiceProfile;
  }
  return normalized;
}

function agentKeyOrThrow(agentKey: string): HonAiTeamAgentKey {
  if (!HON_AI_TEAM_AGENT_KEYS.includes(agentKey as HonAiTeamAgentKey)) {
    throw validationError('agentKey must identify one of the approved static HON AI Team members.');
  }
  return agentKey as HonAiTeamAgentKey;
}

function preferenceState(row: PresentationPreferenceRow | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    agentKey: row.agentKey,
    displayName: row.displayName,
    avatarKey: row.avatarKey,
    voiceProfile: row.voiceProfile,
    version: row.version,
  };
}

function toDirectoryAgent(row: PresentationPreferenceRow | undefined, agentKey: HonAiTeamAgentKey): AiTeamDirectoryAgent {
  const definition = aiTeamAgentDefinition(agentKey);
  if (!definition) throw new Error('HON AI Team static catalog is missing an approved agent definition.');
  if (row && (row.agentKey !== agentKey
    || !Number.isSafeInteger(row.version)
    || row.version < 1
    || (row.avatarKey !== null && !HON_AI_TEAM_AVATAR_KEYS.includes(row.avatarKey as HonAiTeamAvatarKey))
    || (row.voiceProfile !== null && !HON_AI_TEAM_VOICE_PROFILES.includes(row.voiceProfile as HonAiTeamVoiceProfile)))) {
    throw new Error('HON AI Team presentation query returned an invalid persisted preference.');
  }

  const presentation: AiTeamPresentation = {
    displayName: row?.displayName ?? definition.defaultDisplayName,
    avatarKey: (row?.avatarKey ?? definition.defaultAvatarKey) as HonAiTeamAvatarKey,
    voiceProfile: (row?.voiceProfile ?? definition.defaultVoiceProfile) as HonAiTeamVoiceProfile,
    version: row?.version ?? 0,
    ...(row ? { updatedAt: asIso(row.updatedAt) } : {}),
  };
  return { ...definition, presentation };
}

@Injectable()
export class AiTeamService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  private assertHumanPresentationCommand(context: CommandContext): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI') {
      throw new ForbiddenException('AI Team presentation customization is a human user interface command only.');
    }
    if (context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException('AI Team presentation customization cannot be proposed or executed through Action Engine or delegation.');
    }
  }

  /** Checks the live database entitlement; no client tier assertion is accepted. */
  private async requireCompleteEntitlement(client: PoolClient, organizationId: string): Promise<void> {
    const result = await client.query(
      `SELECT 1
       FROM hon.organization_entitlements
       WHERE organization_id = $1::uuid
         AND tier = 'COMPLETE'::hon.plan_tier
         AND status = 'ACTIVE'::hon.membership_status
         AND effective_from <= now()
         AND (effective_until IS NULL OR effective_until > now())
       LIMIT 1`,
      [organizationId],
    );
    if (!result.rowCount) {
      throw new ForbiddenException({
        code: 'TIER_ENTITLEMENT_REQUIRED',
        detail: 'An active HON Complete entitlement is required for AI Team presentation access.',
      });
    }
  }

  /**
   * Read-only static catalog plus this school's safe presentation overrides.
   * It never returns or changes a principal, tool, authority, model, fallback,
   * provider, payment, role, or action/work-item state.
   */
  async list(context: CommandContext): Promise<AiTeamDirectory> {
    return this.database.withTenantTransaction(context, async (client) => {
      await this.requireCompleteEntitlement(client, context.organizationId);
      const result = await client.query<PresentationPreferenceRow>(
        `SELECT
           id,
           agent_key AS "agentKey",
           display_name AS "displayName",
           avatar_key AS "avatarKey",
           voice_profile AS "voiceProfile",
           version,
           created_at AS "createdAt",
           updated_at AS "updatedAt"
         FROM hon.ai_team_presentation_preferences
         WHERE organization_id = $1::uuid
           AND school_id = $2::uuid`,
        [context.organizationId, context.schoolId],
      );
      const preferences = new Map(result.rows.map((row) => [row.agentKey, row]));
      return {
        agents: AI_TEAM_CATALOG.map((definition) => toDirectoryAgent(
          preferences.get(definition.agentKey), definition.agentKey,
        )),
      };
    });
  }

  /**
   * Updates only a static agent's safe visible presentation. The transaction
   * atomically persists the preference, audit evidence, outbox event, and
   * idempotency completion. It intentionally contains no AI, voice, provider,
   * Action Engine, work-item, payment, permission, or role operation.
   */
  async update(
    context: CommandContext,
    suppliedAgentKey: string,
    input: UpdateAiTeamPresentationInput,
  ): Promise<{ agent: AiTeamDirectoryAgent; replayed: boolean }> {
    this.assertHumanPresentationCommand(context);
    const agentKey = agentKeyOrThrow(suppliedAgentKey);
    const normalized = normalizeAiTeamPresentationInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ agentKey, ...normalized }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      await this.requireCompleteEntitlement(client, context.organizationId);
      const reservation = await client.query<{ id: string }>(
        `INSERT INTO hon.idempotency_records (
           organization_id, school_id, principal_id, idempotency_key, request_fingerprint, status, expires_at
         ) VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', now() + interval '24 hours')
         ON CONFLICT (organization_id, school_id, principal_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.idempotencyKey,
          requestFingerprint,
        ],
      );
      if (!reservation.rowCount) {
        const existing = await client.query<IdempotencyRecord>(
          `SELECT request_fingerprint, status, response_body
           FROM hon.idempotency_records
           WHERE organization_id = $1::uuid
             AND school_id = $2::uuid
             AND principal_id = $3::uuid
             AND idempotency_key = $4
           FOR UPDATE`,
          [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey],
        );
        const record = existing.rows[0];
        if (!record) throw new Error('HON AI Team presentation idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            detail: 'The idempotency key was already used for a different AI Team presentation update.',
          });
        }
        if (record.status === 'COMPLETED' && record.response_body) {
          return { agent: record.response_body, replayed: true };
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_IN_PROGRESS',
          detail: 'The matching AI Team presentation update is being processed.',
        });
      }

      const priorResult = await client.query<PresentationPreferenceRow>(
        `SELECT
           id,
           agent_key AS "agentKey",
           display_name AS "displayName",
           avatar_key AS "avatarKey",
           voice_profile AS "voiceProfile",
           version,
           created_at AS "createdAt",
           updated_at AS "updatedAt"
         FROM hon.ai_team_presentation_preferences
         WHERE organization_id = $1::uuid
           AND school_id = $2::uuid
           AND agent_key = $3
         FOR UPDATE`,
        [context.organizationId, context.schoolId, agentKey],
      );
      const prior = priorResult.rows[0];
      const actualVersion = prior?.version ?? 0;
      if (normalized.expectedVersion !== actualVersion) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          detail: 'The AI Team presentation has changed. Refresh it and retry with its current version and a new Idempotency-Key.',
        });
      }

      const updatedResult = await client.query<PresentationPreferenceRow>(
        `INSERT INTO hon.ai_team_presentation_preferences (
           organization_id, school_id, agent_key, display_name, avatar_key, voice_profile
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
         ON CONFLICT (organization_id, school_id, agent_key)
         DO UPDATE SET
           display_name = CASE WHEN $7 THEN EXCLUDED.display_name ELSE hon.ai_team_presentation_preferences.display_name END,
           avatar_key = CASE WHEN $8 THEN EXCLUDED.avatar_key ELSE hon.ai_team_presentation_preferences.avatar_key END,
           voice_profile = CASE WHEN $9 THEN EXCLUDED.voice_profile ELSE hon.ai_team_presentation_preferences.voice_profile END,
           version = hon.ai_team_presentation_preferences.version + 1,
           updated_at = now()
         WHERE hon.ai_team_presentation_preferences.version = $10
         RETURNING
           id,
           agent_key AS "agentKey",
           display_name AS "displayName",
           avatar_key AS "avatarKey",
           voice_profile AS "voiceProfile",
           version,
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [
          context.organizationId,
          context.schoolId,
          agentKey,
          normalized.displayName ?? null,
          normalized.avatarKey ?? null,
          normalized.voiceProfile ?? null,
          hasOwn(normalized, 'displayName'),
          hasOwn(normalized, 'avatarKey'),
          hasOwn(normalized, 'voiceProfile'),
          normalized.expectedVersion,
        ],
      );
      const updated = updatedResult.rows[0];
      if (!updated) {
        // A concurrent first insert can be invisible to the locked read above;
        // the guarded upsert still fails closed on its observed version.
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          detail: 'The AI Team presentation changed before this update could be recorded.',
        });
      }

      const agent = toDirectoryAgent(updated, agentKey);
      const payload = { agentKey, presentation: agent.presentation };
      await client.query(
        `INSERT INTO hon.audit_events (
           organization_id, school_id, actor_principal_id, source, action_code,
           entity_type, entity_id, prior_state, next_state, result,
           request_id, correlation_id, action_request_id, occurred_at
         ) VALUES (
           $1, $2, $3, 'HUMAN_UI', 'ai.team.presentation.update',
           'AI_TEAM_PRESENTATION_PREFERENCE', $4::uuid, $5::jsonb, $6::jsonb, 'SUCCEEDED',
           $7::uuid, $8::uuid, NULL, now()
         )`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          updated.id,
          JSON.stringify(preferenceState(prior)),
          JSON.stringify(payload),
          context.requestId,
          context.correlationId,
        ],
      );
      await client.query(
        `INSERT INTO hon.outbox_events (
           id, organization_id, school_id, event_type, schema_version,
           aggregate_type, aggregate_id, aggregate_version, correlation_id,
           causation_id, payload
         ) VALUES (
           $1::uuid, $2, $3, 'ai.team.presentation.updated', 1,
           'AI_TEAM_PRESENTATION_PREFERENCE', $4::uuid, $5, $6::uuid, $7::uuid, $8::jsonb
         )`,
        [
          randomUUID(),
          context.organizationId,
          context.schoolId,
          updated.id,
          updated.version,
          context.correlationId,
          context.requestId,
          JSON.stringify(payload),
        ],
      );
      await client.query(
        `UPDATE hon.idempotency_records
         SET status = 'COMPLETED', response_status = 200, response_body = $5::jsonb
         WHERE organization_id = $1::uuid
           AND school_id = $2::uuid
           AND principal_id = $3::uuid
           AND idempotency_key = $4`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.idempotencyKey,
          JSON.stringify(agent),
        ],
      );
      return { agent, replayed: false };
    });
  }
}
