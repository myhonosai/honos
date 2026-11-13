import { BadRequestException, Injectable } from '@nestjs/common';
import { saasUuid, validateHqContactPhoneStartInput, validateHqContactReceipt, validateHqContactTextingInput, validateHqContactView,
  validateHqMessageVersionInput } from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';

function parse<T>(f: () => T): T { try { return f(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); } }

/**
 * HQ-COMM (0282) the signed-in person's own number for texts from HON HQ. There is no user id anywhere: the identity is
 * the verified subject, and the database decides everything. The confirmation code is shown once and never stored.
 */
@Injectable()
export class HqContactService {
  constructor(private readonly billing: SaasBillingService) {}
  async view(subject: string) {
    return this.billing.call('readMyHqContact', [subject], validateHqContactView);
  }
  async startPhone(subject: string, body: unknown, key: unknown) {
    const [input, k] = parse(() => [validateHqContactPhoneStartInput(body), saasUuid(key)] as const);
    return this.billing.call('startMyHqPhone', [subject, JSON.stringify(input), k], (v) => {
      const r = validateHqContactReceipt(v); if (r.operation !== 'PHONE_START' || r.contact.phone !== input.phone) throw new Error('mismatch'); return r;
    });
  }
  async setTexting(subject: string, body: unknown, key: unknown) {
    const [input, k] = parse(() => [validateHqContactTextingInput(body), saasUuid(key)] as const);
    return this.billing.call('setMyHqTexting', [subject, JSON.stringify(input), k], (v) => {
      const r = validateHqContactReceipt(v); if (r.operation !== 'TEXTING' || r.contact.textingOn !== input.enabled) throw new Error('mismatch'); return r;
    });
  }
  async removePhone(subject: string, body: unknown, key: unknown) {
    const [input, k] = parse(() => [validateHqMessageVersionInput(body), saasUuid(key)] as const);
    return this.billing.call('removeMyHqPhone', [subject, JSON.stringify(input), k], (v) => {
      const r = validateHqContactReceipt(v); if (r.operation !== 'PHONE_REMOVE') throw new Error('mismatch'); return r;
    });
  }
}
