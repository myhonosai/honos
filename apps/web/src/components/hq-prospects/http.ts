import { HQ_PROSPECT_COMMANDS, encodeHqProspectCursor, validateHqProspectConsentInput, validateHqProspectCreateInput, validateHqProspectDetail,
  validateHqProspectList, validateHqProspectReceipt, validateHqProspectUpdateInput, type HqProspectConsentInput, type HqProspectCreateInput,
  type HqProspectCursor, type HqProspectDetail, type HqProspectList, type HqProspectReceipt, type HqProspectStatus, type HqProspectUpdateInput } from '@hon/contracts';
import { CommsError, commsCommand, commsId, commsRead, type Owned } from '../hq-communications/http';

/**
 * HON prospects (HQ-COMM E1, 0283). HQ owner or hq.marketing.manage; the database decides every time. Contact details are
 * shown to these people only. Nothing here sends a message.
 */
const BASE = '/api/v1/hq/prospects';
export const HQ_PROSPECT_REFUSALS: ReadonlySet<string> = new Set(['HQ_PROSPECT_EXISTS', 'HQ_PROSPECT_NO_CHANGE', 'HQ_PROSPECT_ARCHIVED',
  'HQ_PROSPECT_NO_ADDRESS', 'HQ_CONSENT_NOT_ALLOWED', 'HQ_CONSENT_NO_CHANGE']);
export const PROSPECT_PAGE_SIZE = 25;
const same = (a: string | null, b: string | null) => (a === null || b === null) ? a === b : a.toLowerCase() === b.toLowerCase();

export const prospectsApi = {
  async list(request: Readonly<{ status: HqProspectStatus | null; cursor: HqProspectCursor | null }>, signal: AbortSignal, owned: Owned): Promise<HqProspectList> {
    const q = new URLSearchParams();
    if (request.status) q.set('status', request.status);
    if (request.cursor) q.set('cursor', encodeHqProspectCursor(request.cursor));
    q.set('limit', String(PROSPECT_PAGE_SIZE));
    const list = await commsRead(`${BASE}?${q}`, signal, owned, validateHqProspectList);
    if (list.prospects.some((p) => request.status !== null && p.status !== request.status)) throw new CommsError('UNKNOWN');
    return list;
  },
  async read(prospectId: string, signal: AbortSignal, owned: Owned): Promise<HqProspectDetail> {
    const id = commsId(prospectId);
    if (!id) throw new CommsError('INVALID');
    const d = await commsRead(`${BASE}/${id}`, signal, owned, validateHqProspectDetail);
    if (!same(d.prospect.prospectId, id)) throw new CommsError('UNKNOWN');
    return d;
  },
  async create(input: HqProspectCreateInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqProspectReceipt> {
    let body: HqProspectCreateInput;
    try { body = validateHqProspectCreateInput(input); } catch { throw new CommsError('INVALID'); }
    const r = await commsCommand(BASE, HQ_PROSPECT_COMMANDS.create, body, key, signal, owned, validateHqProspectReceipt, HQ_PROSPECT_REFUSALS);
    if (r.operation !== 'CREATE' || r.prospect.email !== body.email || r.prospect.phone !== body.phone) throw new CommsError('UNKNOWN');
    return r;
  },
  async update(prospectId: string, input: HqProspectUpdateInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqProspectReceipt> {
    const id = commsId(prospectId);
    let body: HqProspectUpdateInput;
    try { if (!id) throw new Error('id'); body = validateHqProspectUpdateInput(input); } catch { throw new CommsError('INVALID'); }
    const r = await commsCommand(`${BASE}/${id}`, HQ_PROSPECT_COMMANDS.update, body, key, signal, owned, validateHqProspectReceipt, HQ_PROSPECT_REFUSALS);
    if (r.operation !== 'UPDATE' || !same(r.prospect.prospectId, id) || r.prospect.status !== body.status) throw new CommsError('UNKNOWN');
    return r;
  },
  async consent(prospectId: string, input: HqProspectConsentInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqProspectReceipt> {
    const id = commsId(prospectId);
    let body: HqProspectConsentInput;
    try { if (!id) throw new Error('id'); body = validateHqProspectConsentInput(input); } catch { throw new CommsError('INVALID'); }
    const r = await commsCommand(`${BASE}/${id}/consents`, HQ_PROSPECT_COMMANDS.consent, body, key, signal, owned, validateHqProspectReceipt, HQ_PROSPECT_REFUSALS);
    if (r.operation !== 'CONSENT' || !same(r.prospect.prospectId, id) || r.prospect.version !== body.expectedVersion + 1) throw new CommsError('UNKNOWN');
    return r;
  },
};
export type ProspectsApi = typeof prospectsApi;
