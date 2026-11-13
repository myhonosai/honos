import { BadRequestException, Injectable } from '@nestjs/common';
import { saasUuid, validateHqCommunicationsQuery, validateHqCommunicationsView, validateHqMessageCreateInput, validateHqMessageDetail,
  validateHqMessageReceipt, validateHqMessageVersionInput, validateHqSenderReceipt, validateHqSenderSetInput } from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';

function parse<T>(f: () => T): T { try { return f(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); } }

/**
 * HQ-COMM (0281) HQ texting and email to school owners. The database decides HQ authority per purpose on every read and
 * command, resolves recipients, and never returns an address. Nothing here sends: the communication worker delivers.
 */
@Injectable()
export class HqCommunicationsService {
  constructor(private readonly billing: SaasBillingService) {}
  async view(subject: string, query: unknown) {
    const q = parse(() => validateHqCommunicationsQuery(query));
    return this.billing.call('readHqCommunications', [subject, q.schoolId, q.cursor?.createdAt ?? null, q.cursor?.messageId ?? null, String(q.limit)],
      validateHqCommunicationsView);
  }
  async read(subject: string, messageId: unknown) {
    const id = parse(() => saasUuid(messageId));
    return this.billing.call('readHqMessage', [subject, id], (v) => {
      const d = validateHqMessageDetail(v); if (d.message.messageId.toLowerCase() !== id.toLowerCase()) throw new Error('mismatch'); return d;
    });
  }
  async setSender(subject: string, body: unknown, key: unknown) {
    const [input, k] = parse(() => [validateHqSenderSetInput(body), saasUuid(key)] as const);
    return this.billing.call('setHqCommunicationSender', [subject, JSON.stringify(input), k], validateHqSenderReceipt);
  }
  async retireSender(subject: string, senderId: unknown, body: unknown, key: unknown) {
    const [id, k] = parse(() => {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new Error('body');
      return [saasUuid(senderId), saasUuid(key)] as const;
    });
    return this.billing.call('retireHqCommunicationSender', [subject, id, k], validateHqSenderReceipt);
  }
  async create(subject: string, body: unknown, key: unknown) {
    const [input, k] = parse(() => [validateHqMessageCreateInput(body), saasUuid(key)] as const);
    return this.billing.call('createHqMessage', [subject, JSON.stringify(input), k], validateHqMessageReceipt);
  }
  async queue(subject: string, messageId: unknown, body: unknown, key: unknown) {
    const [id, input, k] = parse(() => [saasUuid(messageId), validateHqMessageVersionInput(body), saasUuid(key)] as const);
    return this.billing.call('queueHqMessage', [subject, id, JSON.stringify(input), k], validateHqMessageReceipt);
  }
  async cancel(subject: string, messageId: unknown, body: unknown, key: unknown) {
    const [id, input, k] = parse(() => [saasUuid(messageId), validateHqMessageVersionInput(body), saasUuid(key)] as const);
    return this.billing.call('cancelHqMessage', [subject, id, JSON.stringify(input), k], validateHqMessageReceipt);
  }
}
