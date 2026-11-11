import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { accountUuid, validateHonOsTrial, validateTrialStartInput, validateTrialStatus } from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { SchoolAccountRateLimit } from './school-account-rate-limit.js';

// Refusals the owner can act on. Anything else is redacted to a closed code by SQLSTATE.
const CONFLICTS = new Set(['TRIAL_CLOSED', 'TRIAL_ALREADY_USED', 'TRIAL_CAMPAIGN_UNAVAILABLE', 'TRIAL_CAMPAIGN_FULL', 'TRIAL_NOT_ELIGIBLE', 'TRIAL_KEY_REUSED']);

/** The 14-day free trial. Subject comes only from the HON session; the database re-derives the school, owner and campaign. */
@Injectable()
export class HonOsTrialService {
  private readonly rateLimit = new SchoolAccountRateLimit();
  constructor(private readonly database: RuntimeDatabaseService) {}
  private admit(req: HonRequest, operation: 'accept' | 'list') {
    const wait = this.rateLimit.admit(req.honIdentity!.externalSubject, operation);
    if (wait) {
      req.res?.setHeader('Retry-After', String(wait));
      throw new HttpException({ code: 'ACCOUNT_RATE_LIMITED', outcome: 'NOT_SUBMITTED', retryAfterSeconds: wait }, 429);
    }
  }
  private async run(operation: 'start' | 'read', args: string[]): Promise<unknown> {
    try { return await this.database.callHonOsTrial(operation, args); }
    catch (e) {
      const { code, message } = e as { code?: string; message?: string };
      if (message && CONFLICTS.has(message) && ['55000', '23505', '23514'].includes(code ?? '')) throw new ConflictException({ code: message });
      if (code === '42501') throw new ForbiddenException({ code: 'ACCOUNT_FORBIDDEN' });
      if (code === 'P0002') throw new HttpException({ code: 'ACCOUNT_UNAVAILABLE' }, 404);
      if (code === '23505' || code === '40001' || code === '23514') throw new ConflictException({ code: 'ACCOUNT_CONFLICT' });
      if (code === '55P03') throw new HttpException({ code: 'TRIAL_BUSY', outcome: 'NOT_SUBMITTED' }, 503);
      if (code === '22023' || code === '22P02') throw new BadRequestException({ code: 'ACCOUNT_INPUT_INVALID' });
      throw new ServiceUnavailableException({ code: 'ACCOUNT_UNAVAILABLE', outcome: 'UNKNOWN_OR_RETRY_REQUIRED' });
    }
  }
  async start(req: HonRequest, raw: unknown, key: unknown) {
    let input: object;
    try { accountUuid(key); input = validateTrialStartInput(raw); } catch { throw new BadRequestException({ code: 'ACCOUNT_INPUT_INVALID' }); }
    this.admit(req, 'accept');
    const data = await this.run('start', [req.honIdentity!.externalSubject, JSON.stringify(input), key as string]);
    try { return validateHonOsTrial(data); } catch { throw new ServiceUnavailableException({ code: 'ACCOUNT_UNAVAILABLE' }); }
  }
  async status(req: HonRequest) {
    this.admit(req, 'list');
    const data = await this.run('read', [req.honIdentity!.externalSubject]);
    try { return validateTrialStatus(data); } catch { throw new ServiceUnavailableException({ code: 'ACCOUNT_UNAVAILABLE' }); }
  }
}
