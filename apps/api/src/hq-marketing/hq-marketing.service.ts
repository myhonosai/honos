import { BadRequestException, Injectable } from '@nestjs/common';
import { saasUuid, validateHqMarketingCampaignDetail, validateHqMarketingCampaignList, validateHqMarketingCreateInput, validateHqMarketingListQuery,
  validateHqMarketingReceipt, validateHqMarketingStatusInput, validateHqMarketingUpdateInput } from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';

function parse<T>(f: () => T): T { try { return f(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); } }

/** M1 HQ marketing campaigns. The database decides HQ marketing authority on every read and command. */
@Injectable()
export class HqMarketingService {
  constructor(private readonly billing: SaasBillingService) {}
  async list(subject: string, query: unknown) {
    const q = parse(() => validateHqMarketingListQuery(query));
    return this.billing.call('readMarketingCampaigns', [subject, q.status, q.cursor?.createdAt ?? null, q.cursor?.campaignId ?? null, String(q.limit)], (v) => {
      const list = validateHqMarketingCampaignList(v);
      // The page must match what was asked.
      if (list.limit !== q.limit || list.campaigns.some(c => q.status !== null && (q.status === 'OPEN' ? c.status === 'ARCHIVED' : c.status !== q.status))) throw new Error('mismatch');
      return list;
    });
  }
  async read(subject: string, id: unknown) {
    const campaignId = parse(() => saasUuid(id));
    return this.billing.call('readMarketingCampaign', [subject, campaignId], (v) => {
      const d = validateHqMarketingCampaignDetail(v); if (d.campaign.campaignId.toLowerCase() !== campaignId.toLowerCase()) throw new Error('mismatch'); return d;
    });
  }
  async create(subject: string, body: unknown, key: unknown) {
    const [input, k] = parse(() => [validateHqMarketingCreateInput(body), saasUuid(key)] as const);
    return this.billing.call('createMarketingCampaign', [subject, JSON.stringify(input), k], validateHqMarketingReceipt);
  }
  async update(subject: string, id: unknown, body: unknown, key: unknown) {
    const [campaignId, input, k] = parse(() => [saasUuid(id), validateHqMarketingUpdateInput(body), saasUuid(key)] as const);
    return this.billing.call('updateMarketingCampaign', [subject, campaignId, JSON.stringify(input), k], validateHqMarketingReceipt);
  }
  async status(subject: string, id: unknown, body: unknown, key: unknown) {
    const [campaignId, input, k] = parse(() => [saasUuid(id), validateHqMarketingStatusInput(body), saasUuid(key)] as const);
    return this.billing.call('setMarketingCampaignStatus', [subject, campaignId, JSON.stringify(input), k], validateHqMarketingReceipt);
  }
}
