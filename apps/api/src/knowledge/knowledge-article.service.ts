import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  KNOWLEDGE_ARTICLE_AUDIENCES,
  KNOWLEDGE_ARTICLE_LIFECYCLES,
  type ApproveKnowledgeArticleInput,
  type CommandContext,
  type CreateKnowledgeArticleInput,
  type KnowledgeArticleAudience,
  type KnowledgeArticleLifecycle,
  type KnowledgeArticleSummary,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

type KnowledgeOperation = 'CREATED' | 'APPROVED';

interface KnowledgeArticleRow {
  id: string;
  title: string;
  body: string;
  audience: KnowledgeArticleAudience;
  lifecycle: KnowledgeArticleLifecycle;
  effectiveFrom: Date | string | null;
  createdByPrincipalId: string;
  approvedByPrincipalId: string | null;
  approvedAt: Date | string | null;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface IdempotencyRecord {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_body: KnowledgeArticleSummary | null;
}

interface NormalizedCreateInput {
  title: string;
  body: string;
  audience: KnowledgeArticleAudience;
}

interface NormalizedApprovalInput {
  expectedVersion: number;
  effectiveFrom: string;
}

function validationError(detail: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeCreateInput(input: CreateKnowledgeArticleInput): NormalizedCreateInput {
  if (typeof input.title !== 'string' || input.title.length > 240) {
    throw validationError('title is required and cannot exceed 240 characters.');
  }
  const title = input.title.trim();
  if (!title) throw validationError('title is required and cannot be blank.');

  if (typeof input.body !== 'string' || input.body.length > 100_000) {
    throw validationError('body is required and cannot exceed 100000 characters.');
  }
  // Preserve intentional Markdown formatting while rejecting whitespace-only content.
  if (!input.body.trim()) throw validationError('body is required and cannot be blank.');

  if (!KNOWLEDGE_ARTICLE_AUDIENCES.includes(input.audience)) {
    throw validationError('audience must be STAFF or PARENT_SAFE.');
  }

  return { title, body: input.body, audience: input.audience };
}

function normalizeApprovalInput(input: ApproveKnowledgeArticleInput): NormalizedApprovalInput {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw validationError('expectedVersion must be a positive whole number.');
  }
  if (typeof input.effectiveFrom !== 'string' || !input.effectiveFrom.trim()) {
    throw validationError('effectiveFrom is required and cannot be blank.');
  }
  const effectiveFrom = input.effectiveFrom.trim();
  // A timestamp (rather than a date-only value) removes locale-dependent start
  // of day semantics from publication governance.
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/i.test(effectiveFrom)) {
    throw validationError('effectiveFrom must be an ISO 8601 timestamp with a timezone.');
  }
  const parsed = new Date(effectiveFrom);
  if (Number.isNaN(parsed.getTime())) {
    throw validationError('effectiveFrom must be a valid ISO 8601 timestamp.');
  }
  return { expectedVersion: input.expectedVersion, effectiveFrom: parsed.toISOString() };
}

function toSummary(row: KnowledgeArticleRow): KnowledgeArticleSummary {
  if (!KNOWLEDGE_ARTICLE_AUDIENCES.includes(row.audience)) {
    throw new Error('HON knowledge article query returned an invalid audience.');
  }
  if (!KNOWLEDGE_ARTICLE_LIFECYCLES.includes(row.lifecycle)) {
    throw new Error('HON knowledge article query returned an invalid lifecycle.');
  }
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    audience: row.audience,
    lifecycle: row.lifecycle,
    ...(row.effectiveFrom === null ? {} : { effectiveFrom: asIso(row.effectiveFrom) }),
    createdByPrincipalId: row.createdByPrincipalId,
    ...(row.approvedByPrincipalId === null ? {} : { approvedByPrincipalId: row.approvedByPrincipalId }),
    ...(row.approvedAt === null ? {} : { approvedAt: asIso(row.approvedAt) }),
    version: row.version,
    createdAt: asIso(row.createdAt),
    updatedAt: asIso(row.updatedAt),
  };
}

function articleFacts(article: KnowledgeArticleSummary): Record<string, unknown> {
  return {
    knowledgeArticleId: article.id,
    title: article.title,
    audience: article.audience,
    lifecycle: article.lifecycle,
    effectiveFrom: article.effectiveFrom ?? null,
    createdByPrincipalId: article.createdByPrincipalId,
    approvedByPrincipalId: article.approvedByPrincipalId ?? null,
    approvedAt: article.approvedAt ?? null,
    version: article.version,
    // The immutable audit/outbox evidence identifies the exact content without
    // copying potentially sensitive school guidance into broad event feeds.
    contentSha256: createHash('sha256').update(article.body).digest('hex'),
  };
}

