import { Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { LeadImportContext, LeadImportUpload } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { LeadImportService } from './lead-import.service.js';
import { LeadImportHumanUiGuard } from './lead-import-human-ui.guard.js';
import { closed } from './lead-import-csv.js';
@Controller('staff/migration/leads')
@UseGuards(HonIdentityGuard,LeadImportHumanUiGuard)
export class LeadImportController {
  constructor(private readonly database: RuntimeDatabaseService,private readonly imports: LeadImportService) {}
  private async context(request: HonRequest,operation: string,key=''): Promise<LeadImportContext> {
    if (!request.honIdentity) throw new ForbiddenException({code:'IDENTITY_REQUIRED'});
    const scope = await this.database.resolveLeadImportScope(request.honIdentity.externalSubject,`migration.lead_import.${operation}`);
    if (!scope) throw new ForbiddenException({code:'IMPORT_SCOPE_REQUIRED',detail:'Exactly one active authorized school is required. No client school/actor selection is accepted.'});
    const id=randomUUID(); return {...scope,externalSubject:request.honIdentity.externalSubject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:id,correlationId:id,idempotencyKey:key};
  }
  private envelope(c: LeadImportContext,r: {record: unknown;replayed?: boolean}) { return {data:r.record,meta:{requestId:c.requestId,correlationId:c.correlationId,...(r.replayed===undefined?{}:{replayed:r.replayed})}}; }
  @Header('Cache-Control','private, no-store') @Header('Referrer-Policy','no-referrer') @Get('options') async options(@Req() req: HonRequest) { const c=await this.context(req,'read'); return this.envelope(c,{record:await this.imports.read(c,'OPTIONS')}); }
  @Header('Cache-Control','private, no-store') @Header('Referrer-Policy','no-referrer') @Get() async list(@Req() req: HonRequest) { const c=await this.context(req,'read'); return this.envelope(c,{record:await this.imports.read(c,'LIST')}); }
  @Header('Cache-Control','private, no-store') @Header('Referrer-Policy','no-referrer') @Get(':id') async batch(@Param('id',new ParseUUIDPipe()) id:string,@Req() req:HonRequest) { const c=await this.context(req,'read');return this.envelope(c,{record:await this.imports.read(c,'BATCH',id)}); }
  @Header('Cache-Control','private, no-store') @Header('Referrer-Policy','no-referrer') @Post() @HttpCode(200) async upload(@Headers('idempotency-key') key:string|undefined,@Body() input:LeadImportUpload,@Req() req:HonRequest) { const c=await this.context(req,'upload',key);return this.envelope(c,await this.imports.upload(c,input)); }
  @Header('Cache-Control','private, no-store') @Header('Referrer-Policy','no-referrer') @Post(':id/review') @HttpCode(200) async open(@Param('id',new ParseUUIDPipe()) id:string,@Headers('idempotency-key') key:string|undefined,@Body() input:{expectedVersion:number},@Req() req:HonRequest) { const c=await this.context(req,'review',key);return this.envelope(c,await this.imports.open(c,id,input)); }
  @Header('Cache-Control','private, no-store') @Header('Referrer-Policy','no-referrer') @Post(':id/review/rows') @HttpCode(200) async rows(@Param('id',new ParseUUIDPipe()) id:string,@Body() input:{reviewToken:string},@Req() req:HonRequest) { closed(input,['reviewToken']); const c=await this.context(req,'review');return this.envelope(c,{record:await this.imports.read(c,'REVIEW_ROWS',id,input.reviewToken)}); }
  @Header('Cache-Control','private, no-store') @Header('Referrer-Policy','no-referrer') @Post(':id/decisions') @HttpCode(200) async decide(@Param('id',new ParseUUIDPipe()) id:string,@Headers('idempotency-key') key:string|undefined,@Body() input:Parameters<LeadImportService['decide']>[2],@Req() req:HonRequest) { const c=await this.context(req,'review',key);return this.envelope(c,await this.imports.decide(c,id,input)); }
  @Header('Cache-Control','private, no-store') @Header('Referrer-Policy','no-referrer') @Post(':id/finalize') @HttpCode(200) async finalize(@Param('id',new ParseUUIDPipe()) id:string,@Headers('idempotency-key') key:string|undefined,@Body() input:Parameters<LeadImportService['finalize']>[2],@Req() req:HonRequest) { const c=await this.context(req,'finalize',key);return this.envelope(c,await this.imports.finalize(c,id,input)); }
}
