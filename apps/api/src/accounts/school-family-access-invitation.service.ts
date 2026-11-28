import { BadRequestException, ForbiddenException, HttpException, Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { accountUuid, validateFamilyAccessEnd, validateFamilyAccessInvitation, validateFamilyAccessInvitationAcceptance, validateFamilyAccessInvitationInput,
  validateFamilyAccessInvitationRevoke, validateFamilyAccountReceipt, validateFamilyInvitationEmailGrant, validateFamilyInvitationEmailInput,
  validateFamilyInvitationEmailReceipt, type FamilyInvitationEmailDelivery, type FamilyInvitationEmailInput } from '@hon/contracts';
import { COMMUNICATION_PROVIDER_ADAPTERS, CommunicationProviderError, type CommunicationProviderAdapter } from '../communication/delivery/communication-provider.js';
import { familyInvitationEmail, familyInviteOrigin } from './family-invitation-email.js';
import { cookieValue, HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { SchoolAccountRateLimit } from './school-account-rate-limit.js';

type Command = 'invite'|'revoke'|'end'|'accept';
type Operation = Command|'list'|'email';
const EMAIL_SEND_TIMEOUT_MS = 20_000;
const sha = (token: string) => createHash('sha256').update(token).digest('hex');

/** Parent/guardian linking to one existing family. Subject and verified email come only from the signed HON session. */
@Injectable()
export class SchoolFamilyAccessInvitationService {
  private readonly rateLimit = new SchoolAccountRateLimit();
  constructor(private readonly database: RuntimeDatabaseService,
    @Optional() @Inject(COMMUNICATION_PROVIDER_ADAPTERS) private readonly adapters: readonly CommunicationProviderAdapter[] = []) {}
  private admit(req: HonRequest, operation: Operation) {
    // An invitation email shares the invite budget: both start something for a person outside the school.
    const wait = this.rateLimit.admit(req.honIdentity!.externalSubject, operation==='end'?'revoke':operation==='email'?'invite':operation);
    if (wait) {
      req.res?.setHeader('Retry-After', String(wait));
      throw new HttpException({code:'ACCOUNT_RATE_LIMITED',outcome:'NOT_SUBMITTED',retryAfterSeconds:wait},429);
    }
  }
  private async run(operation: Operation, args: (string|null)[]): Promise<unknown> {
    try { return await this.database.callSchoolFamilyAccount(operation,args); }
    catch (e) {
      const code=(e as {code?:string}).code;
      if(code==='42501') throw new ForbiddenException({code:'ACCOUNT_FORBIDDEN'});
      if(code==='P0002') throw new HttpException({code:'ACCOUNT_UNAVAILABLE'},404);
      if(code==='23514') throw new HttpException({code:'ACCOUNT_REVIEW_REQUIRED'},409);
      if(code==='23505'||code==='40001') throw new HttpException({code:'ACCOUNT_CONFLICT'},409);
      if(code==='55P03') throw new HttpException({code:'ACCOUNT_BUSY',outcome:'NOT_SUBMITTED'},503);
      if(code==='54000') throw new HttpException({code:'ACCOUNT_EMAIL_LIMIT',outcome:'NOT_SUBMITTED'},429);
      if(code==='22023'||code==='22P02') throw new BadRequestException({code:'ACCOUNT_INPUT_INVALID'});
      throw new ServiceUnavailableException({code:'ACCOUNT_UNAVAILABLE',outcome:'UNKNOWN_OR_RETRY_REQUIRED'});
    }
  }
  /**
   * 0714: emails one pending invitation's link. Nothing is recorded while email sending is off (no READY adapter or no
   * public origin), so the three-email allowance is never spent on a send that cannot happen. The database then decides
   * and records the send and returns the only address used. The private code is held for this one send and never stored.
   */
  async email(req: HonRequest, raw: unknown, key: unknown) {
    let input: FamilyInvitationEmailInput;
    try { accountUuid(key); input=validateFamilyInvitationEmailInput(raw); } catch { throw new BadRequestException({code:'ACCOUNT_INPUT_INVALID'}); }
    this.admit(req,'email');
    const adapter=this.adapters.find(candidate=>candidate.channel==='EMAIL'&&candidate.readiness()==='READY');
    const origin=familyInviteOrigin(process.env.HON_PUBLIC_ORIGIN);
    if(!adapter||!origin) throw new HttpException({code:'ACCOUNT_EMAIL_OFF',outcome:'NOT_SUBMITTED'},503);
    const data=await this.run('email',[req.honIdentity!.externalSubject,JSON.stringify({schoolId:input.schoolId,invitationId:input.invitationId,tokenHash:sha(input.token)}),key as string]);
    let grant;
    try { grant=validateFamilyInvitationEmailGrant(data); } catch { throw new ServiceUnavailableException({code:'ACCOUNT_UNAVAILABLE',outcome:'UNKNOWN_OR_RETRY_REQUIRED'}); }
    let delivery: FamilyInvitationEmailDelivery='ALREADY_REQUESTED';
    if(!grant.replayed) {
      const mail=familyInvitationEmail({origin,invitationId:grant.invitationId,token:input.token,schoolName:grant.schoolName,expiresAt:grant.expiresAt,language:input.language});
      let timer: NodeJS.Timeout|undefined;
      try {
        await Promise.race([
          adapter.send({deliveryId:key as string,messageId:grant.invitationId,organizationId:grant.organizationId,schoolId:grant.schoolId,channel:'EMAIL',
            recipientAddress:grant.email,content:mail.text,html:mail.html,subject:mail.subject,schoolName:grant.schoolName,attempt:grant.emailNumber,purpose:'ACCOUNT'}),
          new Promise<never>((_,reject)=>{ timer=setTimeout(()=>reject(new CommunicationProviderError('UNKNOWN')),EMAIL_SEND_TIMEOUT_MS); }),
        ]);
        delivery='SENT';
      } catch (error) {
        // FAILED and RETRYABLE both mean the provider did not take it; this request is spent either way, so the staff member sends again.
        delivery=error instanceof CommunicationProviderError&&error.outcome!=='UNKNOWN'?'NOT_SENT':'UNKNOWN';
      } finally { if(timer) clearTimeout(timer); }
    }
    return validateFamilyInvitationEmailReceipt({invitationId:grant.invitationId,email:grant.email,emailNumber:grant.emailNumber,delivery});
  }
  async command(req: HonRequest, operation: Command, raw: unknown, key: unknown) {
    const subject=req.honIdentity!.externalSubject; let input: object; let email: string|null=null;
    try {
      accountUuid(key);
      if(operation==='invite') { const {token,...rest}=validateFamilyAccessInvitationInput(raw); input={...rest,tokenHash:sha(token)}; }
      else if(operation==='revoke') input=validateFamilyAccessInvitationRevoke(raw);
      else if(operation==='end') input=validateFamilyAccessEnd(raw);
      else { const {token,...rest}=validateFamilyAccessInvitationAcceptance(raw); input={...rest,tokenHash:sha(token)}; }
    } catch { throw new BadRequestException({code:'ACCOUNT_INPUT_INVALID'}); }
    if(operation==='accept') {
      const config=sessionConfig();
      // Reuse the verified HON session; no email, subject, family or school comes from the body.
      const proof=verifySession(cookieValue(req.headers.cookie,HON_SESSION_COOKIE)!,config);
      if(config.mode!=='OIDC'||proof.emailVerified!==true||!proof.email||proof.externalSubject!==subject) throw new ForbiddenException({code:'VERIFIED_EMAIL_REQUIRED'});
      email=proof.email.toLowerCase().trim();
    }
    this.admit(req,operation);
    const data=await this.run(operation,operation==='accept'?[subject,email,JSON.stringify(input),key as string]:[subject,JSON.stringify(input),key as string]);
    return operation==='accept'?validateFamilyAccountReceipt(data):validateFamilyAccessInvitation(data);
  }
  async list(req: HonRequest, school: string) {
    try { accountUuid(school); } catch { throw new BadRequestException({code:'ACCOUNT_INPUT_INVALID'}); }
    this.admit(req,'list');
    const data=await this.run('list',[req.honIdentity!.externalSubject,school]);
    if(!Array.isArray(data)||data.length>50) throw new ServiceUnavailableException({code:'ACCOUNT_UNAVAILABLE'});
    return data.map(validateFamilyAccessInvitation);
  }
}
