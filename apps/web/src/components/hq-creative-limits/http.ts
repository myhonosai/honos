import { SAAS_COMMANDS, validateCreativeLimitsHqView, validateCreativeProviderDailyLimitInput, validateCreativeProviderDailyLimitReceipt,
  validateCreativeSchoolDailyCapsInput, validateCreativeSchoolDailyCapsReceipt,
  type CreativeLimitsHqView, type CreativeProviderDailyLimitInput, type CreativeProviderDailyLimitReceipt, type CreativeSchoolDailyCapsInput,
  type CreativeSchoolDailyCapsReceipt } from '@hon/contracts';
import { MarketingError, marketingCommand, marketingRead, type Owned } from '../hq-marketing/http';

/**
 * C1 (0354) HON's daily provider spend guard and the per-school daily caps, read and changed from HQ. Same transport as
 * every HQ command: same origin, no-store reads, the human-command marker and an Idempotency-Key. The database decides
 * authority (HQ billing staff read; only a human HQ owner changes) and every rule. Nothing here calls a provider.
 */
const BASE = '/api/v1/hq/creative/limits';

export const limitsApi = {
  read(signal: AbortSignal, owned: Owned): Promise<CreativeLimitsHqView> {
    return marketingRead(BASE, signal, owned, validateCreativeLimitsHqView);
  },
  /** The same key and body replay the saved answer; a stale version is refused as changed. */
  async setProvider(input: CreativeProviderDailyLimitInput, key: string, signal: AbortSignal, owned: Owned): Promise<CreativeProviderDailyLimitReceipt> {
    let body: CreativeProviderDailyLimitInput;
    try { body = validateCreativeProviderDailyLimitInput(input); } catch { throw new MarketingError('INVALID'); }
    const r = await marketingCommand(`${BASE}/providers`, SAAS_COMMANDS.creativeProviderDailyLimit, body, key, signal, owned, validateCreativeProviderDailyLimitReceipt);
    if (r.providerId !== body.providerId || r.dailyLimitMicros !== body.dailyLimitMicros) throw new MarketingError('UNKNOWN');
    return r;
  },
  async setSchool(input: CreativeSchoolDailyCapsInput, key: string, signal: AbortSignal, owned: Owned): Promise<CreativeSchoolDailyCapsReceipt> {
    let body: CreativeSchoolDailyCapsInput;
    try { body = validateCreativeSchoolDailyCapsInput(input); } catch { throw new MarketingError('INVALID'); }
    const r = await marketingCommand(`${BASE}/schools`, SAAS_COMMANDS.creativeSchoolDailyCaps, body, key, signal, owned, validateCreativeSchoolDailyCapsReceipt);
    if (r.schoolId.toLowerCase() !== body.schoolId.toLowerCase() || r.images !== body.images || r.videos !== body.videos || r.avatarVideos !== body.avatarVideos)
      throw new MarketingError('UNKNOWN');
    return r;
  },
};
export type LimitsApi = typeof limitsApi;
export type LimitsReceipt = CreativeProviderDailyLimitReceipt | CreativeSchoolDailyCapsReceipt;
