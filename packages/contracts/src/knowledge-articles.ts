/** The explicitly selected audience for a governed school knowledge article. */
export const KNOWLEDGE_ARTICLE_AUDIENCES = ['STAFF', 'PARENT_SAFE'] as const;
export type KnowledgeArticleAudience = (typeof KNOWLEDGE_ARTICLE_AUDIENCES)[number];

/** Lifecycle states are server-governed; client commands never supply lifecycle directly. */
export const KNOWLEDGE_ARTICLE_LIFECYCLES = ['DRAFT', 'APPROVED', 'ARCHIVED'] as const;
export type KnowledgeArticleLifecycle = (typeof KNOWLEDGE_ARTICLE_LIFECYCLES)[number];

/** A staff author may submit content only as a draft. Actor and lifecycle are server-derived. */
export interface CreateKnowledgeArticleInput {
  title: string;
  body: string;
  audience: KnowledgeArticleAudience;
}

/** Approval is a human, version-checked command with an explicit effective timestamp. */
export interface ApproveKnowledgeArticleInput {
  expectedVersion: number;
  effectiveFrom: string;
}

export interface KnowledgeArticleSummary {
  id: string;
  title: string;
  body: string;
  audience: KnowledgeArticleAudience;
  lifecycle: KnowledgeArticleLifecycle;
  effectiveFrom?: string | undefined;
  createdByPrincipalId: string;
  approvedByPrincipalId?: string | undefined;
  approvedAt?: string | undefined;
  version: number;
  createdAt: string;
  updatedAt: string;
}
