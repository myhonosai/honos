import type { CommandContext } from './index.js';
export const CURRICULUM_RESOURCE_KINDS = ['VIDEO', 'LINK'] as const;
export type CurriculumResourceKind = (typeof CURRICULUM_RESOURCE_KINDS)[number];
export type CurriculumResourceAudience = 'STAFF' | 'PARENT';
export interface CurriculumResourceContext extends CommandContext { externalSubject: string }
export interface CurriculumResourceCreateInput {
  expectedVersion: 0; curriculumId: string; rankId: string | null;
  kind: CurriculumResourceKind; url: string; title: string; description: string; audience: CurriculumResourceAudience;
}
/** Fixed URL, kind and curriculum/rank identity cannot be rewritten. Archive and create instead. */
export interface CurriculumResourceUpdateInput { expectedVersion: number; title: string; description: string; audience: CurriculumResourceAudience }
export interface CurriculumResourceArchiveInput { expectedVersion: number }
export interface CurriculumResourceRecord {
  id: string; curriculumId: string; rankId: string | null; kind: CurriculumResourceKind; url: string;
  title: string; description: string; audience: CurriculumResourceAudience; status: 'ACTIVE' | 'ARCHIVED'; version: number;
}
export interface StaffCurriculumLibrary { resources: CurriculumResourceRecord[]; curricula: { id: string; name: string; ranks: { id: string; name: string }[] }[] }
/** No IDs, staff, evidence, provider, audit, progress, billing or readiness fields. */
export interface ParentCurriculumReference { title: string; description: string; kind: CurriculumResourceKind; url: string; curriculumName: string; rankName: string | null; childDisplayName: string }
export interface ParentCurriculumLibrary { resources: ParentCurriculumReference[] }
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isCurriculumLibraryId(v: unknown): v is string { return typeof v === 'string' && idPattern.test(v); }
/** Lexical only: ASCII DNS public-style hostnames; no fetch, parse normalization or DNS. */
export function isSafeCurriculumResourceUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length < 12 || v.length > 2048 || !/^https:\/\/[a-z0-9.-]+([/?][A-Za-z0-9/?=&._~!$'()*+;,@:-]*)?$/.test(v)) return false;
  const host = v.slice(8).split(/[/?]/, 1)[0]!;
  return host.length <= 253 && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,63}$/.test(host)
    && !/(^|\.)(localhost|local|internal|home|lan|test|invalid|onion|example|arpa)$/.test(host)
    && host.split('.').every(label => label.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label));
}
function bad(): never { throw new Error('Curriculum library response could not be verified.'); }
export function closedLibraryObject(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== [...keys].sort().join(',')) bad();
  return v as Record<string, unknown>;
}
export function libraryText(v: unknown, max: number, empty = false): string {
  if (typeof v !== 'string' || v.length > max || (!empty && !v.length) || v.trim() !== v || /[\u0000-\u001f\u007f-\u009f<>]/.test(v)) bad();
  return v;
}
export function verifyCurriculumResourceRecord(v: unknown): CurriculumResourceRecord {
  const r = closedLibraryObject(v, ['id','curriculumId','rankId','kind','url','title','description','audience','status','version']);
  if (!isCurriculumLibraryId(r.id) || !isCurriculumLibraryId(r.curriculumId) || (r.rankId !== null && !isCurriculumLibraryId(r.rankId))
    || !CURRICULUM_RESOURCE_KINDS.includes(r.kind as never) || !isSafeCurriculumResourceUrl(r.url)
    || !['STAFF','PARENT'].includes(r.audience as string) || !['ACTIVE','ARCHIVED'].includes(r.status as string)
    || !Number.isSafeInteger(r.version) || Number(r.version) < 1 || Number(r.version) > 999999999) bad();
  libraryText(r.title,160); libraryText(r.description,600,true);
  return { id:r.id, curriculumId:r.curriculumId, rankId:r.rankId, kind:r.kind, url:r.url, title:r.title, description:r.description, audience:r.audience, status:r.status, version:r.version } as CurriculumResourceRecord;
}
export function verifyParentCurriculumLibrary(v: unknown): ParentCurriculumLibrary {
  const data = closedLibraryObject(v, ['resources']);
  if (!Array.isArray(data.resources)) bad();
  return { resources: data.resources.map(value => {
    const r = closedLibraryObject(value,['title','description','kind','url','curriculumName','rankName','childDisplayName']);
    if (!CURRICULUM_RESOURCE_KINDS.includes(r.kind as never) || !isSafeCurriculumResourceUrl(r.url)) bad();
    return { title:libraryText(r.title,160), description:libraryText(r.description,600,true), kind:r.kind as CurriculumResourceKind, url:r.url,
      curriculumName:libraryText(r.curriculumName,160), rankName:r.rankName === null ? null : libraryText(r.rankName,160), childDisplayName:libraryText(r.childDisplayName,160) };
  }) };
}
export function verifyStaffCurriculumLibrary(v: unknown): StaffCurriculumLibrary {
  const data = closedLibraryObject(v,['resources','curricula']);
  if (!Array.isArray(data.resources) || !Array.isArray(data.curricula)) bad();
  return { resources:data.resources.map(verifyCurriculumResourceRecord), curricula:data.curricula.map(value => {
    const c=closedLibraryObject(value,['id','name','ranks']); if (!isCurriculumLibraryId(c.id) || !Array.isArray(c.ranks)) bad();
    return { id:c.id, name:libraryText(c.name,160), ranks:c.ranks.map(value => {
      const r=closedLibraryObject(value,['id','name']); if(!isCurriculumLibraryId(r.id)) bad(); return { id:r.id,name:libraryText(r.name,160) };
    }) };
  }) };
}