@Injectable()
export class KnowledgeArticleService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  /**
   * Deliberately a human staff command: it never invokes providers or the
   * Action Engine, and lifecycle/author identity are entirely server-derived.
   */
  async create(
    context: CommandContext,
    input: CreateKnowledgeArticleInput,
  ): Promise<{ article: KnowledgeArticleSummary; replayed: boolean; created: boolean }> {
    this.assertHumanDirectCommand(context, 'Knowledge article creation');
    const normalized = normalizeCreateInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      const replay = await this.reserveIdempotency(client, context, requestFingerprint);
      if (replay) return { article: replay, replayed: true, created: false };

      const inserted = await client.query<KnowledgeArticleRow>(
        `INSERT INTO hon.knowledge_articles (
           organization_id, school_id, title, body, audience, lifecycle, created_by_principal_id
         )
         VALUES ($1, $2, $3, $4, $5::hon.knowledge_article_audience,
                 'DRAFT'::hon.knowledge_article_lifecycle, $6::uuid)
         RETURNING
           id,
           title,
           body,
           audience::text AS audience,
           lifecycle::text AS lifecycle,
           effective_from AS "effectiveFrom",
           created_by_principal_id AS "createdByPrincipalId",
           approved_by_principal_id AS "approvedByPrincipalId",
           approved_at AS "approvedAt",
           version,
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [
          context.organizationId,
          context.schoolId,
          normalized.title,
          normalized.body,
          normalized.audience,
          context.principalId,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('HON knowledge article insert did not return a record.');
      const article = toSummary(row);
      await this.recordEvidence(client, context, article, 'CREATED', null, 201);
      return { article, replayed: false, created: true };
    });
  }

  /**
   * Approval is a separate human command. It requires another principal,
   * preserves optimistic concurrency, and cannot be delegated through actions.
   */
  async approve(
    context: CommandContext,
    articleId: string,
    input: ApproveKnowledgeArticleInput,
  ): Promise<{ article: KnowledgeArticleSummary; replayed: boolean }> {
    this.assertHumanDirectCommand(context, 'Knowledge article approval');
    if (!isUuid(articleId)) throw validationError('articleId must be a UUID.');
    const normalized = normalizeApprovalInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ articleId, ...normalized }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      // This RLS-scoped row lock means a foreign-school ID is indistinguishable
      // from an absent article, and serializes approve/retry races.
      const currentResult = await client.query<KnowledgeArticleRow>(
        `${this.articleSelectSql()}
         WHERE id = $1::uuid
         FOR UPDATE`,
        [articleId],
      );
      const currentRow = currentResult.rows[0];
      if (!currentRow) throw new NotFoundException('Knowledge article was not found in this school.');
      const current = toSummary(currentRow);

      const replay = await this.reserveIdempotency(client, context, requestFingerprint);
      if (replay) return { article: replay, replayed: true };

      if (current.createdByPrincipalId === context.principalId) {
        throw new ForbiddenException({
          code: 'SELF_APPROVAL_FORBIDDEN',
          detail: 'The principal who created a knowledge article cannot approve it.',
        });
      }
      if (current.lifecycle !== 'DRAFT') {
        throw new ConflictException({
          code: 'ARTICLE_NOT_DRAFT',
          detail: 'Only a DRAFT knowledge article can be approved.',
        });
      }
      if (current.version !== normalized.expectedVersion) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          detail: 'The knowledge article has changed. Refresh it and retry with its current version and a new Idempotency-Key.',
        });
      }

      const approvedResult = await client.query<KnowledgeArticleRow>(
        `UPDATE hon.knowledge_articles
         SET lifecycle = 'APPROVED'::hon.knowledge_article_lifecycle,
             effective_from = $2::timestamptz,
             approved_by_principal_id = $3::uuid,
             approved_at = now(),
             version = version + 1,
             updated_at = now()
         WHERE id = $1::uuid
           AND lifecycle = 'DRAFT'::hon.knowledge_article_lifecycle
           AND version = $4
         RETURNING
           id,
           title,
           body,
           audience::text AS audience,
           lifecycle::text AS lifecycle,
           effective_from AS "effectiveFrom",
           created_by_principal_id AS "createdByPrincipalId",
           approved_by_principal_id AS "approvedByPrincipalId",
           approved_at AS "approvedAt",
           version,
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [articleId, normalized.effectiveFrom, context.principalId, normalized.expectedVersion],
      );
      const approvedRow = approvedResult.rows[0];
      if (!approvedRow) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          detail: 'The knowledge article changed before it could be approved.',
        });
      }
      const article = toSummary(approvedRow);
      await this.recordEvidence(client, context, article, 'APPROVED', articleFacts(current), 200);
      return { article, replayed: false };
    });
  }

  private assertHumanDirectCommand(context: CommandContext, command: string): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI') {
      throw new ForbiddenException(`${command} requires a human staff UI command.`);
    }
    if (context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException(`${command} cannot be proposed or executed through delegated actions.`);
    }
  }

  private articleSelectSql(): string {
    return `SELECT
      id,
      title,
      body,
      audience::text AS audience,
      lifecycle::text AS lifecycle,
      effective_from AS "effectiveFrom",
      created_by_principal_id AS "createdByPrincipalId",
      approved_by_principal_id AS "approvedByPrincipalId",
      approved_at AS "approvedAt",
      version,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM hon.knowledge_articles`;
  }

  private async reserveIdempotency(
    client: PoolClient,
    context: CommandContext,
    requestFingerprint: string,
  ): Promise<KnowledgeArticleSummary | undefined> {
    const reservation = await client.query<{ id: string }>(
      `INSERT INTO hon.idempotency_records (
         organization_id, school_id, principal_id, idempotency_key, request_fingerprint, status, expires_at
       )
       VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', now() + interval '24 hours')
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
    if (reservation.rowCount) return undefined;

    const existing = await client.query<IdempotencyRecord>(
      `SELECT request_fingerprint, status, response_body
       FROM hon.idempotency_records
       WHERE organization_id = $1
         AND school_id = $2
         AND principal_id = $3
         AND idempotency_key = $4
       FOR UPDATE`,
      [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey],
    );
    const record = existing.rows[0];
    if (!record) throw new Error('HON knowledge idempotency record unexpectedly missing.');
    if (record.request_fingerprint !== requestFingerprint) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        detail: 'The idempotency key was already used for a different knowledge article command.',
      });
    }
    if (record.status === 'COMPLETED' && record.response_body) return record.response_body;
    throw new ConflictException({
      code: 'IDEMPOTENCY_IN_PROGRESS',
      detail: 'The matching knowledge article command is being processed.',
    });
  }

  private async recordEvidence(
    client: PoolClient,
    context: CommandContext,
    article: KnowledgeArticleSummary,
    operation: KnowledgeOperation,
    priorState: Record<string, unknown> | null,
    responseStatus: number,
  ): Promise<void> {
    const payload = { ...articleFacts(article), operation };
    const actionCode = operation === 'CREATED' ? 'knowledge.article.create' : 'knowledge.article.approve';
    const eventType = operation === 'CREATED' ? 'knowledge.article.created' : 'knowledge.article.approved';

    await client.query(
      `INSERT INTO hon.audit_events (
         organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
         prior_state, next_state, result, request_id, correlation_id, action_request_id, occurred_at
       )
       VALUES ($1, $2, $3, $4, $5, 'KNOWLEDGE_ARTICLE', $6::uuid,
               $7::jsonb, $8::jsonb, 'SUCCEEDED', $9::uuid, $10::uuid, NULL, now())`,
      [
        context.organizationId,
        context.schoolId,
        context.principalId,
        context.source,
        actionCode,
        article.id,
        priorState === null ? null : JSON.stringify(priorState),
        JSON.stringify(payload),
        context.requestId,
        context.correlationId,
      ],
    );
    await client.query(
      `INSERT INTO hon.outbox_events (
         id, organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id,
         aggregate_version, correlation_id, causation_id, payload
       )
       VALUES ($1::uuid, $2, $3, $4, 1, 'KNOWLEDGE_ARTICLE', $5::uuid,
               $6, $7::uuid, $8::uuid, $9::jsonb)`,
      [
        randomUUID(),
        context.organizationId,
        context.schoolId,
        eventType,
        article.id,
        article.version,
        context.correlationId,
        context.requestId,
        JSON.stringify(payload),
      ],
    );
    await client.query(
      `UPDATE hon.idempotency_records
       SET status = 'COMPLETED', response_status = $5, response_body = $6::jsonb
       WHERE organization_id = $1
         AND school_id = $2
         AND principal_id = $3
         AND idempotency_key = $4`,
      [
        context.organizationId,
        context.schoolId,
        context.principalId,
        context.idempotencyKey,
        responseStatus,
        JSON.stringify(article),
      ],
    );
  }
}
