import { BadRequestException, Injectable } from '@nestjs/common';
import { saasUuid, validateHqProspectConsentInput, validateHqProspectCreateInput, validateHqProspectDetail, validateHqProspectList,
  validateHqProspectListQuery, validateHqProspectReceipt, validateHqProspectUpdateInput, type HqProspectReceipt } from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';

function parse<T>(f: () => T): T { try { return f(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); } }
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * HQ-COMM E1 (0283) HON prospects and their consent. The database decides HQ marketing authority on every read and
 * command, and which consent HQ may record. Nothing here sends a message.
 */
@Injectable()
export class HqProspectsService {
  constructor(private readonly billing: SaasBillingService) {}
  async list(subject: string, query: unknown) {
    const q = parse(() => validateHqProspectListQuery(query));
    return this.billing.call('readHqProspects', [subject, q.status, q.campaignId, q.cursor?.createdAt ?? null, q.cursor?.prospectId ?? null, String(q.limit)], (v) => {
      const list = validateHqProspectList(v);
      // The page must match what was asked.
      if (list.limit !== q.limit || list.prospects.some(p => (q.status !== null && p.status !== q.status)
        || (q.campaignId !== null && (p.campaign === null || !same(p.campaign.campaignId, q.campaignId))))) throw new Error('mismatch');
      return list;
    });
  }
  async read(subject: string, id: unknown) {
    const prospectId = parse(() => saasUuid(id));
    return this.billing.call('readHqProspect', [subject, prospectId], (v) => {
      const d = validateHqProspectDetail(v); if (!same(d.prospect.prospectId, prospectId)) throw new Error('mismatch'); return d;
    });
  }
  async create(subject: string, body: unknown, key: unknown) {
    const [input, k] = parse(() => [validateHqProspectCreateInput(body), saasUuid(key)] as const);
    return this.billing.call('createHqProspect', [subject, JSON.stringify(input), k], (v) => {
      const r = validateHqProspectReceipt(v), p = r.prospect;
      if (r.operation !== 'CREATE' || p.fullName !== input.fullName || p.email !== input.email || p.phone !== input.phone || p.source !== input.source) throw new Error('mismatch');
      return r;
    });
  }
  async update(subject: string, id: unknown, body: unknown, key: unknown) {
    const [prospectId, input, k] = parse(() => [saasUuid(id), validateHqProspectUpdateInput(body), saasUuid(key)] as const);
    return this.billing.call('updateHqProspect', [subject, prospectId, JSON.stringify(input), k], (v) => {
      const r = validateHqProspectReceipt(v);
      if (r.operation !== 'UPDATE' || !same(r.prospect.prospectId, prospectId) || r.prospect.status !== input.status || r.prospect.email !== input.email
        || r.prospect.phone !== input.phone) throw new Error('mismatch');
      return r;
    });
  }
  async consent(subject: string, id: unknown, body: unknown, key: unknown): Promise<HqProspectReceipt> {
    const [prospectId, input, k] = parse(() => [saasUuid(id), validateHqProspectConsentInput(body), saasUuid(key)] as const);
    return this.billing.call('recordHqProspectConsent', [subject, prospectId, JSON.stringify(input), k], (v) => {
      const r = validateHqProspectReceipt(v);
      if (r.operation !== 'CONSENT' || !same(r.prospect.prospectId, prospectId)) throw new Error('mismatch');
      return r;
    });
  }
}
