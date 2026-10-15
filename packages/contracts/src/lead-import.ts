import type { CommandContext } from './index.js';
export const LEAD_IMPORT_FIELDS = ['givenName','familyName','displayName','email','mobile','source','note','campaign','campaignCode','medium','sourceDetail'] as const;
export type LeadImportField = typeof LEAD_IMPORT_FIELDS[number];
export interface LeadImportContext extends CommandContext { externalSubject: string }
export interface LeadImportUpload { csv: string; mapping: Record<string, LeadImportField>; pipelineStageId: string }
export interface LeadImportBatch { id: string; version: number; status: 'STAGED' | 'REVIEW' | 'FINALIZED'; rowCount: number; validCount: number; importedCount: number; skippedCount: number; checksum: string; createdAt: string }
export interface LeadImportRow { index: number; raw: string[]; normalized: Record<string,string>; errors: string[]; suggestions: { leadId?: string; rowIndex?: number; reason: 'EMAIL' | 'PHONE' }[]; choice: 'IMPORT' | 'SKIP' | null; leadId: string | null }
export interface LeadImportReview { batch: LeadImportBatch; reviewToken: string; expiresAt: string }
export interface LeadImportPreview { batch: LeadImportBatch; headers: string[]; mapping: Record<string,LeadImportField>; rows: LeadImportRow[] }
export interface LeadImportResult<T = LeadImportBatch> { record: T; replayed: boolean }
export interface LeadImportOptions { stages: { id: string; label: string }[]; fields: readonly LeadImportField[]; maxBytes: number; maxRows: number; maxColumns: number }
