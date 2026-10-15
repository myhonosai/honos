import { ForbiddenException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ParentFamilyKnowledge } from '@hon/contracts';
import type { ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

interface ParentFamilyKnowledgeArticleRow {
  id: string;
  title: string;
  body: string;
  effectiveFrom: Date | string;
  version: number;
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Read-only Parent/Eian knowledge projection. The controller supplies an exact
 * family scope from resolveParentFamilyScopes; this service rejects accidental
 * scope reuse before binding only resolver-derived tenant values to RLS.
 */
@Injectable()
export class ParentFamilyKnowledgeService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async get(
    resolvedScope: ResolvedParentFamilyScope,
    requestedFamilyId: string,
    requestId: string,
  ): Promise<ParentFamilyKnowledge> {
    if (resolvedScope.familyId !== requestedFamilyId) {
      throw new ForbiddenException('HON parent access is not authorized for this family.');
    }

    return this.database.withTenantTransaction(
      {
        // No organization, school, or principal value is accepted from the
        // route or request body. Every RLS context value is resolver-derived.
        organizationId: resolvedScope.organizationId,
        schoolId: resolvedScope.schoolId,
        principalId: resolvedScope.principalId,
        principalType: 'HUMAN_USER',
        requestId,
      },
      async (client) => ({ articles: await this.selectPublishedParentSafeArticles(client) }),
    );
  }

  private async selectPublishedParentSafeArticles(
    client: PoolClient,
  ): Promise<ParentFamilyKnowledge['articles']> {
    // This is intentionally a fixed school-publication query rather than an
    // article directory. Its predicates exclude STAFF, DRAFT, ARCHIVED, and
    // scheduled future content even if a caller is otherwise family-authorized.
    const result = await client.query<ParentFamilyKnowledgeArticleRow>(
      `SELECT
         id,
         title,
         body,
         effective_from AS "effectiveFrom",
         version
       FROM hon.knowledge_articles
       WHERE lifecycle = 'APPROVED'::hon.knowledge_article_lifecycle
         AND audience = 'PARENT_SAFE'::hon.knowledge_article_audience
         AND effective_from <= now()
       ORDER BY effective_from DESC, id ASC`,
    );

    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      effectiveFrom: asIso(row.effectiveFrom),
      version: row.version,
    }));
  }
}
