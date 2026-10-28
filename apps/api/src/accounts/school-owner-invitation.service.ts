import { BadRequestException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { accountClosed, accountUuid, validateOwnerInvitation, validateOwnerInvitationInput, validateOwnerInvitationAcceptance, validateOwnerAccountReceipt } from '@hon/contracts';
import { cookieValue, HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
@Injectable()
export class SchoolOwnerInvitationService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  private async run(operation: 'invite'|'revoke'|'accept'|'list', args: (string|null)[]): Promise<unknown> {
    try { return await this.database.callSchoolAccount(operation,args); }
    catch (e) {
      const code=(e as {code?:string}).code;
      if(code==='42501') throw new ForbiddenException({code:'ACCOUNT_FORBIDDEN'});
      if(code==='P0002') throw new HttpException({code:'ACCOUNT_UNAVAILABLE'},404);
      if(code==='23505'||code==='23514'||code==='40001') throw new HttpException({code:code==='23514'?'ACCOUNT_REVIEW_REQUIRED':'ACCOUNT_CONFLICT'},409);
      if(code==='22023'||code==='22P02') throw new BadRequestException({code:'ACCOUNT_INPUT_INVALID'});
      throw new ServiceUnavailableException({code:'ACCOUNT_UNAVAILABLE',outcome:'UNKNOWN_OR_RETRY_REQUIRED'});
    }
  }
  async command(req: HonRequest, operation: 'invite'|'revoke'|'accept', raw: unknown, key: unknown) {
    let input: object; let subject=req.honIdentity!.externalSubject; let email: string|null=null;
    try {
      accountUuid(key);
      if(operation==='invite') { const {token,...rest}=validateOwnerInvitationInput(raw); input={...rest,tokenHash:createHash('sha256').update(token).digest('hex')}; }
      else if(operation==='revoke') { const o=accountClosed(raw,['invitationId']); input={invitationId:accountUuid(o.invitationId)}; }
      else { const {token,...rest}=validateOwnerInvitationAcceptance(raw); input={...rest,tokenHash:createHash('sha256').update(token).digest('hex')}; }
    } catch { throw new BadRequestException({code:'ACCOUNT_INPUT_INVALID'}); }
    if(operation==='accept') {
      const config=sessionConfig();
      // Reuse the verified HON session; no email, subject, role or organization comes from the body.
      const proof=verifySession(cookieValue(req.headers.cookie,HON_SESSION_COOKIE)!,config);
      if(config.mode!=='OIDC'||proof.emailVerified!==true||!proof.email||proof.externalSubject!==subject) throw new ForbiddenException({code:'VERIFIED_EMAIL_REQUIRED'});
      email=proof.email.toLowerCase().trim();
    }
    const data=await this.run(operation,operation==='accept'?[subject,email,JSON.stringify(input),key as string]:[subject,JSON.stringify(input),key as string]);
    return operation==='accept'?validateOwnerAccountReceipt(data):validateOwnerInvitation(data);
  }
  async list(req: HonRequest, school: string) {
    try { accountUuid(school); } catch { throw new BadRequestException({code:'ACCOUNT_INPUT_INVALID'}); }
    const data=await this.run('list',[req.honIdentity!.externalSubject,school]);
    if(!Array.isArray(data)||data.length>50) throw new ServiceUnavailableException({code:'ACCOUNT_UNAVAILABLE'});
    return data.map(validateOwnerInvitation);
  }
}
