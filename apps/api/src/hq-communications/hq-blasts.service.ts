import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { saasUuid, validateHqBlastCancelInput, validateHqBlastSaveInput, validateHqBlastSendInput, verifyHqBlastAudience, verifyHqBlastDetail,
  verifyHqBlastList, verifyHqBlastOptions, verifyHqBlastReceipt, validateHqBlastTemplateSaveInput, verifyHqBlastTemplateList, verifyHqBlastTemplateReceipt } from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';

function parse<T>(f: () => T): T { try { return f(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); } }
function exactBody(body: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body');
  const o = body as Record<string, unknown>;
  if (Object.keys(o).some((k) => !keys.includes(k))) throw new Error('body');
  return o;
}

/**
 * HB1 (0712) HQ text and email blasts to the current owners of many schools at once. The database decides everything:
 * HQ owner only, the audience from closed filters, who is reachable, the caps, and the per-school messages. Nothing here
 * sends: the HQ communication worker delivers each queued message through the existing HQ dispatcher.
 */
@Injectable()
export class HqBlastsService {
  constructor(private readonly billing: SaasBillingService) {}
  async list(subject: string) { return this.billing.call('readHqBlasts', [subject], verifyHqBlastList); }
  async read(subject: string, blastId: unknown) {
    const id = parse(() => saasUuid(blastId));
    return this.billing.call('readHqBlast', [subject, id], (v) => verifyHqBlastDetail(v, { blastId: id }));
  }
  async audience(subject: string, blastId: unknown) {
    const id = parse(() => saasUuid(blastId));
    return this.billing.call('readHqBlastAudience', [subject, id], (v) => verifyHqBlastAudience(v, { blastId: id }));
  }
  async options(subject: string, query: Record<string, unknown>) {
    const search = parse(() => {
      const q = exactBody(query, ['search']);
      if (q.search === undefined) return null;
      if (typeof q.search !== 'string' || q.search.trim() !== q.search || q.search.length < 2 || q.search.length > 80 || /[\u0000-\u001f\u007f]/.test(q.search)) throw new Error('search');
      return q.search;
    });
    return this.billing.call('readHqBlastOptions', [subject, search], verifyHqBlastOptions);
  }
  async save(subject: string, body: unknown, key: unknown) {
    const [input, k] = parse(() => [validateHqBlastSaveInput(body), saasUuid(key)] as const);
    return this.billing.call('saveHqBlast', [subject, JSON.stringify(input), k, randomUUID(), randomUUID()],
      (v) => verifyHqBlastReceipt(v, { operation: 'SAVE', blastId: input.blastId, status: 'DRAFT' }));
  }
  async send(subject: string, blastId: unknown, body: unknown, key: unknown) {
    const [input, k] = parse(() => [validateHqBlastSendInput({ ...exactBody(body, ['expectedVersion', 'sendAt']), blastId: saasUuid(blastId) }), saasUuid(key)] as const);
    return this.billing.call('sendHqBlast', [subject, JSON.stringify(input), k, randomUUID(), randomUUID()],
      (v) => verifyHqBlastReceipt(v, { operation: 'SEND', blastId: input.blastId, status: 'QUEUED' }));
  }
  async cancel(subject: string, blastId: unknown, body: unknown, key: unknown) {
    const [input, k] = parse(() => [validateHqBlastCancelInput({ ...exactBody(body, ['expectedVersion']), blastId: saasUuid(blastId) }), saasUuid(key)] as const);
    return this.billing.call('cancelHqBlast', [subject, JSON.stringify(input), k, randomUUID(), randomUUID()],
      (v) => verifyHqBlastReceipt(v, { operation: 'CANCEL', blastId: input.blastId, status: 'CANCELLED' }));
  }
  async templates(subject: string) { return this.billing.call('readHqBlastTemplates', [subject], verifyHqBlastTemplateList); }
  async saveTemplate(subject: string, body: unknown, key: unknown) {
    const [input, k] = parse(() => [validateHqBlastTemplateSaveInput(body), saasUuid(key)] as const);
    return this.billing.call('saveHqBlastTemplate', [subject, JSON.stringify(input), k, randomUUID(), randomUUID()],
      (v) => verifyHqBlastTemplateReceipt(v, { templateId: input.templateId, archived: input.archived }));
  }
}
