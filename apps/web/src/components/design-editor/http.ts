import {
  CREATIVE_DESIGN_PHOTO_COMMAND, CREATIVE_DESIGN_SAVE_COMMAND, CREATIVE_DESIGN_STATUS_COMMAND,
  validateAddCreativeDesignPhotoInput, validateCreativeDesignsQuery, validateSaveCreativeDesignInput, validateSetCreativeDesignStatusInput,
  verifyCreativeDesign, verifyCreativeDesignList, verifyCreativeDesignPhoto, verifyCreativeDesignPhotoReceipt, verifyCreativeDesignReceipt,
  type AddCreativeDesignPhotoInput, type CreativeDesign, type CreativeDesignList, type CreativeDesignPhoto, type CreativeDesignPhotoReceipt,
  type CreativeDesignReceipt, type CreativeDesignsQuery, type SaveCreativeDesignInput, type SetCreativeDesignStatusInput,
} from '@hon/contracts';

/**
 * Creative Studio designs (0617). Same-origin browser calls only. The shell's school scope is sent and checked again by
 * the server (creative.design.read/manage); nothing here decides permission. Nothing here sends, prints or publishes.
 */
export class DesignsAccessError extends Error { constructor(readonly reason: 'SESSION' | 'FORBIDDEN') { super(reason); } }
/** A definite refusal (nothing stored); the code picks the plain message. A retry is a new command. */
export class DesignsRefusal extends Error { constructor(readonly code: string) { super(code); } }
/** The answer could not be checked or the outcome is unknown: a save may or may not have been stored. */
export class DesignsUnknown extends Error {}
export type DesignsScope = Readonly<{ organizationId: string; schoolId: string }>;

/** Server codes for a definite refusal. Anything else is unknown. */
export const DESIGN_REFUSALS = [
  'VALIDATION_FAILED', 'CREATIVE_DESIGN_NOT_FOUND', 'CREATIVE_DESIGN_PHOTO_NOT_FOUND', 'CREATIVE_DESIGN_ARCHIVED', 'CREATIVE_DESIGN_STATUS_UNCHANGED',
  'CREATIVE_DESIGN_NAME_TAKEN', 'CREATIVE_DESIGN_LIMIT', 'CREATIVE_DESIGN_PHOTO_LIMIT', 'CREATIVE_DESIGN_PHOTO_REFUSED', 'VERSION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED',
] as const;
const REFUSAL = new Set<string>(DESIGN_REFUSALS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(): never { throw new DesignsUnknown('unverified'); }

async function call(url: string, method: 'GET' | 'POST', command?: string, body?: unknown, key?: string, signal?: AbortSignal): Promise<{ data: unknown; meta?: unknown }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method === 'POST') { headers['Content-Type'] = 'application/json'; headers['X-HON-Human-Command'] = command!; headers['Idempotency-Key'] = key!; }
  let response: Response;
  try {
    response = await fetch(url, { method, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers,
      ...(signal ? { signal } : {}), ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  } catch { throw new DesignsUnknown('network'); }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const value: unknown = await response.json().catch(() => invalid());
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const root = value as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401) throw new DesignsAccessError('SESSION');
    if (response.status === 403) throw new DesignsAccessError('FORBIDDEN');
    if (REFUSAL.has(String(root.code))) throw new DesignsRefusal(String(root.code));
    throw new DesignsUnknown(String(response.status));
  }
  if (!Object.hasOwn(root, 'data')) invalid();
  return root as { data: unknown; meta?: unknown };
}
function base(scope: DesignsScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) invalid();
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/creative-studio/designs`;
}
function replayed(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || typeof (meta as { replayed?: unknown }).replayed !== 'boolean') invalid();
  return (meta as { replayed: boolean }).replayed;
}
function guard<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch(error => {
    if (error instanceof DesignsAccessError || error instanceof DesignsRefusal || error instanceof DesignsUnknown) throw error;
    if ((error as { name?: string })?.name === 'AbortError') throw error;
    return invalid();
  });
}

export function loadDesigns(scope: DesignsScope, query: CreativeDesignsQuery = {}, signal?: AbortSignal): Promise<CreativeDesignList> {
  return guard(async () => {
    const q = validateCreativeDesignsQuery(query);
    const url = base(scope) + (q.status ? `?status=${q.status}` : '');
    return verifyCreativeDesignList((await call(url, 'GET', undefined, undefined, undefined, signal)).data, q);
  });
}
export function loadDesign(scope: DesignsScope, designId: string, signal?: AbortSignal): Promise<CreativeDesign> {
  return guard(async () => {
    if (!UUID.test(designId)) invalid();
    const design = verifyCreativeDesign((await call(`${base(scope)}/${designId.toLowerCase()}`, 'GET', undefined, undefined, undefined, signal)).data);
    if (design.designId !== designId.toLowerCase()) invalid();
    return design;
  });
}
export function loadDesignPhoto(scope: DesignsScope, photoId: string, signal?: AbortSignal): Promise<CreativeDesignPhoto> {
  return guard(async () => {
    if (!UUID.test(photoId)) invalid();
    return verifyCreativeDesignPhoto((await call(`${base(scope)}/photos/${photoId.toLowerCase()}`, 'GET', undefined, undefined, undefined, signal)).data, photoId.toLowerCase());
  });
}
export function saveDesign(scope: DesignsScope, input: SaveCreativeDesignInput, key: string): Promise<CreativeDesignReceipt> {
  return guard(async () => {
    const body = validateSaveCreativeDesignInput(input);
    const r = await call(base(scope), 'POST', CREATIVE_DESIGN_SAVE_COMMAND, body, key);
    return verifyCreativeDesignReceipt({ design: r.data, replayed: replayed(r.meta) }, { version: body.expectedVersion + 1, designId: body.designId, sizeCode: body.sizeCode, status: 'ACTIVE' });
  });
}
export function setDesignStatus(scope: DesignsScope, input: SetCreativeDesignStatusInput, key: string): Promise<CreativeDesignReceipt> {
  return guard(async () => {
    const body = validateSetCreativeDesignStatusInput(input);
    const r = await call(`${base(scope)}/${body.designId}/status`, 'POST', CREATIVE_DESIGN_STATUS_COMMAND, { expectedVersion: body.expectedVersion, status: body.status }, key);
    return verifyCreativeDesignReceipt({ design: r.data, replayed: replayed(r.meta) }, { version: body.expectedVersion + 1, designId: body.designId, status: body.status });
  });
}
export function addDesignPhoto(scope: DesignsScope, input: AddCreativeDesignPhotoInput, key: string): Promise<CreativeDesignPhotoReceipt> {
  return guard(async () => {
    const body = validateAddCreativeDesignPhotoInput(input);
    const r = await call(`${base(scope)}/photos`, 'POST', CREATIVE_DESIGN_PHOTO_COMMAND, body, key);
    return verifyCreativeDesignPhotoReceipt({ photo: r.data, replayed: replayed(r.meta) }, { mediaType: body.mediaType });
  });
}
