import { Allow } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import { closedLibraryObject, libraryText, isCurriculumLibraryId, isSafeCurriculumResourceUrl, CURRICULUM_RESOURCE_KINDS, type CurriculumResourceCreateInput, type CurriculumResourceUpdateInput, type CurriculumResourceArchiveInput } from '@hon/contracts';
export type LibraryOperation = 'CREATE' | 'UPDATE' | 'ARCHIVE';
export class LibraryCreateDto implements CurriculumResourceCreateInput {
 @Allow() declare expectedVersion: 0; @Allow() declare curriculumId: string; @Allow() declare rankId: string|null;
 @Allow() declare kind: CurriculumResourceCreateInput['kind']; @Allow() declare url: string; @Allow() declare title: string;
 @Allow() declare description: string; @Allow() declare audience: CurriculumResourceCreateInput['audience'];
}
export class LibraryUpdateDto implements CurriculumResourceUpdateInput {
 @Allow() declare expectedVersion: number; @Allow() declare title: string; @Allow() declare description: string; @Allow() declare audience: CurriculumResourceUpdateInput['audience'];
}
export class LibraryArchiveDto implements CurriculumResourceArchiveInput { @Allow() declare expectedVersion: number }
export function validateLibraryInput(operation: LibraryOperation, input: unknown): void {
 try {
  if (!['CREATE','UPDATE','ARCHIVE'].includes(operation)) throw new Error();
  const r = closedLibraryObject(input, operation === 'CREATE' ? ['expectedVersion','curriculumId','rankId','kind','url','title','description','audience'] : operation === 'UPDATE' ? ['expectedVersion','title','description','audience'] : ['expectedVersion']);
  if (!Number.isSafeInteger(r.expectedVersion) || Number(r.expectedVersion) < (operation === 'CREATE' ? 0 : 1) || Number(r.expectedVersion) > 999999999) throw new Error();
  if (operation !== 'ARCHIVE') { libraryText(r.title,160); libraryText(r.description,600,true); if (!['STAFF','PARENT'].includes(r.audience as string)) throw new Error(); }
  if (operation === 'CREATE' && (r.expectedVersion !== 0 || !isCurriculumLibraryId(r.curriculumId) || (r.rankId !== null && !isCurriculumLibraryId(r.rankId)) || !CURRICULUM_RESOURCE_KINDS.includes(r.kind as never) || !isSafeCurriculumResourceUrl(r.url))) throw new Error();
 } catch { throw new BadRequestException({ code:'VALIDATION_FAILED', detail:'Use the closed metadata library fields, a fixed public-style HTTPS DNS URL, and current expected version.' }); }
}
