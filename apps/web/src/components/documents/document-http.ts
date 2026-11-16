import type { DocumentPublicationRecord, DocumentTemplateRecord } from '@hon/contracts';

/**
 * Document reads and commands for the school the shell verified. The ids here are selectors only: the API re-derives the
 * human, school and permission from the signed session, and the database checks every template, version and family
 * against that school. Server error text is never shown; the person gets one plain sentence.
 */
export type DocumentScope = Readonly<{ organizationId: string; schoolId: string }>;
export type FamilyChoice = Readonly<{ id: string; displayName: string }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADERS = { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'document-acknowledgement' };

export class DocumentError extends Error {}
export const isDocumentId = (value: string): boolean => UUID.test(value);

function problem(status: number): string {
  if (status === 401) return 'Your sign-in has ended. Sign in again.';
  if (status === 403) return "You don't have permission for this at this school.";
  if (status === 404) return "We couldn't find that document.";
  if (status === 409) return 'This document changed since you opened it. Refresh and try again.';
  return "We couldn't confirm that. Try again.";
}

export async function documentRequest(url: string, body?: object, key?: string): Promise<{ data: unknown; meta?: { replayed?: boolean } }> {
  let response: Response;
  try {
    response = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: body ? { ...HEADERS, 'Idempotency-Key': key! } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch { throw new DocumentError("We couldn't confirm that. Try again."); }
  let result: unknown = null;
  try { result = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw new DocumentError(problem(response.status));
  if (!result || typeof result !== 'object' || (result as { data?: unknown }).data === undefined) throw new DocumentError("We couldn't confirm that. Try again.");
  return result as { data: unknown; meta?: { replayed?: boolean } };
}

export function documentBase(scope: DocumentScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new DocumentError("We couldn't confirm that. Try again.");
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/documents`;
}

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
function publication(value: unknown): DocumentPublicationRecord {
  const r = value as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || ![r.id, r.templateId, r.versionId].every(v => typeof v === 'string' && UUID.test(v)) || !Number.isSafeInteger(r.versionNumber)
    || !['STAFF', 'PARENT'].includes(r.audience as string) || !text(r.title, 200) || !text(r.content, 100000) || !/^[a-f0-9]{64}$/.test(String(r.contentHash))
    || typeof r.publishedAt !== 'string' || !Number.isFinite(Date.parse(r.publishedAt)) || typeof r.current !== 'boolean') throw new DocumentError("We couldn't load the documents. Try again.");
  return r as unknown as DocumentPublicationRecord;
}

export async function loadPublications(scope: DocumentScope): Promise<DocumentPublicationRecord[]> {
  const { data } = await documentRequest(`${documentBase(scope)}/publications`);
  if (!Array.isArray(data) || data.length > 100) throw new DocumentError("We couldn't load the documents. Try again.");
  return data.map(publication);
}

export function template(value: unknown): DocumentTemplateRecord {
  const r = value as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || ![r.id, r.latestVersionId].every(v => typeof v === 'string' && UUID.test(v)) || !Number.isSafeInteger(r.version) || !Number.isSafeInteger(r.versionNumber)
    || !['STAFF', 'PARENT'].includes(r.audience as string) || !text(r.title, 200) || !text(r.content, 100000)) throw new DocumentError("We couldn't open that document. Try again.");
  return r as unknown as DocumentTemplateRecord;
}

export async function loadTemplate(scope: DocumentScope, id: string): Promise<DocumentTemplateRecord> {
  if (!UUID.test(id)) throw new DocumentError("We couldn't find that document.");
  return template((await documentRequest(`${documentBase(scope)}/templates/${id.toLowerCase()}`)).data);
}

/** Active families of the school, by name, for a family-only document. */
export async function loadFamilies(scope: DocumentScope): Promise<FamilyChoice[]> {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new DocumentError('UNAVAILABLE');
  const { data } = await documentRequest(`/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/families`);
  if (!Array.isArray(data) || data.length > 100) throw new DocumentError('UNAVAILABLE');
  return data.flatMap((value): FamilyChoice[] => {
    const r = value as Record<string, unknown> | null;
    if (!r || typeof r.id !== 'string' || !UUID.test(r.id) || !text(r.displayName, 200) || !r.displayName.trim()) throw new DocumentError('UNAVAILABLE');
    return r.status === 'ACTIVE' ? [{ id: r.id, displayName: r.displayName }] : [];
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));
}
