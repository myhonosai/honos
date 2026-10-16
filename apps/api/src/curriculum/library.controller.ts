import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query, Req, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { CurriculumResourceContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CurriculumHumanUiGuard } from './curriculum-human-ui.guard.js';
import { LibraryCreateDto,LibraryUpdateDto,LibraryArchiveDto } from './library.dto.js';
import { CurriculumLibraryService } from './library.service.js';
@Injectable()
export class CurriculumLibraryHumanUiGuard extends CurriculumHumanUiGuard {
 protected readonly command = 'curriculum-library';
 canActivate(context: ExecutionContext): boolean {
  const r=context.switchToHttp().getRequest<Request>();
  if(r.originalUrl?.includes('?')||Object.keys(r.query??{}).length) throw new BadRequestException({code:'LIBRARY_SELECTORS_NOT_ACCEPTED'});
  if(Object.keys(r.headers).some(k=>k.toLowerCase().startsWith('x-hon-')&&k!=='x-hon-human-command') || r.headers['sec-fetch-site']==='cross-site') throw new ForbiddenException({code:'HUMAN_UI_REQUIRED'});
  if(r.method==='GET' && r.body!==undefined && r.body!==null) throw new BadRequestException({code:'LIBRARY_SELECTORS_NOT_ACCEPTED'});
  return super.canActivate(context);
 }
}
export function rejectParentLibraryInputs(r: Pick<Request,'method'|'headers'|'body'|'originalUrl'>,query:Record<string,unknown>) {
 if(r.method!=='GET'||r.headers['sec-fetch-site']==='cross-site'||Object.keys(r.headers).some(k=>k.toLowerCase().startsWith('x-hon-'))) throw new ForbiddenException({code:'PARENT_LIBRARY_READ_ONLY'});
 if(Object.keys(query).length||r.originalUrl?.includes('?')||(r.body!==undefined&&r.body!==null)) throw new BadRequestException({code:'PARENT_LIBRARY_SELECTORS_NOT_ACCEPTED'});
}
@Injectable()
export class ParentCurriculumLibraryReadGuard implements CanActivate {
 canActivate(context:ExecutionContext) { const r=context.switchToHttp().getRequest<Request>();rejectParentLibraryInputs(r,r.query);return true; }
}
@Controller('staff/schools/:schoolId/curriculum-library')
@UseGuards(HonIdentityGuard,CurriculumLibraryHumanUiGuard)
export class StaffCurriculumLibraryController {
 constructor(private readonly database: RuntimeDatabaseService,private readonly library: CurriculumLibraryService) {}
 private async context(request:HonRequest,schoolId:string,key?:string):Promise<CurriculumResourceContext> {
  if(!request.honIdentity) throw new ForbiddenException({code:'IDENTITY_REQUIRED'});
  const scope=await this.database.resolveAuthorizedScope(request.honIdentity.externalSubject,schoolId,'curriculum.manage');
  if(!scope||scope.schoolId!==schoolId) throw new ForbiddenException({code:'LIBRARY_SCOPE_DENIED'});
  const id=randomUUID();return {...scope,externalSubject:request.honIdentity.externalSubject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:id,correlationId:id,idempotencyKey:key??''};
 }
 private envelope<T>(c:CurriculumResourceContext,data:T,replayed=false) {return {data,meta:{requestId:c.requestId,correlationId:c.correlationId,replayed}};}
 @Get() @Header('Cache-Control','private, no-store')
 async list(@Param('schoolId',new ParseUUIDPipe()) school:string,@Req() request:HonRequest) {const c=await this.context(request,school);return this.envelope(c,await this.library.list(c));}
 @Post() @HttpCode(200) @Header('Cache-Control','private, no-store')
 async create(@Param('schoolId',new ParseUUIDPipe()) school:string,@Headers('idempotency-key') key:string|undefined,@Body() input:LibraryCreateDto,@Req() request:HonRequest) {const c=await this.context(request,school,key);const r=await this.library.create(c,input);return this.envelope(c,r.record,r.replayed);}
 @Post(':resourceId/versions') @HttpCode(200) @Header('Cache-Control','private, no-store')
 async update(@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('resourceId',new ParseUUIDPipe()) id:string,@Headers('idempotency-key') key:string|undefined,@Body() input:LibraryUpdateDto,@Req() request:HonRequest) {const c=await this.context(request,school,key);const r=await this.library.update(c,id,input);return this.envelope(c,r.record,r.replayed);}
 @Post(':resourceId/archive') @HttpCode(200) @Header('Cache-Control','private, no-store')
 async archive(@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('resourceId',new ParseUUIDPipe()) id:string,@Headers('idempotency-key') key:string|undefined,@Body() input:LibraryArchiveDto,@Req() request:HonRequest) {const c=await this.context(request,school,key);const r=await this.library.archive(c,id,input);return this.envelope(c,r.record,r.replayed);}
}
@Controller('parent/curriculum-library')
@UseGuards(HonIdentityGuard,ParentCurriculumLibraryReadGuard)
export class ParentCurriculumLibraryController {
 constructor(private readonly library:CurriculumLibraryService) {}
 @Get() @Header('Cache-Control','private, no-store') @Header('Referrer-Policy','no-referrer') @Header('X-Robots-Tag','noindex, nofollow')
 async read(@Query() query:Record<string,unknown>,@Req() request:HonRequest) {rejectParentLibraryInputs(request,query);if(!request.honIdentity)throw new ForbiddenException({code:'IDENTITY_REQUIRED'});return this.library.parent(request.honIdentity.externalSubject);}
}
