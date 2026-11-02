import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  CRM_APPOINTMENT_STATUSES,
  CRM_TRIAL_OUTCOME_STATUSES,
  type CommandContext,
  type CrmAppointmentStatus,
  type CrmAppointmentSummary,
  type CrmAppointmentType,
  type CrmTrialOutcomeStatus,
  type RecordTrialAppointmentOutcomeInput,
} from '@hon/contracts';
import { assertCurrentCrmAuthority } from './crm-authority-recheck.js';
import { assertCrmEntitlementInEffect } from './crm-entitlement.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface TrialAppointmentRow {
  id: string;
  crmLeadId: string;
  appointmentType: CrmAppointmentType;
  status: CrmAppointmentStatus;
  startsAt: Date | string;
  endsAt: Date | string;
  location: string | null;
  notes: string | null;
  createdByPrincipalId: string;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface IdempotencyRecord {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_body: CrmAppointmentSummary | null;
}

interface NormalizedOutcomeInput {
  status: CrmTrialOutcomeStatus;
  outcomeNotes?: string;
  expectedVersion: number;
}

function validationError(detail: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Repeats transport validation so non-HTTP callers cannot bypass invariants. */
function normalizeInput(input: RecordTrialAppointmentOutcomeInput): NormalizedOutcomeInput {
  if (!input || !CRM_TRIAL_OUTCOME_STATUSES.includes(input.status)) {
    throw validationError('status must be COMPLETED, NO_SHOW, or CANCELLED.');
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw validationError('expectedVersion must be a positive whole number.');
  }

  let outcomeNotes: string | undefined;
  if (input.outcomeNotes !== undefined) {
    if (typeof input.outcomeNotes !== 'string') {
      throw validationError('outcomeNotes must be a string when provided.');
    }
    outcomeNotes = input.outcomeNotes.trim();
    if (!outcomeNotes) throw validationError('outcomeNotes cannot be blank when provided.');
    if (outcomeNotes.length > 2000) {
      throw validationError('outcomeNotes must be at most 2000 characters.');
    }
  }

  return {
    status: input.status,
    ...(outcomeNotes === undefined ? {} : { outcomeNotes }),
    expectedVersion: input.expectedVersion,
  };
}

function toSummary(row: TrialAppointmentRow): CrmAppointmentSummary {
  if (!CRM_APPOINTMENT_STATUSES.includes(row.status)) {
    throw new Error('HON CRM appointment query returned an invalid status.');
  }
  return {
    id: row.id,
    crmLeadId: row.crmLeadId,
    appointmentType: row.appointmentType,
    status: row.status,
    startsAt: asIso(row.startsAt),
    endsAt: asIso(row.endsAt),
    ...(row.location === null ? {} : { location: row.location }),
    ...(row.notes === null ? {} : { notes: row.notes }),
    createdByPrincipalId: row.createdByPrincipalId,
    version: row.version,
    createdAt: asIso(row.createdAt),
    updatedAt: asIso(row.updatedAt),
  };
}

@Injectable()
export class TrialAppointmentOutcomeService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  /**
   * Records a final outcome for a trial appointment only. The state transition
   * is deliberately confined to crm_appointments: no lead, pipeline, booking,
   * student/family, enrollment, membership, provider, message, or AI state is
   * read or written by this command.
   */
  async record(
    context: CommandContext,
    appointmentId: string,
    input: RecordTrialAppointmentOutcomeInput,
    authority: { externalSubject: string },
  ): Promise<{ appointment: CrmAppointmentSummary; replayed: boolean }> {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI') {
      throw new ForbiddenException('HON trial outcome recording requires an authenticated human UI command.');
    }
    if (context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException('HON trial outcome recording cannot be delegated or action-engine executed.');
    }
    if (!UUID.test(appointmentId)) throw validationError('appointmentId must be a UUID.');

    const normalized = normalizeInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ command: 'crm.trial.outcome.record', appointmentId, ...normalized }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      // This lock lookup is RLS-scoped by the transaction-local tenant context;
      // an appointment in another school is indistinguishable from absent.
      const currentResult = await client.query<TrialAppointmentRow>(
        `SELECT
           id,
           crm_lead_id AS "crmLeadId",
           appointment_type::text AS "appointmentType",
           status::text AS status,
           starts_at AS "startsAt",
           ends_at AS "endsAt",
           location,
           notes,
           created_by_principal_id AS "createdByPrincipalId",
           version,
           created_at AS "createdAt",
           updated_at AS "updatedAt"
         FROM hon.crm_appointments
         WHERE id = $1::uuid
         FOR UPDATE`,
        [appointmentId],
      );
      // The controller authorized this command before the row lock above, which can wait behind another outcome for
      // the same appointment. Re-resolve the authority now, before any idempotency reservation or mutation.
      await assertCurrentCrmAuthority(client, authority.externalSubject, context, 'crm.trial.manage',
        'HON trial outcome recording is no longer authorized for this school.');
      await assertCrmEntitlementInEffect(client, 'An active HON CRM entitlement is required to record a trial outcome.');
      const current = currentResult.rows[0];
      if (!current) throw new NotFoundException('CRM appointment was not found in this school.');
      if (!CRM_APPOINTMENT_STATUSES.includes(current.status)) {
        throw new Error('HON CRM appointment query returned an invalid status.');
      }
      if (current.appointmentType !== 'TRIAL') {
        throw new ConflictException({
          code: 'CRM_APPOINTMENT_NOT_TRIAL',
          detail: 'Only a TRIAL appointment can have a trial outcome recorded.',
        });
      }

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
           WHERE organization_id = $1
             AND school_id = $2
             AND principal_id = $3
             AND idempotency_key = $4
           FOR UPDATE`,
          [
            context.organizationId,
            context.schoolId,
            context.principalId,
            context.idempotencyKey,
          ],
        );
        const record = existing.rows[0];
        if (!record) throw new Error('HON trial outcome idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            detail: 'The idempotency key was already used for a different trial outcome command.',
          });
        }
        if (record.status === 'COMPLETED' && record.response_body) {
          return { appointment: record.response_body, replayed: true };
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_IN_PROGRESS',
          detail: 'The matching trial outcome command is being processed.',
        });
      }

      if (current.status !== 'SCHEDULED') {
        throw new ConflictException({
          code: 'CRM_APPOINTMENT_NOT_SCHEDULED',
          detail: 'Only a scheduled CRM appointment can have a trial outcome recorded.',
        });
      }
      if (normalized.expectedVersion !== current.version) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          detail: 'The CRM appointment has changed. Refresh it and retry with its current version and a new Idempotency-Key.',
        });
      }

      // Recheck both lifecycle and version in the write itself. This protects
      // correctness even if this command is later adapted away from row locks.
      const updatedResult = await client.query<TrialAppointmentRow>(
        `UPDATE hon.crm_appointments
         SET status = $2::hon.crm_appointment_status,
             version = version + 1,
             updated_at = now()
         WHERE id = $1::uuid
           AND status = 'SCHEDULED'::hon.crm_appointment_status
           AND appointment_type = 'TRIAL'::hon.crm_appointment_type
           AND version = $3
         RETURNING
           id,
           crm_lead_id AS "crmLeadId",
           appointment_type::text AS "appointmentType",
           status::text AS status,
           starts_at AS "startsAt",
           ends_at AS "endsAt",
           location,
           notes,
           created_by_principal_id AS "createdByPrincipalId",
           version,
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [appointmentId, normalized.status, normalized.expectedVersion],
      );
      const updated = updatedResult.rows[0];
      if (!updated) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          detail: 'The CRM appointment changed before this trial outcome could be recorded.',
        });
      }

      const appointment = toSummary(updated);
      const priorState = {
        appointmentType: current.appointmentType,
        status: current.status,
        version: current.version,
      };
      const payload = {
        appointmentId: appointment.id,
        crmLeadId: appointment.crmLeadId,
        appointmentType: appointment.appointmentType,
        status: appointment.status,
        outcomeNotes: normalized.outcomeNotes ?? null,
        version: appointment.version,
      };

      // The one-row lifecycle write, immutable audit, durable v1 outbox event,
      // and replay response commit together. There is no downstream mutation.
      await client.query(
        `INSERT INTO hon.audit_events (
           organization_id, school_id, actor_principal_id, source, action_code,
           entity_type, entity_id, prior_state, next_state, result,
           request_id, correlation_id, action_request_id, occurred_at
         ) VALUES (
           $1, $2, $3, 'HUMAN_UI', 'crm.trial.outcome.record',
           'CRM_APPOINTMENT', $4::uuid, $5::jsonb, $6::jsonb, 'SUCCEEDED',
           $7::uuid, $8::uuid, NULL, now()
         )`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          appointment.id,
          JSON.stringify(priorState),
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
           $1::uuid, $2, $3, 'crm.trial.outcome.recorded', 1,
           'CRM_APPOINTMENT', $4::uuid, $5, $6::uuid, $7::uuid, $8::jsonb
         )`,
        [
          randomUUID(),
          context.organizationId,
          context.schoolId,
          appointment.id,
          appointment.version,
          context.correlationId,
          context.requestId,
          JSON.stringify(payload),
        ],
      );
      await client.query(
        `UPDATE hon.idempotency_records
         SET status = 'COMPLETED', response_status = 200, response_body = $5::jsonb
         WHERE organization_id = $1
           AND school_id = $2
           AND principal_id = $3
           AND idempotency_key = $4`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.idempotencyKey,
          JSON.stringify(appointment),
        ],
      );

      return { appointment, replayed: false };
    });
  }
}
