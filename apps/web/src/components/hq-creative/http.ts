import { SAAS_COMMANDS, saasUuid, validateHqCreativeBudgetInput, validateHqCreativeBudgetReceipt, validateHqCreativeGenerationInput,
  validateHqCreativeGenerationReceipt, validateHqCreativeResolveInput, validateHqCreativeStudio,
  type HqCreativeBudgetInput, type HqCreativeBudgetReceipt, type HqCreativeGenerationInput, type HqCreativeGenerationReceipt,
  type HqCreativeResolveInput, type HqCreativeStudio } from '@hon/contracts';
import { MarketingError, marketingCommand, marketingRead, type Owned } from '../hq-marketing/http';

/**
 * HQ Creative Studio (M2, 0253). Same transport rules as HQ campaigns: same origin, no-store reads, the human-command
 * marker and an Idempotency-Key on every command. The database decides HQ authority, the cap and every rule. The server
 * chooses the provider; with none connected a request is refused before anything is reserved.
 */
export type HqCreativeReceipt = HqCreativeGenerationReceipt | HqCreativeBudgetReceipt;
const id = (value: unknown): string => { try { return saasUuid(value); } catch { throw new MarketingError('INVALID'); } };

export const creativeApi = {
  studio(signal: AbortSignal, owned: Owned): Promise<HqCreativeStudio> {
    return marketingRead('/api/v1/hq/marketing/creative', signal, owned, validateHqCreativeStudio);
  },
  /** One request attempt. The same key and body replay the saved answer and never call the provider again. */
  async create(input: HqCreativeGenerationInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqCreativeGenerationReceipt> {
    let body: HqCreativeGenerationInput;
    try { body = validateHqCreativeGenerationInput(input); } catch { throw new MarketingError('INVALID'); }
    const r = await marketingCommand('/api/v1/hq/marketing/creative/generations', SAAS_COMMANDS.createHqCreativeGeneration, body, key, signal, owned,
      validateHqCreativeGenerationReceipt), g = r.generation;
    if (g.operationCode !== body.operationCode || g.units !== body.units || g.format !== body.format || g.prompt !== body.prompt
      || (g.campaign?.campaignId.toLowerCase() ?? null) !== body.campaignId) throw new MarketingError('UNKNOWN');
    return r;
  },
  async setBudget(input: HqCreativeBudgetInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqCreativeBudgetReceipt> {
    let body: HqCreativeBudgetInput;
    try { body = validateHqCreativeBudgetInput(input); } catch { throw new MarketingError('INVALID'); }
    const r = await marketingCommand('/api/v1/hq/marketing/creative/budget', SAAS_COMMANDS.setHqCreativeBudget, body, key, signal, owned, validateHqCreativeBudgetReceipt);
    if (r.budget.periodStart !== body.periodStart || r.budget.creditCap !== body.creditCap) throw new MarketingError('UNKNOWN');
    return r;
  },
  async resolve(generationId: string, input: HqCreativeResolveInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqCreativeGenerationReceipt> {
    const gid = id(generationId);
    let body: HqCreativeResolveInput;
    try { body = validateHqCreativeResolveInput(input); } catch { throw new MarketingError('INVALID'); }
    const r = await marketingCommand(`/api/v1/hq/marketing/creative/generations/${gid}/resolution`, SAAS_COMMANDS.resolveHqCreativeGeneration, body, key, signal,
      owned, validateHqCreativeGenerationReceipt);
    if (r.generation.generationId.toLowerCase() !== gid || r.generation.status !== (body.resolution === 'SUCCEEDED' ? 'RESOLVED_CHARGED' : 'RESOLVED_NOT_CHARGED'))
      throw new MarketingError('UNKNOWN');
    return r;
  },
};
export type CreativeApi = typeof creativeApi;
