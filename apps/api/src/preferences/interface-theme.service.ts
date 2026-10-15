import { ConflictException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { CommandContext, HonInterfaceTheme } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

export interface InterfaceThemePreference {
  interfaceTheme: HonInterfaceTheme;
  selectedVia: 'DEFAULT' | 'ONBOARDING' | 'SETTINGS';
  updatedAt?: string | undefined;
  replayed?: boolean | undefined;
}

type PreferenceRow = {
  interface_theme: HonInterfaceTheme;
  selected_via: 'ONBOARDING' | 'SETTINGS';
  updated_at: Date;
};

function fingerprint(input: { interfaceTheme: HonInterfaceTheme; selectedVia: 'ONBOARDING' | 'SETTINGS' }): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

@Injectable()
export class InterfaceThemeService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async get(context: CommandContext): Promise<InterfaceThemePreference> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<PreferenceRow>(
        `SELECT interface_theme, selected_via, updated_at
         FROM hon.principal_interface_preferences
         WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3`,
        [context.organizationId, context.schoolId, context.principalId],
      );
      const preference = result.rows[0];
      if (!preference) return { interfaceTheme: 'modern', selectedVia: 'DEFAULT' };
      return {
        interfaceTheme: preference.interface_theme,
        selectedVia: preference.selected_via,
        updatedAt: preference.updated_at.toISOString(),
      };
    });
  }

  async save(
    context: CommandContext,
    input: { interfaceTheme: HonInterfaceTheme; selectedVia: 'ONBOARDING' | 'SETTINGS' },
  ): Promise<InterfaceThemePreference> {
    const requestFingerprint = fingerprint(input);
    return this.database.withTenantTransaction(context, async (client) => {
      const reservation = await client.query<{ id: string }>(
        `INSERT INTO hon.idempotency_records (
           organization_id, school_id, principal_id, idempotency_key, request_fingerprint, status, expires_at
         ) VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', now() + interval '24 hours')
         ON CONFLICT (organization_id, school_id, principal_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, requestFingerprint],
      );
      if (!reservation.rowCount) {
        const existing = await client.query<{ request_fingerprint: string; status: 'IN_PROGRESS' | 'COMPLETED'; response_body: InterfaceThemePreference | null }>(
          `SELECT request_fingerprint, status, response_body
           FROM hon.idempotency_records
           WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4
           FOR UPDATE`,
          [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey],
        );
        const record = existing.rows[0];
        if (!record) throw new Error('HON interface preference idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The idempotency key was already used for another interface preference.' });
        }
        if (record.status === 'COMPLETED' && record.response_body) return { ...record.response_body, replayed: true };
        throw new ConflictException({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'The matching interface preference update is being processed.' });
      }

      const before = await client.query<PreferenceRow>(
        `SELECT interface_theme, selected_via, updated_at
         FROM hon.principal_interface_preferences
         WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3
         FOR UPDATE`,
        [context.organizationId, context.schoolId, context.principalId],
      );
      const upserted = await client.query<PreferenceRow>(
        `INSERT INTO hon.principal_interface_preferences (
           organization_id, school_id, principal_id, interface_theme, selected_via
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (organization_id, school_id, principal_id)
         DO UPDATE SET interface_theme = EXCLUDED.interface_theme, selected_via = EXCLUDED.selected_via, updated_at = now()
         RETURNING interface_theme, selected_via, updated_at`,
        [context.organizationId, context.schoolId, context.principalId, input.interfaceTheme, input.selectedVia],
      );
      const preference = upserted.rows[0];
      if (!preference) throw new Error('HON interface preference update did not return a record.');
      const responseBody: InterfaceThemePreference = {
        interfaceTheme: preference.interface_theme,
        selectedVia: preference.selected_via,
        updatedAt: preference.updated_at.toISOString(),
      };
      await client.query(
        `INSERT INTO hon.audit_events (
           organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
           prior_state, next_state, result, request_id, correlation_id, occurred_at
         ) VALUES ($1, $2, $3, $4, 'settings.interface_theme.update', 'INTERFACE_THEME_PREFERENCE', $3::uuid,
                   $5::jsonb, $6::jsonb, 'SUCCEEDED', $7::uuid, $8::uuid, now())`,
        [context.organizationId, context.schoolId, context.principalId, context.source, JSON.stringify(before.rows[0] ?? null), JSON.stringify(responseBody), context.requestId, context.correlationId],
      );
      await client.query(
        `INSERT INTO hon.outbox_events (
           id, organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id,
           aggregate_version, correlation_id, causation_id, payload
         ) VALUES ($1::uuid, $2, $3, 'settings.interface_theme.updated', 1, 'INTERFACE_THEME_PREFERENCE', $4::uuid, 1,
                   $5::uuid, $6::uuid, $7::jsonb)`,
        [randomUUID(), context.organizationId, context.schoolId, context.principalId, context.correlationId, context.requestId, JSON.stringify(responseBody)],
      );
      await client.query(
        `UPDATE hon.idempotency_records
         SET status = 'COMPLETED', response_status = 200, response_body = $5::jsonb
         WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4`,
        [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, JSON.stringify(responseBody)],
      );
      return responseBody;
    });
  }
}
