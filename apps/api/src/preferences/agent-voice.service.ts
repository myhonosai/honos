import { ConflictException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { HON_VOICE_AGENT_KEYS, type CommandContext, type HonAgentVoiceChoice, type HonAgentVoiceChoices, type HonVoiceAgentKey } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

export interface AgentVoicePreferences { choices: HonAgentVoiceChoices; replayed?: boolean | undefined }
type Row = { agent_key: HonVoiceAgentKey; voice_choice: number };
type Client = { query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }> };

/** Every teammate, with 1 (the original voice) where this person has not chosen one. */
export function agentVoiceChoices(rows: readonly Row[]): HonAgentVoiceChoices {
  const out = Object.fromEntries(HON_VOICE_AGENT_KEYS.map((k) => [k, 1])) as HonAgentVoiceChoices;
  for (const row of rows) if ((HON_VOICE_AGENT_KEYS as readonly string[]).includes(row.agent_key)) out[row.agent_key] = row.voice_choice as HonAgentVoiceChoice;
  return out;
}

const SELECT = `SELECT agent_key, voice_choice FROM hon.principal_agent_voice_preferences
  WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3`;

/** 0460: a person's own voice choice per AI teammate in this school (same scope rules as the interface theme). */
@Injectable()
export class AgentVoiceService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async get(context: CommandContext): Promise<AgentVoicePreferences> {
    return this.database.withTenantTransaction(context, async (client: Client) => {
      const result = await client.query<Row>(SELECT, [context.organizationId, context.schoolId, context.principalId]);
      return { choices: agentVoiceChoices(result.rows) };
    });
  }

  async save(context: CommandContext, input: { agentKey: HonVoiceAgentKey; voiceChoice: HonAgentVoiceChoice }): Promise<AgentVoicePreferences> {
    const requestFingerprint = createHash('sha256').update(JSON.stringify({ kind: 'agent-voice', agentKey: input.agentKey, voiceChoice: input.voiceChoice })).digest('hex');
    const scope = [context.organizationId, context.schoolId, context.principalId];
    return this.database.withTenantTransaction(context, async (client: Client) => {
      const reservation = await client.query<{ id: string }>(
        `INSERT INTO hon.idempotency_records (organization_id, school_id, principal_id, idempotency_key, request_fingerprint, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', now() + interval '24 hours')
         ON CONFLICT (organization_id, school_id, principal_id, idempotency_key) DO NOTHING RETURNING id`,
        [...scope, context.idempotencyKey, requestFingerprint],
      );
      if (!reservation.rowCount) {
        const existing = await client.query<{ request_fingerprint: string; status: string; response_body: AgentVoicePreferences | null }>(
          `SELECT request_fingerprint, status, response_body FROM hon.idempotency_records
           WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4 FOR UPDATE`,
          [...scope, context.idempotencyKey],
        );
        const record = existing.rows[0];
        if (!record) throw new Error('HON agent voice idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The idempotency key was already used for another voice choice.' });
        }
        if (record.status === 'COMPLETED' && record.response_body) return { ...record.response_body, replayed: true };
        throw new ConflictException({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'The matching voice choice is being saved.' });
      }
      const before = await client.query<Row>(`${SELECT} AND agent_key = $4 FOR UPDATE`, [...scope, input.agentKey]);
      await client.query(
        `INSERT INTO hon.principal_agent_voice_preferences (organization_id, school_id, principal_id, agent_key, voice_choice)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (organization_id, school_id, principal_id, agent_key)
         DO UPDATE SET voice_choice = EXCLUDED.voice_choice, updated_at = now()`,
        [...scope, input.agentKey, input.voiceChoice],
      );
      const all = await client.query<Row>(SELECT, scope);
      const responseBody: AgentVoicePreferences = { choices: agentVoiceChoices(all.rows) };
      const change = { agentKey: input.agentKey, voiceChoice: input.voiceChoice };
      await client.query(
        `INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
           prior_state, next_state, result, request_id, correlation_id, occurred_at)
         VALUES ($1, $2, $3, $4, 'settings.agent_voice.update', 'AGENT_VOICE_PREFERENCE', $3::uuid, $5::jsonb, $6::jsonb, 'SUCCEEDED', $7::uuid, $8::uuid, now())`,
        [...scope, context.source, JSON.stringify(before.rows[0] ? { agentKey: input.agentKey, voiceChoice: before.rows[0].voice_choice } : null), JSON.stringify(change), context.requestId, context.correlationId],
      );
      await client.query(
        `INSERT INTO hon.outbox_events (id, organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id,
           aggregate_version, correlation_id, causation_id, payload)
         VALUES ($1::uuid, $2, $3, 'settings.agent_voice.updated', 1, 'AGENT_VOICE_PREFERENCE', $4::uuid, 1, $5::uuid, $6::uuid, $7::jsonb)`,
        [randomUUID(), context.organizationId, context.schoolId, context.principalId, context.correlationId, context.requestId, JSON.stringify(change)],
      );
      await client.query(
        `UPDATE hon.idempotency_records SET status = 'COMPLETED', response_status = 200, response_body = $5::jsonb
         WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4`,
        [...scope, context.idempotencyKey, JSON.stringify(responseBody)],
      );
      return responseBody;
    });
  }
}
