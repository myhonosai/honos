import { Injectable } from '@nestjs/common';
import { saasUuid, validateHqSupportCaseDetail, validateHqSupportCaseList, validateHqSupportChangeInput, validateHqSupportListQuery,
  validateHqSupportNoteInput, validateHqSupportOpenInput, validateHqSupportReceipt, validateHqSupportSchools } from '@hon/contracts';
import { BadRequestException } from '@nestjs/common';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';

function parse<T>(f: () => T): T { try { return f(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); } }

/** B-HQ-2 HQ support records. The database decides HQ support authority on every read and command. */
@Injectable()
export class HqSupportService {
  constructor(private readonly billing: SaasBillingService) {}
  async list(subject: string, query: unknown) {
    const q = parse(() => validateHqSupportListQuery(query));
    return this.billing.call('readSupportCases', [subject, q.status, q.organizationId, q.cursor?.openedAt ?? null, q.cursor?.caseId ?? null, String(q.limit)],
      validateHqSupportCaseList);
  }
  async schools(subject: string) { return this.billing.call('readSupportSchools', [subject], validateHqSupportSchools); }
  async read(subject: string, caseId: unknown) {
    const id = parse(() => saasUuid(caseId));
    return this.billing.call('readSupportCase', [subject, id], (v) => {
      const d = validateHqSupportCaseDetail(v); if (d.case.caseId.toLowerCase() !== id.toLowerCase()) throw new Error('mismatch'); return d;
    });
  }
  async open(subject: string, body: unknown, key: unknown) {
    const [input, k] = parse(() => [validateHqSupportOpenInput(body), saasUuid(key)] as const);
    return this.billing.call('openSupportCase', [subject, JSON.stringify(input), k], validateHqSupportReceipt);
  }
  async note(subject: string, caseId: unknown, body: unknown, key: unknown) {
    const [id, input, k] = parse(() => [saasUuid(caseId), validateHqSupportNoteInput(body), saasUuid(key)] as const);
    return this.billing.call('addSupportNote', [subject, id, JSON.stringify(input), k], validateHqSupportReceipt);
  }
  async change(subject: string, caseId: unknown, body: unknown, key: unknown) {
    const [id, input, k] = parse(() => [saasUuid(caseId), validateHqSupportChangeInput(body), saasUuid(key)] as const);
    return this.billing.call('changeSupportCase', [subject, id, JSON.stringify(input), k], validateHqSupportReceipt);
  }
}
