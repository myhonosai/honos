import { BadRequestException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { accountUuid, validateStaffAccountReceipt, validateStaffInvitation, validateStaffInvitationAcceptance, validateStaffInvitationInput, validateStaffInvitationRevoke } from '@hon/contracts';
import { cookieValue, HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { SchoolAccountRateLimit } from './school-account-rate-limit.js';

type Operation = 'invite'|'revoke'|'accept'|'list';
const sha = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class SchoolStaffInvitationService {
  private readonly rateLimit = new SchoolAccountRateLimit();
  constructor(private readonly database: RuntimeDatabaseService) {}
  private admit(req: HonRequest, operation: Operation) {
    const wait = this.rateLimit.admit(req.honIdentity!.externalSubject, operation);
    if (wait) {
      req.res?.setHeader('Retry-After', String(wait));
      throw new HttpException({code:'ACCOUNT_RATE_LIMITED',outcome:'NOT_SUBMITTED',retryAfterSeconds:wait},429);
    }
  }
  private async run(operation: Operation, args: (string|null)[]): Promise<unknown> {
    try { return await this.database.callSchoolStaffAccount(operation,args); }
    catch (e) {
      const code=(e as {code?:string}).code;
      if(code==='42501') throw new ForbiddenException({code:'ACCOUNT_FORBIDDEN'});
      if(code==='P0002') throw new HttpException({code:'ACCOUNT_UNAVAILABLE'},404);
      if(code==='23514') throw new HttpException({code:'ACCOUNT_REVIEW_REQUIRED'},409);
      if(code==='23505'||code==='40001') throw new HttpException({code:'ACCOUNT_CONFLICT'},409);
      if(code==='55P03') throw new HttpException({code:'ACCOUNT_BUSY',outcome:'NOT_SUBMITTED'},503);
      if(code==='22023'||code==='22P02') throw new BadRequestException({code:'ACCOUNT_INPUT_INVALID'});
      throw new ServiceUnavailableException({code:'ACCOUNT_UNAVAILABLE',outcome:'UNKNOWN_OR_RETRY_REQUIRED'});
    }
  }
  async command(req: HonRequest, operation: 'invite'|'revoke'|'accept', raw: unknown, key: unknown) {
    const subject=req.honIdentity!.externalSubject; let input: object; let email: string|null=null;
    try {
      accountUuid(key);
      if(operation==='invite') { const {token,...rest}=validateStaffInvitationInput(raw); input={...rest,tokenHash:sha(token)}; }
      else if(operation==='revoke') input=validateStaffInvitationRevoke(raw);
      else { const {token,...rest}=validateStaffInvitationAcceptance(raw); input={...rest,tokenHash:sha(token)}; }
    } catch { throw new BadRequestException({code:'ACCOUNT_INPUT_INVALID'}); }
    if(operation==='accept') {
      const config=sessionConfig();
      // Reuse the verified HON session; no email, subject, role or school comes from the body.
      const proof=verifySession(cookieValue(req.headers.cookie,HON_SESSION_COOKIE)!,config);
      if(config.mode!=='OIDC'||proof.emailVerified!==true||!proof.email||proof.externalSubject!==subject) throw new ForbiddenException({code:'VERIFIED_EMAIL_REQUIRED'});
      email=proof.email.toLowerCase().trim();
    }
    this.admit(req,operation);
    const data=await this.run(operation,operation==='accept'?[subject,email,JSON.stringify(input),key as string]:[subject,JSON.stringify(input),key as string]);
    return operation==='accept'?validateStaffAccountReceipt(data):validateStaffInvitation(data);
  }
  async list(req: HonRequest, school: string) {
    try { accountUuid(school); } catch { throw new BadRequestException({code:'ACCOUNT_INPUT_INVALID'}); }
    this.admit(req,'list');
    const data=await this.run('list',[req.honIdentity!.externalSubject,school]);
    if(!Array.isArray(data)||data.length>50) throw new ServiceUnavailableException({code:'ACCOUNT_UNAVAILABLE'});
    return data.map(validateStaffInvitation);
  }
}
