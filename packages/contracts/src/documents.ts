import type { CommandContext } from './index.js';

/** No STUDENT principal-to-student resolver exists yet: fail closed, never infer it from a parent or staff role. */
export type DocumentAudience = 'STAFF' | 'PARENT';
export const DOCUMENT_PERMISSION_CODES = ['document.template.create', 'document.template.version', 'document.publish', 'document.read', 'document.acknowledge', 'document.evidence.read'] as const;
export const DOCUMENT_ACTION_CODES = ['document.template.create', 'document.template.version', 'document.publish', 'document.acknowledge'] as const;
export type DocumentActionCode = (typeof DOCUMENT_ACTION_CODES)[number];
export interface DocumentCommandContext extends CommandContext { externalSubject: string; audienceMode: DocumentAudience }
export type CreateDocumentTemplateInput = { title: string; content: string } & ({ audience: 'STAFF' } | { audience: 'PARENT'; familyId: string });
export interface CreateDocumentVersionInput { expectedVersion: number; title: string; content: string }
export interface PublishDocumentInput { expectedVersion: number; versionId: string }
/** All actor, tenant, family, version and timestamp evidence is server derived. No signature image or person ID. */
export interface AcknowledgeDocumentInput { contentHash: string; choice: 'ACKNOWLEDGE'; attestationText?: string }
export interface DocumentTemplateRecord {
  id: string; audience: DocumentAudience; familyId: string | null; version: number; latestVersionId: string;
  versionId: string; versionNumber: number; title: string; content: string; contentHash: string; currentPublicationId: string | null;
}
export interface DocumentVersionRecord { id: string; templateId: string; versionNumber: number; title: string; content: string; contentHash: string; createdAt: string }
export interface DocumentPublicationRecord {
  id: string; templateId: string; versionId: string; versionNumber: number; audience: DocumentAudience;
  title: string; content: string; contentHash: string; publishedAt: string; current: boolean;
}
export interface DocumentAcknowledgementEvidence {
  schemaVersion: 1; kind: 'INTERNAL_HUMAN_ACKNOWLEDGEMENT'; id: string; organizationId: string; schoolId: string;
  publicationId: string; versionId: string; contentHash: string; signerPrincipalId: string; audience: DocumentAudience;
  familyId: string | null; choice: 'ACKNOWLEDGE'; attestationText: string | null; acknowledgedAt: string;
  source: 'HUMAN_UI'; requestId: string; correlationId: string; evidenceHash: string;
}
export interface DocumentMutationResult<T = DocumentTemplateRecord | DocumentAcknowledgementEvidence> { record: T; replayed: boolean }
