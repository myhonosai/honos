import { Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DocumentCommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { AcknowledgeDocumentDto } from './document.dto.js';
import { DocumentService } from './document.service.js';
import { DocumentHumanUiGuard } from './document-human-ui.guard.js';
/** No organization/family/person/signer input and no staff authorization fallback. */
@Controller('parent/schools/:schoolId/documents')
@UseGuards(HonIdentityGuard,DocumentHumanUiGuard)
export class ParentDocumentController {
  constructor(private readonly database:RuntimeDatabaseService,private readonly documents:DocumentService) {}
  private async context(school:string,request:HonRequest,key?:string):Promise<DocumentCommandContext> {
    if (!request.honIdentity) throw new ForbiddenException({code:'IDENTITY_REQUIRED'});
    const scopes=await this.database.resolveParentFamilyScopes(request.honIdentity.externalSubject,school);
    const scope=scopes[0];
    if (!scope || scope.schoolId!==school || scopes.some(s=>s.organizationId!==scope.organizationId || s.principalId!==scope.principalId || s.schoolId!==school)) throw new ForbiddenException({code:'PARENT_SCOPE_DENIED'});
    const id=randomUUID(); return {organizationId:scope.organizationId,schoolId:scope.schoolId,principalId:scope.principalId,externalSubject:request.honIdentity.externalSubject,audienceMode:'PARENT',principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:id,correlationId:id,idempotencyKey:key??''};
  }
  private envelope(c:DocumentCommandContext,r:{record:unknown;replayed?:boolean}) {return {data:r.record,meta:{requestId:c.requestId,correlationId:c.correlationId,...(r.replayed===undefined?{}:{replayed:r.replayed})}};}
  @Header('Cache-Control','private, no-store') @Get('publications')
  async list(@Param('schoolId',new ParseUUIDPipe()) school:string,@Req() request:HonRequest) {const c=await this.context(school,request);return this.envelope(c,{record:await this.documents.read(c,'LIST',null)});}
  @Header('Cache-Control','private, no-store') @Get('publications/:id')
  async publication(@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('id',new ParseUUIDPipe()) id:string,@Req() request:HonRequest) {const c=await this.context(school,request);return this.envelope(c,{record:await this.documents.read(c,'PUBLICATION',id)});}
  @Header('Cache-Control','private, no-store') @Post('publications/:id/acknowledgements') @HttpCode(200)
  async acknowledge(@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('id',new ParseUUIDPipe()) id:string,@Headers('idempotency-key') key:string|undefined,@Body() input:AcknowledgeDocumentDto,@Req() request:HonRequest) {const c=await this.context(school,request,key);return this.envelope(c,await this.documents.acknowledge(c,id,input));}
  @Header('Cache-Control','private, no-store') @Get('acknowledgements/:id')
  async evidence(@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('id',new ParseUUIDPipe()) id:string,@Req() request:HonRequest) {const c=await this.context(school,request);return this.envelope(c,{record:await this.documents.read(c,'EVIDENCE',id)});}
}
