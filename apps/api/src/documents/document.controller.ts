import { Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CreateDocumentTemplateInput, DocumentCommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { AcknowledgeDocumentDto, CreateDocumentTemplateDto, CreateDocumentVersionDto, PublishDocumentDto } from './document.dto.js';
import { DocumentService } from './document.service.js';
import { DocumentHumanUiGuard } from './document-human-ui.guard.js';
@Controller('organizations/:organizationId/schools/:schoolId/documents')
@UseGuards(HonIdentityGuard,DocumentHumanUiGuard)
export class DocumentController {
  constructor(private readonly database: RuntimeDatabaseService,private readonly documents: DocumentService) {}
  private async context(org: string,school: string,request: HonRequest,permission: string,key?: string): Promise<DocumentCommandContext> {
    if (key !== undefined && (!key || key.length>200 || key.trim()!==key || /[\u0000-\u001f\u007f]/.test(key))) throw new ConflictException({code:'IDEMPOTENCY_KEY_REQUIRED'});
    if (!request.honIdentity) throw new ForbiddenException({code:'IDENTITY_REQUIRED'});
    const scope=await this.database.resolveAuthorizedScope(request.honIdentity.externalSubject,school,permission);
    if (!scope || scope.organizationId!==org || scope.schoolId!==school) throw new ForbiddenException({code:'PERMISSION_DENIED'});
    const id=randomUUID(); return {...scope,externalSubject:request.honIdentity.externalSubject,audienceMode:'STAFF',principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:id,correlationId:id,idempotencyKey:key??''};
  }
  private envelope(c: DocumentCommandContext,r: {record: unknown;replayed?: boolean}) { return {data:r.record,meta:{requestId:c.requestId,correlationId:c.correlationId,...(r.replayed === undefined ? {} : {replayed:r.replayed})}}; }
  @Header('Cache-Control','private, no-store') @Post('templates') @HttpCode(200)
  async create(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Headers('idempotency-key') key:string|undefined,@Body() input:CreateDocumentTemplateDto,@Req() request:HonRequest) {
    const c=await this.context(org,school,request,'document.template.create',key);return this.envelope(c,await this.documents.create(c,input as CreateDocumentTemplateInput));
  }
  @Header('Cache-Control','private, no-store') @Post('templates/:id/versions') @HttpCode(200)
  async version(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('id',new ParseUUIDPipe()) id:string,@Headers('idempotency-key') key:string|undefined,@Body() input:CreateDocumentVersionDto,@Req() request:HonRequest) {
    const c=await this.context(org,school,request,'document.template.version',key);return this.envelope(c,await this.documents.version(c,id,input));
  }
  @Header('Cache-Control','private, no-store') @Post('templates/:id/publish') @HttpCode(200)
  async publish(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('id',new ParseUUIDPipe()) id:string,@Headers('idempotency-key') key:string|undefined,@Body() input:PublishDocumentDto,@Req() request:HonRequest) {
    const c=await this.context(org,school,request,'document.publish',key);return this.envelope(c,await this.documents.publish(c,id,input));
  }
  @Header('Cache-Control','private, no-store') @Post('publications/:id/acknowledgements') @HttpCode(200)
  async acknowledge(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('id',new ParseUUIDPipe()) id:string,@Headers('idempotency-key') key:string|undefined,@Body() input:AcknowledgeDocumentDto,@Req() request:HonRequest) {
    const c=await this.context(org,school,request,'document.acknowledge',key);return this.envelope(c,await this.documents.acknowledge(c,id,input));
  }
  @Header('Cache-Control','private, no-store') @Get('versions/:id')
  async readVersion(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('id',new ParseUUIDPipe()) id:string,@Req() request:HonRequest) {
    const c=await this.context(org,school,request,'document.read');return this.envelope(c,{record:await this.documents.read(c,'VERSION',id)});
  }
  @Header('Cache-Control','private, no-store') @Get('templates/:id')
  async template(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('id',new ParseUUIDPipe()) id:string,@Req() request:HonRequest) {
    const c=await this.context(org,school,request,'document.read');return this.envelope(c,{record:await this.documents.read(c,'TEMPLATE',id)});
  }
  @Header('Cache-Control','private, no-store') @Get('publications')
  async list(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Req() request:HonRequest) {
    const c=await this.context(org,school,request,'document.read');return this.envelope(c,{record:await this.documents.read(c,'LIST',null)});
  }
  @Header('Cache-Control','private, no-store') @Get('publications/:id')
  async publication(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('id',new ParseUUIDPipe()) id:string,@Req() request:HonRequest) {
    const c=await this.context(org,school,request,'document.read');return this.envelope(c,{record:await this.documents.read(c,'PUBLICATION',id)});
  }
  @Header('Cache-Control','private, no-store') @Get('acknowledgements/:id')
  async evidence(@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Param('id',new ParseUUIDPipe()) id:string,@Req() request:HonRequest) {
    const c=await this.context(org,school,request,'document.evidence.read');return this.envelope(c,{record:await this.documents.read(c,'EVIDENCE',id)});
  }
}
