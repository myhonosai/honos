import { Body, Controller, Post, Req, Param, ParseUUIDPipe, UseGuards, Injectable, HttpCode,
  BadRequestException, ForbiddenException, ServiceUnavailableException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { configuredPublicOrigin } from '@hon/auth';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { assertHqEntitlementHumanRequest } from '../hq/hq-entitlement.dto.js';
import { A2pPreparationService } from './a2p-preparation.service.js';

@Injectable()
export class A2pPreparationHumanGuard implements CanActivate {
  canActivate(context:ExecutionContext):boolean {
    const req=context.switchToHttp().getRequest<HonRequest>();
    context.switchToHttp().getResponse().setHeader('Cache-Control','private, no-store');
    context.switchToHttp().getResponse().setHeader('Referrer-Policy','no-referrer');
    assertHqEntitlementHumanRequest(req); // Existing shared direct-human context rejection; no HQ authority is granted.
    if(Object.keys(req.query??{}).length||req.originalUrl?.includes('?'))throw new BadRequestException({code:'INVALID_A2P_INPUT'});
    let origin:string|undefined;try{origin=configuredPublicOrigin(process.env);}catch{/* fail closed */}
    if(!origin)throw new ServiceUnavailableException({code:'HUMAN_UI_ORIGIN_NOT_CONFIGURED'});
    if(req.method!=='POST'||req.headers.origin!==origin||req.headers['x-hon-human-command']!=='a2p-prepare'
      ||req.headers['sec-fetch-site']!=='same-origin'||req.headers['sec-fetch-mode']!=='same-origin'||req.headers['sec-fetch-dest']!=='empty'
      ||req.headers.authorization||Object.keys(req.headers).some(k=>k.startsWith('x-hon-')&&k!=='x-hon-human-command')
      ||!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))throw new ForbiddenException({code:'HUMAN_UI_REQUIRED'});
    return true;
  }
}
@Controller('organizations/:organizationId/schools/:schoolId/a2p')
@UseGuards(A2pPreparationHumanGuard,HonIdentityGuard)
export class A2pPreparationController {
  constructor(private readonly preparation:A2pPreparationService){}
  private subject(req:HonRequest):string {assertHqEntitlementHumanRequest(req);if(!req.honIdentity)throw new ForbiddenException({code:'A2P_PREPARATION_FORBIDDEN'});return req.honIdentity.externalSubject;}
  @Post('website-review') @HttpCode(200)
  async website(@Req() req:HonRequest,@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Body() input:unknown){return {data:await this.preparation.website(this.subject(req),org,school,input)};}
  @Post('finding-details') @HttpCode(200)
  async finding(@Req() req:HonRequest,@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Body() input:unknown){return {data:await this.preparation.finding(this.subject(req),org,school,input)};}
  @Post('registration-draft') @HttpCode(200)
  async draft(@Req() req:HonRequest,@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Body() input:unknown){return {data:await this.preparation.draft(this.subject(req),org,school,input)};}
  @Post('draft-validation') @HttpCode(200)
  async validate(@Req() req:HonRequest,@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Body() input:unknown){return {data:await this.preparation.validate(this.subject(req),org,school,input)};}
  @Post('copy-preparation') @HttpCode(200)
  async copy(@Req() req:HonRequest,@Param('organizationId',new ParseUUIDPipe()) org:string,@Param('schoolId',new ParseUUIDPipe()) school:string,@Body() input:unknown){return {data:await this.preparation.copy(this.subject(req),org,school,input)};}
}
