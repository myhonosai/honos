import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  validateSocialAdBudgetInput, validateSocialAdCancelInput, validateSocialAdDraftInput, validateSocialAdOperationInput, validateSocialAdResolveInput,
  verifySocialAd, verifySocialAdsView, type SocialAd, type SocialAdOperation, type SocialAdsView,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../../foundation/runtime-database.service.js';
import { SOCIAL_HUMAN_SETTINGS, SOCIAL_LIMITS, translateSocialError, type SchoolSocialContext, type SocialErrorTable } from './school-social.service.js';
import { SocialProviderError, ZERNIO_SOCIAL_ADAPTER, type ZernioSocialAdapter } from './zernio-social-adapter.js';

const AD_ERRORS: SocialErrorTable = {
  SOCIAL_FORBIDDEN: [['42501'], code => new ForbiddenException({ code, detail: 'Ads permission at this school is required.' })],
  SOCIAL_AD_NOT_FOUND: [['P0002'], code => new NotFoundException({ code })],
  SOCIAL_POST_NOT_FOUND: [['P0002'], code => new NotFoundException({ code })],
  SOCIAL_AD_POST_NOT_PUBLISHED: [['55000'], code => new ConflictException({ code, detail: 'Only a post HON already published on Facebook can be boosted.' })],
  SOCIAL_ADS_OFF: [['23514'], code => new ConflictException({ code, detail: 'Ads are turned off for this account. Turn them on in Social accounts first.' })],
  SOCIAL_AD_NO_BUDGET: [['23514'], code => new ConflictException({ code, detail: 'Set the school\'s monthly ad spend cap first.' })],
  SOCIAL_AD_OVER_CAP: [['23514'], code => new ConflictException({ code, detail: 'This would go over the school\'s monthly ad spend cap.' })],
  SOCIAL_AD_STATE: [['55000'], code => new ConflictException({ code, detail: 'This ad already moved on, or its dates have passed. Reload to see where it is.' })],
  SOCIAL_AD_CURRENCY_FIXED: [['55000'], code => new ConflictException({ code, detail: 'The currency cannot change once the school has ads.' })],
  SOCIAL_VERSION_CONFLICT: [['40001'], code => new ConflictException({ code, detail: 'Someone changed this. Reload and try again.' })],
};
function notEnabled(): never {
  throw new ServiceUnavailableException({ code: 'SOCIAL_ADS_NOT_ENABLED', detail: 'Ads from HON are not turned on yet. Nothing was created or spent.' });
}
function receipt(): never { throw new Error('Unverified social ad receipt.'); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Data = Record<string, unknown>;
interface AdSend {
  adId: string; leaseToken: string; operation: SocialAdOperation; providerAccountId: string; providerPostId: string; providerAdId: string | null;
  budgetCents: number; currency: string; startsOn: string; endsOn: string; timezone: string;
}

/**
 * School ads (0437). Every database call is one protected definer function that re-proves the direct human at the
 * session school. Creating, turning on and pausing are recorded first under a 60-second lease, Zernio is called once
 * between transactions with HON's ad id as idempotency key, and the answer is recorded under that lease. A lost answer
 * is UNKNOWN and never resent; a person settles it. Only turning an ad on spends money.
 */
@Injectable()
export class SchoolSocialAdsService {
  constructor(private readonly database: RuntimeDatabaseService, @Inject(ZERNIO_SOCIAL_ADAPTER) private readonly adapter: ZernioSocialAdapter) {}

  async read(context: SchoolSocialContext): Promise<SocialAdsView> {
    this.assertHuman(context, false);
    const data = await this.run(context, true, client => client.query<{ data: Data }>('SELECT hon.read_school_social_ads($1) AS data', [context.externalSubject]));
    return verifySocialAdsView({ ...data, adsEnabled: this.adapter.adsReady(), pauseEnabled: this.adapter.adsPauseReady() });
  }

  async budget(context: SchoolSocialContext, value: unknown): Promise<{ view: SocialAdsView; replayed: boolean }> {
    this.assertHuman(context, true);
    const input = this.validate(validateSocialAdBudgetInput, value);
    const { record, replayed } = this.command(await this.run(context, false, client => client.query<{ data: Data }>(
      'SELECT hon.set_school_social_ad_budget($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId])));
    return { view: verifySocialAdsView({ ...(record as Data), adsEnabled: this.adapter.adsReady(), pauseEnabled: this.adapter.adsPauseReady() }), replayed };
  }

  async create(context: SchoolSocialContext, value: unknown): Promise<{ ad: SocialAd; replayed: boolean }> {
    this.assertHuman(context, true);
    const input = this.validate(validateSocialAdDraftInput, value);
    const { record, replayed } = this.command(await this.run(context, false, client => client.query<{ data: Data }>(
      'SELECT hon.create_school_social_ad($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId])));
    const ad = verifySocialAd(record);
    if (ad.targetId !== input.targetId) receipt();
    return { ad, replayed };
  }

  async cancel(context: SchoolSocialContext, adId: string, value: unknown): Promise<{ ad: SocialAd; replayed: boolean }> {
    this.assertHuman(context, true);
    const input = this.validate(validateSocialAdCancelInput, value);
    return this.simple(context, 'SELECT hon.cancel_school_social_ad($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data', adId, input);
  }

  async resolve(context: SchoolSocialContext, adId: string, value: unknown): Promise<{ ad: SocialAd; replayed: boolean }> {
    this.assertHuman(context, true);
    const input = this.validate(validateSocialAdResolveInput, value);
    return this.simple(context, 'SELECT hon.resolve_school_social_ad($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data', adId, input);
  }

  /** CREATE (approve: created PAUSED), ACTIVATE (spends) or PAUSE, each sent to Zernio at most once. */
  async operation(context: SchoolSocialContext, adId: string, value: unknown): Promise<{ ad: SocialAd; replayed: boolean }> {
    this.assertHuman(context, true);
    const input = this.validate(validateSocialAdOperationInput, value);
    // Pausing only lowers spend: it never needs the ads approval, so an ad running at Meta can be paused after the switch goes off.
    if (!(input.operation === 'PAUSE' ? this.adapter.adsPauseReady() : this.adapter.adsReady())) notEnabled();
    const started = await this.run(context, false, client => client.query<{ data: Data }>(
      'SELECT hon.start_school_social_ad_operation($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data', this.args(context, adId, input)));
    const { record, replayed } = this.command(started, true);
    const ad = verifySocialAd(record);
    if (ad.adId !== adId.toLowerCase()) receipt();
    if (replayed) return { ad, replayed };
    const send = this.adSend(started.send, ad, input.operation);
    let outcome: 'DONE' | 'FAILED' | 'UNKNOWN', providerAdId: string | null = null;
    try {
      if (send.operation === 'CREATE') {
        ({ providerAdId } = await this.adapter.createBoost({ providerAccountId: send.providerAccountId, providerPostId: send.providerPostId, budgetCents: send.budgetCents,
          currency: send.currency, startsOn: send.startsOn, endsOn: send.endsOn, timezone: send.timezone, idempotencyKey: send.adId }));
      } else {
        await this.adapter.setAdActive({ providerAdId: send.providerAdId!, active: send.operation === 'ACTIVATE', idempotencyKey: `${send.adId}:${send.leaseToken}` });
      }
      outcome = 'DONE';
    } catch (error) {
      outcome = error instanceof SocialProviderError && ['REJECTED', 'RATE_LIMITED', 'NOT_ENABLED'].includes(error.failure) ? 'FAILED' : 'UNKNOWN';
    }
    let data: Data;
    try {
      data = await this.run(context, false, client => client.query<{ data: Data }>(
        'SELECT hon.record_school_social_ad_result($1,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::uuid) AS data',
        [context.externalSubject, send.adId, send.leaseToken, outcome, outcome === 'DONE' && send.operation === 'CREATE' ? providerAdId : null, context.requestId, context.correlationId]));
    } catch {
      // Meta may have acted; HON does not know, so the ad reads UNKNOWN (the lease runs out) and nothing is resent.
      return { ad: { ...ad, status: 'UNKNOWN' }, replayed: false };
    }
    if (Object.keys(data).sort().join(',') !== 'accepted,ad' || typeof data.accepted !== 'boolean') receipt();
    const final = verifySocialAd(data.ad);
    if (final.adId !== ad.adId) receipt();
    return { ad: final, replayed: false };
  }

  private async simple(context: SchoolSocialContext, sql: string, adId: string, input: object): Promise<{ ad: SocialAd; replayed: boolean }> {
    const { record, replayed } = this.command(await this.run(context, false, client => client.query<{ data: Data }>(sql, this.args(context, adId, input))));
    const ad = verifySocialAd(record);
    if (ad.adId !== adId.toLowerCase()) receipt();
    return { ad, replayed };
  }

  private adSend(value: unknown, ad: SocialAd, operation: SocialAdOperation): AdSend {
    const s = value as AdSend | undefined;
    if (!s || typeof s !== 'object' || Object.keys(s).sort().join(',') !== 'adId,budgetCents,currency,endsOn,leaseToken,operation,providerAccountId,providerAdId,providerPostId,startsOn,timezone'
      || !UUID.test(s.adId) || s.adId.toLowerCase() !== ad.adId || !UUID.test(s.leaseToken) || s.operation !== operation
      || s.budgetCents !== ad.budgetCents || s.currency !== ad.currency || s.startsOn !== ad.startsOn || s.endsOn !== ad.endsOn
      || typeof s.providerAccountId !== 'string' || typeof s.providerPostId !== 'string' || typeof s.timezone !== 'string'
      || (operation === 'CREATE') !== (s.providerAdId === null) || (s.providerAdId !== null && typeof s.providerAdId !== 'string')) receipt();
    return s;
  }

  private validate<T>(validator: (value: unknown) => T, value: unknown): T {
    try { return validator(value); } catch { throw new BadRequestException({ code: 'SOCIAL_INVALID' }); }
  }

  private args(context: SchoolSocialContext, id: string, input: object): unknown[] {
    return [context.externalSubject, id, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId];
  }

  private command(data: Data, sends = false): { record: unknown; replayed: boolean } {
    if (typeof data.replayed !== 'boolean') receipt();
    if (Object.keys(data).sort().join(',') !== (sends && !data.replayed ? 'record,replayed,send' : 'record,replayed')) receipt();
    return { record: data.record, replayed: data.replayed };
  }

  private async run(context: SchoolSocialContext, readOnly: boolean, call: (client: PoolClient) => Promise<{ rows: { data: Data }[] }>): Promise<Data> {
    try {
      const body = async (client: PoolClient) => {
        await client.query(SOCIAL_LIMITS); await client.query(SOCIAL_HUMAN_SETTINGS, [context.externalSubject]);
        const r = await call(client);
        if (r.rows.length !== 1 || !r.rows[0]?.data || typeof r.rows[0].data !== 'object') receipt();
        return r.rows[0].data;
      };
      return readOnly ? await this.database.withTenantReadOnlyTransaction(context, body) : await this.database.withTenantTransaction(context, body);
    } catch (error) { return translateSocialError(error, AD_ERRORS); }
  }

  private assertHuman(context: SchoolSocialContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || !context.externalSubject
      || (command ? !context.idempotencyKey || context.idempotencyKey.length > 200 : context.idempotencyKey !== '')) throw new ForbiddenException({ code: 'SOCIAL_FORBIDDEN' });
  }
}
