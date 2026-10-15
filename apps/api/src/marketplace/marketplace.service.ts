import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { communityUuid, communityVersion, validateMarketplaceInput, validateMarketplaceSelection, verifyMarketplaceAsset, verifyMarketplaceSelection, verifyMarketplaceAccess, verifyMarketplacePage, verifyMarketplaceHistory, type MarketplaceContext, type MarketplaceInput } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
export function marketplaceId(v: unknown): asserts v is string { try { communityUuid(v); } catch { invalid(); } }
function invalid(): never { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Closed descriptive fields only. No private data, contacts, URLs, credentials, attachments or code.' }); }
function human(c: MarketplaceContext) {
  if (c.principalType !== 'HUMAN_USER' || c.source !== 'HUMAN_UI' || c.actionRequestId || c.delegatedByPrincipalId) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  for (const id of [c.organizationId, c.schoolId, c.principalId, c.requestId, c.correlationId]) marketplaceId(id);
  if (typeof c.externalSubject !== 'string' || !c.externalSubject || c.externalSubject.length > 200) invalid();
}
@Injectable()
export class MarketplaceService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  private async boundary<T>(c: MarketplaceContext, sql: string, args: unknown[], verify: (v: unknown) => T): Promise<T> {
    human(c);
    try { return await this.database.withTenantTransaction(c, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [c.source]);
      await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
      return verify((await client.query<{ data: unknown }>(sql, args)).rows[0]?.data);
    }); } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '42501') throw new ForbiddenException({ code: 'MARKETPLACE_FORBIDDEN' });
      if (code === 'P0002') throw new NotFoundException({ code: 'MARKETPLACE_UNAVAILABLE' });
      if (['40001', '23505', '55P03', '40P01'].includes(code ?? '')) throw new ConflictException({ code: 'MARKETPLACE_CONFLICT', detail: 'Reload the version. Retain the key for unchanged uncertain requests.' });
      if (['22023', '22P02', '23514', '23503', '22003'].includes(code ?? '')) invalid();
      throw new ServiceUnavailableException({ code: 'MARKETPLACE_UNAVAILABLE', detail: 'No verified result; no save assumed.' });
    }
  }
  read(c: MarketplaceContext, mode: 'ACCESS' | 'BROWSE' | 'OWN' | 'SAVED' | 'HISTORY', id: string | null = null, after: string | null = null, before: number | null = null) {
    if (!['ACCESS', 'BROWSE', 'OWN', 'SAVED', 'HISTORY'].includes(mode)) invalid();
    if (id !== null) marketplaceId(id); if (after !== null) marketplaceId(after);
    if (before !== null) { try { communityVersion(before, 1); } catch { invalid(); } }
    return this.boundary(c, 'SELECT hon.read_marketplace($1,$2,$3::uuid,$4::uuid,$5::integer) data', [c.externalSubject, mode, id, after, before], v => {
      if (mode === 'ACCESS') return verifyMarketplaceAccess(v);
      if (mode === 'HISTORY') { const h = verifyMarketplaceHistory(v); if (h.id !== id) throw new Error('Unverified history scope'); return h; }
      if (mode === 'SAVED') return verifyMarketplacePage(v, verifyMarketplaceSelection);
      if (id !== null) { const r = verifyMarketplaceAsset(v, mode === 'BROWSE'); if (r.id !== id) throw new Error('Unverified asset scope'); return r; }
      return verifyMarketplacePage(v, x => verifyMarketplaceAsset(x, mode === 'BROWSE'));
    });
  }
  mutate(c: MarketplaceContext, op: 'ASSET' | 'SAVE', id: string | null, input: MarketplaceInput | { assetVersion: number; expectedVersion: 0 }) {
    human(c); if (id !== null) marketplaceId(id);
    try {
      if (op === 'ASSET') { validateMarketplaceInput(input); if ((id === null) !== (input.expectedVersion === 0)) invalid(); }
      else if (op === 'SAVE') { validateMarketplaceSelection(input); if (id === null) invalid(); }
      else invalid();
    } catch { invalid(); }
    if (typeof c.idempotencyKey !== 'string' || !c.idempotencyKey || c.idempotencyKey.length > 200 || c.idempotencyKey.trim() !== c.idempotencyKey || /[\u0000-\u001f\u007f]/.test(c.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return this.boundary(c, 'SELECT hon.mutate_marketplace($1,$2,$3::uuid,$4::jsonb,$5,$6::uuid) data', [c.externalSubject, op, id, JSON.stringify(input), c.idempotencyKey, c.requestId], v => {
      if (!v || typeof v !== 'object' || Object.keys(v).length !== 2 || !Object.hasOwn(v, 'result') || typeof (v as { replayed?: unknown }).replayed !== 'boolean') throw new Error('Unverified marketplace output');
      const r = v as { result: unknown; replayed: boolean };
      const result = op === 'ASSET' ? verifyMarketplaceAsset(r.result) : verifyMarketplaceSelection(r.result);
      if (op === 'ASSET') {
        const { id: resultId, version, ...fields } = result as ReturnType<typeof verifyMarketplaceAsset>;
        // Exact closed metadata equality, independent of JSON object key ordering.
        if ((id !== null && resultId !== id) || version !== input.expectedVersion + 1
          || Object.entries(fields).some(([k, value]) => JSON.stringify(value) !== JSON.stringify((input as unknown as Record<string, unknown>)[k]))) throw new Error('Unverified asset save');
      } else { const s = result as ReturnType<typeof verifyMarketplaceSelection>; if (s.assetId !== id || s.assetVersion !== (input as { assetVersion: number }).assetVersion) throw new Error('Unverified selection save'); }
      return { result, replayed: r.replayed };
    });
  }
}
