import {
  HQ_BLAST_COMMANDS, saasUuid, validateHqBlastCancelInput, validateHqBlastSaveInput, validateHqBlastSendInput, verifyHqBlastAudience, verifyHqBlastDetail,
  verifyHqBlastList, verifyHqBlastOptions, verifyHqBlastReceipt, type HqBlastAudiencePreview, type HqBlastCancelInput, type HqBlastDetail, type HqBlastList,
  type HqBlastOptions, type HqBlastReceipt, type HqBlastSaveInput, type HqBlastSendInput,
} from '@hon/contracts';
import { CommsError, commsCommand, commsId, commsRead, type Owned } from '../hq-communications/http';

/**
 * HB1/HB2 (0712) HQ blasts. Same guards as HQ texts and email: reads are same-origin GETs with only the declared query,
 * commands carry the human-command marker and an Idempotency-Key. The database decides (HQ owner only) every time.
 */
const BASE = '/api/v1/hq/communications/blasts';
export const HQ_BLAST_REFUSALS: ReadonlySet<string> = new Set(['HQ_BLAST_NOT_DRAFT', 'HQ_BLAST_NO_RECIPIENTS', 'HQ_BLAST_DAILY_LIMIT',
  'HQ_BLAST_AUDIENCE_TOO_LARGE', 'HQ_BLAST_NOT_CANCELLABLE', 'HQ_BLAST_SEND_TIME', 'HQ_BLAST_TEXT_TOO_LONG']);
const same = (a: string | null, b: string | null) => (a === null || b === null) ? a === b : a.toLowerCase() === b.toLowerCase();
const idOf = (v: string): string => { const id = commsId(v); if (!id) throw new CommsError('INVALID'); return id; };

export const hqBlastApi = {
  async list(signal: AbortSignal, owned: Owned): Promise<HqBlastList> { return commsRead(BASE, signal, owned, verifyHqBlastList); },
  async read(blastId: string, signal: AbortSignal, owned: Owned): Promise<HqBlastDetail> {
    const id = idOf(blastId);
    return commsRead(`${BASE}/${id}`, signal, owned, (v) => verifyHqBlastDetail(v, { blastId: id }));
  },
  async audience(blastId: string, signal: AbortSignal, owned: Owned): Promise<HqBlastAudiencePreview> {
    const id = idOf(blastId);
    return commsRead(`${BASE}/${id}/audience`, signal, owned, (v) => verifyHqBlastAudience(v, { blastId: id }));
  },
  /** Plan names, features, places, and up to 20 schools matching a 2-80 character search. */
  async options(search: string | null, signal: AbortSignal, owned: Owned): Promise<HqBlastOptions> {
    const q = search?.trim() ?? '';
    if (q && (q.length < 2 || q.length > 80)) throw new CommsError('INVALID');
    return commsRead(q ? `${BASE}/options?${new URLSearchParams({ search: q })}` : `${BASE}/options`, signal, owned, verifyHqBlastOptions);
  },
  /** Saves a draft. Nothing is sent until the blast is handed over with send. */
  async save(input: HqBlastSaveInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqBlastReceipt> {
    let body: HqBlastSaveInput;
    try { body = validateHqBlastSaveInput(input); } catch { throw new CommsError('INVALID'); }
    const r = await commsCommand(BASE, HQ_BLAST_COMMANDS.save, body, key, signal, owned,
      (v) => verifyHqBlastReceipt(v, { operation: 'SAVE', blastId: body.blastId, status: 'DRAFT' }), HQ_BLAST_REFUSALS);
    if (r.blast.name !== body.name || r.blast.body !== body.body || r.blast.channel !== body.channel || r.blast.purpose !== body.purpose
      || !same(r.blast.subject, body.subject) || (body.blastId !== null && r.blast.version !== body.expectedVersion + 1)) throw new CommsError('UNKNOWN');
    return r;
  },
  async send(input: HqBlastSendInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqBlastReceipt> {
    let body: HqBlastSendInput;
    try { body = validateHqBlastSendInput(input); } catch { throw new CommsError('INVALID'); }
    const r = await commsCommand(`${BASE}/${body.blastId}/send`, HQ_BLAST_COMMANDS.send, { expectedVersion: body.expectedVersion, sendAt: body.sendAt }, key, signal, owned,
      (v) => verifyHqBlastReceipt(v, { operation: 'SEND', blastId: body.blastId, status: 'QUEUED' }), HQ_BLAST_REFUSALS);
    if (r.blast.version !== body.expectedVersion + 1) throw new CommsError('UNKNOWN');
    return r;
  },
  async cancel(input: HqBlastCancelInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqBlastReceipt> {
    let body: HqBlastCancelInput;
    try { body = validateHqBlastCancelInput(input); } catch { throw new CommsError('INVALID'); }
    const r = await commsCommand(`${BASE}/${saasUuid(body.blastId)}/cancel`, HQ_BLAST_COMMANDS.cancel, { expectedVersion: body.expectedVersion }, key, signal, owned,
      (v) => verifyHqBlastReceipt(v, { operation: 'CANCEL', blastId: body.blastId, status: 'CANCELLED' }), HQ_BLAST_REFUSALS);
    if (r.blast.version !== body.expectedVersion + 1) throw new CommsError('UNKNOWN');
    return r;
  },
};
export type HqBlastApi = typeof hqBlastApi;
