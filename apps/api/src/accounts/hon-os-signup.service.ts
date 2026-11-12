import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { accountUuid, validateSignupInput, validateSignupRegistration, validateSignupStatus } from '@hon/contracts';
import { cookieValue, HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { SchoolAccountRateLimit } from './school-account-rate-limit.js';

// Business refusals the owner can act on. Anything else is redacted to a closed code by SQLSTATE.
const CONFLICTS = new Set(['SIGNUP_CLOSED', 'SIGNUP_ALREADY_REGISTERED', 'SIGNUP_TERMS_CHANGED', 'SIGNUP_REVIEW_REQUIRED', 'SIGNUP_OWNER_NOT_ELIGIBLE', 'SIGNUP_KEY_REUSED', 'SIGNUP_EMAIL_DOMAIN_NOT_ACCEPTED', 'SIGNUP_CAPACITY_REACHED']);

@Injectable()
export class HonOsSignupService {
  private readonly rateLimit = new SchoolAccountRateLimit();
  constructor(private readonly database: RuntimeDatabaseService) {}
  private admit(req: HonRequest, operation: 'accept' | 'list') {
    const wait = this.rateLimit.admit(req.honIdentity!.externalSubject, operation);
    if (wait) {
      req.res?.setHeader('Retry-After', String(wait));
      throw new HttpException({ code: 'ACCOUNT_RATE_LIMITED', outcome: 'NOT_SUBMITTED', retryAfterSeconds: wait }, 429);
    }
  }
  private async run(operation: 'register' | 'read', args: (string | null)[]): Promise<unknown> {
    try { return await this.database.callHonOsSignup(operation, args); }
    catch (e) {
      const { code, message } = e as { code?: string; message?: string };
      if (message && CONFLICTS.has(message) && ['55000', '23505', '23514'].includes(code ?? '')) throw new ConflictException({ code: message });
      if (code === '42501') throw new ForbiddenException({ code: 'ACCOUNT_FORBIDDEN' });
      if (code === 'P0002') throw new HttpException({ code: 'ACCOUNT_UNAVAILABLE' }, 404);
      if (code === '23505' || code === '40001' || code === '23514') throw new ConflictException({ code: 'ACCOUNT_CONFLICT' });
      if (code === '55P03') throw new HttpException({ code: 'SIGNUP_BUSY', outcome: 'NOT_SUBMITTED' }, 503);
      if (code === '22023' || code === '22P02') throw new BadRequestException({ code: 'ACCOUNT_INPUT_INVALID' });
      throw new ServiceUnavailableException({ code: 'ACCOUNT_UNAVAILABLE', outcome: 'UNKNOWN_OR_RETRY_REQUIRED' });
    }
  }
  async register(req: HonRequest, raw: unknown, key: unknown) {
    const subject = req.honIdentity!.externalSubject;
    let input: object;
    try { accountUuid(key); input = validateSignupInput(raw); } catch { throw new BadRequestException({ code: 'ACCOUNT_INPUT_INVALID' }); }
    const config = sessionConfig();
    // Subject and verified email come only from the HON-signed OIDC session, never from the body.
    const proof = verifySession(cookieValue(req.headers.cookie, HON_SESSION_COOKIE)!, config);
    if (config.mode !== 'OIDC' || proof.emailVerified !== true || !proof.email || proof.externalSubject !== subject) throw new ForbiddenException({ code: 'VERIFIED_EMAIL_REQUIRED' });
    this.admit(req, 'accept');
    const data = await this.run('register', [subject, proof.email.toLowerCase().trim(), JSON.stringify(input), key as string]);
    try { return validateSignupRegistration(data); } catch { throw new ServiceUnavailableException({ code: 'ACCOUNT_UNAVAILABLE' }); }
  }
  async status(req: HonRequest) {
    this.admit(req, 'list');
    const data = await this.run('read', [req.honIdentity!.externalSubject]);
    try { return validateSignupStatus(data); } catch { throw new ServiceUnavailableException({ code: 'ACCOUNT_UNAVAILABLE' }); }
  }
}
