import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { accountUuid, validateAdmissionLimitsInput, validateAdmissionLimitsReceipt, validateAdmissionStatus } from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

/**
 * HQ view and control of the HON OS sign-up and trial admission limits (0274). The database decides every authority:
 * HQ owner or HQ billing reader to read, HQ owner only to change. Changing a limit never opens either program.
 */
@Injectable()
export class HonOsAdmissionService {
  private readonly log = new Logger('HonOsAdmission');
  constructor(private readonly database: RuntimeDatabaseService) {}
  private async run(operation: 'read' | 'set', args: string[]): Promise<unknown> {
    try { return await this.database.callHonOsAdmission(operation, args); }
    catch (e) {
      const { code } = e as { code?: string };
      if (code === '42501') throw new ForbiddenException({ code: 'ADMISSION_FORBIDDEN' });
      if (code === '40001') throw new ConflictException({ code: 'ADMISSION_LIMITS_CHANGED' });
      if (code === '23505') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
      if (code === '55P03' || code === '57014') throw new HttpException({ code: 'ADMISSION_OUTCOME_UNKNOWN', outcome: 'UNKNOWN_OR_RETRY_REQUIRED' }, 503);
      if (code === '22023' || code === '22P02' || code === '23514') throw new BadRequestException({ code: 'ADMISSION_INPUT_INVALID' });
      throw new ServiceUnavailableException({ code: 'ADMISSION_UNAVAILABLE', outcome: 'UNKNOWN_OR_RETRY_REQUIRED' });
    }
  }
  async status(req: HonRequest) {
    const data = await this.run('read', [req.honIdentity!.externalSubject]);
    try { return validateAdmissionStatus(data); } catch { throw new ServiceUnavailableException({ code: 'ADMISSION_UNAVAILABLE' }); }
  }
  async set(req: HonRequest, raw: unknown, key: unknown) {
    let input: object;
    try { accountUuid(key); input = validateAdmissionLimitsInput(raw); } catch { throw new BadRequestException({ code: 'ADMISSION_INPUT_INVALID' }); }
    const data = await this.run('set', [req.honIdentity!.externalSubject, JSON.stringify(input), key as string, randomUUID(), randomUUID()]);
    try { return validateAdmissionLimitsReceipt(data); } catch { throw new ServiceUnavailableException({ code: 'ADMISSION_UNAVAILABLE', outcome: 'UNKNOWN_OR_RETRY_REQUIRED' }); }
  }
  /**
   * After a CAPACITY_REACHED refusal: record it for HQ in a separate transaction. The database counts it only while the
   * limit is reached at that moment. Never changes the refusal the caller already has; a failure here is only logged.
   */
  async recordRefusal(kind: 'SIGNUP' | 'TRIAL'): Promise<void> {
    try { await this.database.callHonOsAdmission('refused', [kind]); }
    catch { this.log.warn(`admission refusal not recorded (${kind})`); }
  }
}
